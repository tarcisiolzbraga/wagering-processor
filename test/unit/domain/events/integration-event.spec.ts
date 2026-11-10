import { describe, expect, it } from "bun:test";

import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../../../src/domain/events/wager-transaction-events";
import { Money } from "../../../../src/domain/money/money";
import { FailureCode } from "../../../../src/domain/shared/failure-code";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction";
import { Wallet } from "../../../../src/domain/wallet/wallet";
import {
  WagerTransactionKind as Kind,
  WagerTransactionSource as Source,
} from "../../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransaction } from "../../../../src/domain/wagering/wager-transaction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-10T10:00:00.000Z");

const ctx = { eventId: "event-1", correlationId: "corr-1", occurredAt: at };

function transacao(kind: Kind = Kind.Bet): WagerTransaction {
  return WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    payloadHash: "hash-abc",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind,
    money: brl("25.00"),
    source: kind === Kind.Opening ? Source.Internal : Source.Api,
    ...(kind === Kind.Refund || kind === Kind.Rollback
      ? { referenceExternalTransactionId: "transaction-100" }
      : {}),
    createdAt: at,
  });
}

describe("IntegrationEvent — envelope", () => {
  it("eventType e version vivem no tipo, nao em string solta", () => {
    const evento = WagerTransactionProcessed.from(transacao(), ctx);
    expect(evento.eventType).toBe("WagerTransactionProcessed");
    expect(evento.version).toBe(1);
  });

  it("toJSON serializa occurredAt em ISO-8601 e carrega o envelope completo", () => {
    const tx = transacao();
    tx.markProcessed({ observedBalance: brl("75.00"), at });
    const json = WagerTransactionProcessed.from(tx, {
      ...ctx,
      causationId: "msg-123",
    }).toJSON();

    expect(json.eventId).toBe("event-1");
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.aggregateId).toBe("tx-1");
    expect(json.correlationId).toBe("corr-1");
    expect(json.causationId).toBe("msg-123");
    expect(json.occurredAt).toBe("2026-11-10T10:00:00.000Z");
    expect(json.version).toBe(1);
  });

  it("causationId e opcional", () => {
    expect(WagerTransactionProcessed.from(transacao(), ctx).toJSON().causationId).toBeUndefined();
  });

  it("o envelope sobrevive a um round-trip de JSON — e payload de outbox", () => {
    const json = WagerTransactionProcessed.from(transacao(), ctx).toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(JSON.parse(JSON.stringify(json)));
    expect(typeof JSON.stringify(json)).toBe("string");
  });
});

describe("IntegrationEvent — dinheiro no payload", () => {
  it("data carrega MoneyProps com string decimal, nunca instancia de Money", () => {
    const evento = WagerTransactionProcessed.from(transacao(), ctx);
    expect(evento.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(evento.data.money).not.toBeInstanceOf(Money);
    expect(typeof evento.data.money.amount).toBe("string");
  });

  it("nenhum valor monetario do envelope vira number ao serializar", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-opening",
      now: at,
    }).wallet;
    const entry = wallet.debit({
      entryId: "entry-1",
      transactionId: "tx-1",
      money: brl("25.00"),
      at,
    });
    const json = JSON.parse(
      JSON.stringify(WalletBalanceChanged.from(wallet, entry, ctx).toJSON()),
    ) as { data: Record<string, { amount: unknown }> };

    for (const campo of ["money", "balanceBefore", "balanceAfter"]) {
      expect(typeof json.data[campo]?.amount).toBe("string");
    }
  });
});

describe("WalletBalanceChanged", () => {
  it("mapeia o lancamento e a version da wallet", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-opening",
      now: at,
    }).wallet;
    const entry = wallet.debit({
      entryId: "entry-1",
      transactionId: "tx-1",
      money: brl("25.00"),
      at,
    });
    const { data } = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(data.walletId).toBe("wallet-1");
    expect(data.transactionId).toBe("tx-1");
    expect(data.direction).toBe(LedgerDirection.Debit);
    expect(data.balanceBefore.amount).toBe("100.00");
    expect(data.balanceAfter.amount).toBe("75.00");
    expect(data.walletVersion).toBe(2);
  });
});

describe("WagerTransactionProcessed", () => {
  it("LOSS e aplicada mas marcada como sem efeito no saldo", () => {
    const tx = transacao(Kind.Loss);
    tx.markProcessed({ observedBalance: brl("100.00"), at });
    const { data } = WagerTransactionProcessed.from(tx, ctx);

    expect(data.kind).toBe(Kind.Loss);
    expect(data.affectedBalance).toBe(false);
  });

  it("BET e marcada como tendo afetado o saldo", () => {
    const tx = transacao(Kind.Bet);
    tx.markProcessed({ observedBalance: brl("75.00"), at });
    expect(WagerTransactionProcessed.from(tx, ctx).data.affectedBalance).toBe(true);
  });

  it("carrega o id interno da referencia quando houver", () => {
    const tx = transacao(Kind.Refund);
    tx.markProcessed({ referenceTransactionId: "tx-ref", observedBalance: brl("1.00"), at });
    expect(WagerTransactionProcessed.from(tx, ctx).data.referenceTransactionId).toBe("tx-ref");
  });
});

describe("WagerTransactionRejected", () => {
  it("carrega o failureCode que o provedor usa para decidir", () => {
    const tx = transacao();
    tx.reject({ code: FailureCode.InsufficientFunds, observedBalance: brl("20.00"), at });
    const { data } = WagerTransactionRejected.from(tx, ctx);

    expect(data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(data.transactionId).toBe("tx-1");
    expect(data.rejectedAt).toBe("2026-11-10T10:00:00.000Z");
  });
});

describe("WagerTransactionRejected — codigo vem da transacao", () => {
  it("recusa montar evento de transacao que nao foi rejeitada", () => {
    const tx = transacao();
    expect(() => WagerTransactionRejected.from(tx, ctx)).toThrow(/nao foi rejeitada/);
  });
});

describe("partitionKey — MessageGroupId do FIFO e a walletId", () => {
  it("todos os eventos particionam pela wallet", () => {
    const tx = transacao();
    tx.markProcessed({ observedBalance: brl("1.00"), at });
    expect(WagerTransactionProcessed.from(tx, ctx).partitionKey).toBe("wallet-1");

    const rejeitada = transacao();
    rejeitada.reject({ code: FailureCode.InsufficientFunds, at });
    expect(WagerTransactionRejected.from(rejeitada, ctx).partitionKey).toBe("wallet-1");

    const pendente = transacao(Kind.Rollback);
    pendente.markPendingReference(at);
    expect(WagerTransactionPendingReference.from(pendente, ctx).partitionKey).toBe("wallet-1");

    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-opening",
      now: at,
    }).wallet;
    const entry = wallet.debit({
      entryId: "entry-1",
      transactionId: "tx-1",
      money: brl("25.00"),
      at,
    });
    expect(WalletBalanceChanged.from(wallet, entry, ctx).partitionKey).toBe("wallet-1");
  });
});

describe("WagerTransactionPendingReference", () => {
  it("carrega a referencia que esta faltando", () => {
    const tx = transacao(Kind.Rollback);
    tx.markPendingReference(at);
    const { data } = WagerTransactionPendingReference.from(tx, ctx);

    expect(data.referenceExternalTransactionId).toBe("transaction-100");
    expect(data.kind).toBe(Kind.Rollback);
  });

  it("pendingSince ancora na primeira marcacao, nao na ultima tentativa", () => {
    const tx = transacao(Kind.Rollback);
    tx.markPendingReference(at);
    const depois = new Date(at.getTime() + 3_600_000);
    tx.markPendingReference(depois);

    const { data } = WagerTransactionPendingReference.from(tx, {
      ...ctx,
      occurredAt: depois,
    });
    expect(data.pendingSince).toBe(at.toISOString());
  });
});
