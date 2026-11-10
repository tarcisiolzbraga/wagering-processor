import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { InsertTransactionOutcome } from "../../src/application/ports/repositories";
import type { TransactionalContext } from "../../src/application/ports/unit-of-work";
import { Money } from "../../src/domain/money/money";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction";
import { Wallet } from "../../src/domain/wallet/wallet";
import {
  WagerTransactionKind as Kind,
  WagerTransactionSource as Source,
} from "../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../src/domain/wagering/wager-transaction-status";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { WalletBalanceChanged } from "../../src/domain/events/wager-transaction-events";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { openOrmWithFreshSchema } from "../support/database";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";

let orm: MikroORM;
let uow: MikroUnitOfWork;

const uuid = (): string => crypto.randomUUID();
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

/** Abre uma carteira com saldo, com a transacao OPENING e o lancamento. */
async function abrirCarteira(saldo = "1000.00"): Promise<{ walletId: string; playerId: string }> {
  const walletId = uuid();
  const playerId = uuid();
  const now = new Date();

  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(saldo),
    openingTransactionId: uuid(),
    openingEntryId: uuid(),
    now,
  });

  await uow.run(async (ctx) => {
    await ctx.wallets.insert(wallet);
    if (openingEntry) {
      const abertura = WagerTransaction.create({
        id: openingEntry.transactionId,
        providerId: "internal",
        externalTransactionId: `opening-${walletId}`,
        idempotencyKey: `internal:opening-${walletId}`,
        payloadHash: "opening",
        walletId,
        playerId,
        roundId: "opening",
        gameId: "opening",
        kind: Kind.Opening,
        money: brl(saldo),
        source: Source.Internal,
        createdAt: now,
      });
      abertura.markProcessed({ observedBalance: wallet.balance, at: now });
      await ctx.transactions.insertIfAbsent(abertura);
      await ctx.ledger.insert(openingEntry);
    }
  });

  return { walletId, playerId };
}

function aposta(
  walletId: string,
  playerId: string,
  over: { amount?: string; externalId?: string; kind?: Kind } = {},
): WagerTransaction {
  const externalId = over.externalId ?? `external-${uuid()}`;
  return WagerTransaction.create({
    id: uuid(),
    providerId: "provider-a",
    externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`,
    payloadHash: "hash-abc",
    walletId,
    playerId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: over.kind ?? Kind.Bet,
    money: brl(over.amount ?? "25.00"),
    source: Source.Api,
    createdAt: new Date(),
  });
}

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  uow = new MikroUnitOfWork(orm);
});

afterAll(async () => {
  if (orm) await orm.close(true);
});

describe("MoneyAmountType — dinheiro atravessa o banco exato", () => {
  const valores = ["0.01", "25.00", "749.50", "0.00", "999999999999999999.99"];

  for (const valor of valores) {
    it(`preserva ${valor} sem perder centavo`, async () => {
      const { walletId } = await abrirCarteira(valor === "0.00" ? "0" : valor);
      const wallet = await uow.read((ctx) => ctx.wallets.findById(walletId));
      expect(wallet?.balance.toJSON()).toEqual({
        amount: valor === "0.00" ? "0.00" : valor,
        currency: "BRL",
      });
    });
  }

  it("devolve string, nunca number", async () => {
    const { walletId } = await abrirCarteira("123.45");
    const linhas = await orm.em
      .getConnection()
      .execute<Array<{ balance_amount: unknown }>>(
        "select balance_amount from wallets where id = ?",
        [walletId],
      );
    expect(typeof linhas[0]?.balance_amount).toBe("string");
  });
});

describe("WalletRepository", () => {
  it("round-trip preserva identidade, moeda e version", async () => {
    const { walletId, playerId } = await abrirCarteira("500.00");
    const wallet = await uow.read((ctx) => ctx.wallets.findById(walletId));

    expect(wallet?.id).toBe(walletId);
    expect(wallet?.playerId).toBe(playerId);
    expect(wallet?.currency).toBe("BRL");
    expect(wallet?.version).toBe(1);
  });

  it("encontra por player e moeda", async () => {
    const { walletId, playerId } = await abrirCarteira();
    const wallet = await uow.read((ctx) => ctx.wallets.findByPlayerAndCurrency(playerId, "BRL"));
    expect(wallet?.id).toBe(walletId);
  });

  it("findByIdForUpdate devolve o agregado com a linha travada", async () => {
    const { walletId } = await abrirCarteira();
    const wallet = await uow.run((ctx) => ctx.wallets.findByIdForUpdate(walletId));
    expect(wallet?.id).toBe(walletId);
  });

  it("devolve undefined para carteira inexistente", async () => {
    expect(await uow.read((ctx) => ctx.wallets.findById(uuid()))).toBeUndefined();
  });

  it("updateBalance aplica quando a version casa", async () => {
    const { walletId, playerId } = await abrirCarteira("100.00");

    const aplicado = await uow.run(async (ctx) => {
      const wallet = await ctx.wallets.findByIdForUpdate(walletId);
      const tx = aposta(walletId, playerId);
      tx.markProcessed({ observedBalance: brl("75.00"), at: new Date() });
      await ctx.transactions.insertIfAbsent(tx);

      const versaoAntes = wallet!.version;
      const entry = wallet!.debit({
        entryId: uuid(),
        transactionId: tx.id,
        money: brl("25.00"),
        at: new Date(),
      });
      await ctx.ledger.insert(entry);
      return ctx.wallets.updateBalance(wallet!, versaoAntes);
    });

    expect(aplicado).toBe(true);
    const depois = await uow.read((ctx) => ctx.wallets.findById(walletId));
    expect(depois?.balance.toJSON().amount).toBe("75.00");
    expect(depois?.version).toBe(2);
  });

  it("updateBalance recusa quando a version esta obsoleta", async () => {
    const { walletId } = await abrirCarteira("100.00");

    const aplicado = await uow.run(async (ctx) => {
      const wallet = await ctx.wallets.findByIdForUpdate(walletId);
      // Finge que o caller leu a carteira numa version que nao e mais a atual.
      return ctx.wallets.updateBalance(wallet!, 99);
    });

    expect(aplicado).toBe(false);
    const depois = await uow.read((ctx) => ctx.wallets.findById(walletId));
    expect(depois?.balance.toJSON().amount).toBe("100.00");
    expect(depois?.version).toBe(1);
  });
});

describe("WagerTransactionRepository — insert-first", () => {
  it("primeira insercao entra, segunda com a mesma key e detectada", async () => {
    const { walletId, playerId } = await abrirCarteira();
    const tx = aposta(walletId, playerId);

    expect(await uow.run((ctx) => ctx.transactions.insertIfAbsent(tx))).toBe(
      InsertTransactionOutcome.Inserted,
    );
    expect(await uow.run((ctx) => ctx.transactions.insertIfAbsent(tx))).toBe(
      InsertTransactionOutcome.IdempotencyKeyExists,
    );
  });

  it("mesma operacao com outra idempotency key e conflito, nao erro de infra", async () => {
    // Sem tratamento, a violacao de (provider, external id) estouraria 23505
    // cru: 500 na API e retry infinito no consumer, de algo que nunca vai dar
    // certo porque e bug do provedor.
    const { walletId, playerId } = await abrirCarteira();
    const externalId = `external-${uuid()}`;
    const primeira = aposta(walletId, playerId, { externalId });
    await uow.run((ctx) => ctx.transactions.insertIfAbsent(primeira));

    const segunda = WagerTransaction.create({
      id: uuid(),
      providerId: "provider-a",
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:outra-chave-${uuid()}`,
      payloadHash: "hash-abc",
      walletId,
      playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: Kind.Bet,
      money: brl("25.00"),
      source: Source.Api,
      createdAt: new Date(),
    });

    expect(await uow.run((ctx) => ctx.transactions.insertIfAbsent(segunda))).toBe(
      InsertTransactionOutcome.ExternalTransactionExists,
    );
  });

  it("round-trip preserva kind, source, status e dinheiro", async () => {
    const { walletId, playerId } = await abrirCarteira();
    const tx = aposta(walletId, playerId, { amount: "33.33" });
    await uow.run((ctx) => ctx.transactions.insertIfAbsent(tx));

    const lida = await uow.read((ctx) => ctx.transactions.findById(tx.id));
    expect(lida?.kind).toBe(Kind.Bet);
    expect(lida?.source).toBe(Source.Api);
    expect(lida?.status).toBe(Status.Pending);
    expect(lida?.money.toJSON()).toEqual({ amount: "33.33", currency: "BRL" });
    expect(lida?.payloadHash).toBe("hash-abc");
    expect(lida?.referenceAttempts).toBe(0);
  });

  it("encontra por idempotency key e por (provider, external id)", async () => {
    const { walletId, playerId } = await abrirCarteira();
    const tx = aposta(walletId, playerId);
    await uow.run((ctx) => ctx.transactions.insertIfAbsent(tx));

    const porKey = await uow.read((ctx) =>
      ctx.transactions.findByIdempotencyKey(tx.idempotencyKey),
    );
    const porExterno = await uow.read((ctx) =>
      ctx.transactions.findByProviderAndExternalId("provider-a", tx.externalTransactionId),
    );
    expect(porKey?.id).toBe(tx.id);
    expect(porExterno?.id).toBe(tx.id);
  });

  it("update grava status, failureCode e saldo observado", async () => {
    const { walletId, playerId } = await abrirCarteira();
    const tx = aposta(walletId, playerId);
    await uow.run((ctx) => ctx.transactions.insertIfAbsent(tx));

    tx.reject({ code: FailureCode.InsufficientFunds, observedBalance: brl("20.00"), at: new Date() });
    await uow.run((ctx) => ctx.transactions.update(tx));

    const lida = await uow.read((ctx) => ctx.transactions.findById(tx.id));
    expect(lida?.status).toBe(Status.Rejected);
    expect(lida?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(lida?.observedBalance?.toJSON().amount).toBe("20.00");
    expect(lida?.isTerminal()).toBe(true);
  });

  it("update preserva as colunas de identidade, que sao imutaveis no banco", async () => {
    const { walletId, playerId } = await abrirCarteira();
    const tx = aposta(walletId, playerId, { amount: "40.00" });
    await uow.run((ctx) => ctx.transactions.insertIfAbsent(tx));

    tx.markPendingReference(new Date());
    await uow.run((ctx) => ctx.transactions.update(tx));

    const lida = await uow.read((ctx) => ctx.transactions.findById(tx.id));
    expect(lida?.money.toJSON().amount).toBe("40.00");
    expect(lida?.idempotencyKey).toBe(tx.idempotencyKey);
    expect(lida?.status).toBe(Status.PendingReference);
    expect(lida?.referenceAttempts).toBe(1);
    expect(lida?.pendingReferenceSince).toBeDefined();
  });

  it("findAwaitingReference devolve as mais antigas primeiro", async () => {
    const { walletId, playerId } = await abrirCarteira();
    const criadas: string[] = [];

    for (const minutos of [30, 10, 20]) {
      const tx = aposta(walletId, playerId, { kind: Kind.Bet });
      await uow.run((ctx) => ctx.transactions.insertIfAbsent(tx));
      tx.markPendingReference(new Date(Date.now() - minutos * 60_000));
      await uow.run((ctx) => ctx.transactions.update(tx));
      criadas.push(tx.id);
    }

    const fila = await uow.read((ctx) => ctx.transactions.findAwaitingReference(50));
    const posicoes = criadas.map((id) => fila.findIndex((t) => t.id === id));
    // 30 min atras vem antes de 20, que vem antes de 10.
    expect(posicoes[0]).toBeLessThan(posicoes[2]!);
    expect(posicoes[2]).toBeLessThan(posicoes[1]!);
  });
});

describe("WalletLedgerRepository", () => {
  async function comLancamentos(
    quantos: number,
  ): Promise<{ walletId: string; playerId: string }> {
    const { walletId, playerId } = await abrirCarteira("1000.00");

    for (let i = 0; i < quantos; i += 1) {
      await uow.run(async (ctx) => {
        const wallet = await ctx.wallets.findByIdForUpdate(walletId);
        const tx = aposta(walletId, playerId, { amount: "10.00" });
        const versaoAntes = wallet!.version;
        const entry = wallet!.debit({
          entryId: uuid(),
          transactionId: tx.id,
          money: brl("10.00"),
          at: new Date(Date.now() + i),
        });
        tx.markProcessed({ observedBalance: wallet!.balance, at: new Date() });
        await ctx.transactions.insertIfAbsent(tx);
        await ctx.ledger.insert(entry);
        await ctx.wallets.updateBalance(wallet!, versaoAntes);
      });
    }
    return { walletId, playerId };
  }

  it("reconstroi o saldo somando o ledger", async () => {
    const { walletId } = await comLancamentos(3);
    const [saldo, reconstruido] = await uow.read(async (ctx) => [
      (await ctx.wallets.findById(walletId))!.balance,
      await ctx.ledger.reconstructBalance(walletId, "BRL"),
    ]);

    expect(saldo.toJSON().amount).toBe("970.00");
    expect(reconstruido.equals(saldo)).toBe(true);
  });

  it("conta os lancamentos", async () => {
    const { walletId } = await comLancamentos(3);
    // 1 da abertura + 3 apostas
    expect(await uow.read((ctx) => ctx.ledger.countEntries(walletId))).toBe(4);
  });

  it("pagina por cursor sem pular nem repetir linha", async () => {
    const { walletId } = await comLancamentos(5);

    const vistos: string[] = [];
    let cursor: string | undefined;
    let paginas = 0;

    do {
      const pagina = await uow.read((ctx) => ctx.ledger.page(walletId, cursor, 2));
      vistos.push(...pagina.entries.map((e) => e.id));
      cursor = pagina.nextCursor;
      paginas += 1;
    } while (cursor !== undefined && paginas < 10);

    expect(vistos).toHaveLength(6); // abertura + 5
    expect(new Set(vistos).size).toBe(6); // nenhuma repetida
  });

  it("recusa limite de pagina invalido em vez de devolver pagina vazia", async () => {
    const { walletId } = await comLancamentos(1);
    for (const limite of [0, -1, 1.5, 201]) {
      await expect(uow.read((ctx) => ctx.ledger.page(walletId, undefined, limite))).rejects.toThrow(
        /limite de pagina invalido/,
      );
    }
  });

  it("o cursor e opaco e estavel", async () => {
    const { walletId } = await comLancamentos(3);
    const primeira = await uow.read((ctx) => ctx.ledger.page(walletId, undefined, 2));
    expect(primeira.nextCursor).toBeTypeOf("string");
    expect(primeira.nextCursor).not.toContain(walletId);

    // Reusar o mesmo cursor devolve a mesma pagina.
    const a = await uow.read((ctx) => ctx.ledger.page(walletId, primeira.nextCursor, 2));
    const b = await uow.read((ctx) => ctx.ledger.page(walletId, primeira.nextCursor, 2));
    expect(a.entries.map((e) => e.id)).toEqual(b.entries.map((e) => e.id));
  });

  it("round-trip do lancamento preserva direction e os tres valores", async () => {
    const { walletId } = await comLancamentos(1);
    const pagina = await uow.read((ctx) => ctx.ledger.page(walletId, undefined, 10));
    const debito = pagina.entries.find((e) => e.direction === LedgerDirection.Debit);

    expect(debito).toBeDefined();
    expect(debito?.money.toJSON().amount).toBe("10.00");
    expect(debito?.balanceBefore.toJSON().amount).toBe("1000.00");
    expect(debito?.balanceAfter.toJSON().amount).toBe("990.00");
    expect(debito?.isBalanced()).toBe(true);
  });
});

describe("InboxRepository", () => {
  it("dedup persistente por (consumer, messageId)", async () => {
    const message = InboxMessage.receive({
      messageId: `msg-${uuid()}`,
      consumerName: "wager-transactions",
      payloadHash: "hash-abc",
      receivedAt: new Date(),
    });

    expect(await uow.run((ctx) => ctx.inbox.receiveIfAbsent(message))).toBe(true);
    expect(await uow.run((ctx) => ctx.inbox.receiveIfAbsent(message))).toBe(false);
  });

  it("marca como processada e reidrata o estado", async () => {
    const message = InboxMessage.receive({
      messageId: `msg-${uuid()}`,
      consumerName: "wager-transactions",
      payloadHash: "hash-abc",
      receivedAt: new Date(),
    });
    await uow.run((ctx) => ctx.inbox.receiveIfAbsent(message));

    message.markProcessed(new Date());
    await uow.run((ctx) => ctx.inbox.markProcessed(message));

    const lida = await uow.read((ctx) =>
      ctx.inbox.find(message.consumerName, message.messageId),
    );
    expect(lida?.isProcessed()).toBe(true);
  });
});

describe("OutboxRepository", () => {
  async function eventoPendente(): Promise<OutboxMessage> {
    const { walletId, playerId } = await abrirCarteira();
    const tx = aposta(walletId, playerId);
    const wallet = (await uow.read((ctx) => ctx.wallets.findById(walletId)))!;
    const entry = wallet.debit({
      entryId: uuid(),
      transactionId: tx.id,
      money: brl("25.00"),
      at: new Date(),
    });
    return OutboxMessage.enqueue(
      WalletBalanceChanged.from(wallet, entry, {
        eventId: uuid(),
        correlationId: uuid(),
        occurredAt: new Date(),
      }),
    );
  }

  it("grava e reivindica com SKIP LOCKED", async () => {
    const message = await eventoPendente();
    await uow.run((ctx) => ctx.outbox.enqueue([message]));

    const reivindicadas = await uow.run((ctx) => ctx.outbox.claimDue(50, new Date()));
    expect(reivindicadas.map((m) => m.id)).toContain(message.id);
  });

  it("preserva o envelope e a partition key", async () => {
    const message = await eventoPendente();
    await uow.run((ctx) => ctx.outbox.enqueue([message]));

    const lidas = await uow.run((ctx) => ctx.outbox.claimDue(100, new Date()));
    const lida = lidas.find((m) => m.id === message.id);

    expect(lida?.eventType).toBe("WalletBalanceChanged");
    expect(lida?.partitionKey).toBe(message.partitionKey);
    expect((lida?.payload as Record<string, unknown>)["eventType"]).toBe("WalletBalanceChanged");
  });

  it("publicada sai da fila de reivindicacao", async () => {
    const message = await eventoPendente();
    await uow.run((ctx) => ctx.outbox.enqueue([message]));

    message.markPublished(new Date());
    await uow.run((ctx) => ctx.outbox.markPublished(message));

    const reivindicadas = await uow.run((ctx) => ctx.outbox.claimDue(100, new Date()));
    expect(reivindicadas.map((m) => m.id)).not.toContain(message.id);
  });

  it("retry agendado no futuro nao e reivindicada ainda", async () => {
    const message = await eventoPendente();
    await uow.run((ctx) => ctx.outbox.enqueue([message]));

    const agora = new Date();
    message.scheduleRetry(agora);
    await uow.run((ctx) => ctx.outbox.scheduleRetry(message));

    const antes = await uow.run((ctx) => ctx.outbox.claimDue(100, agora));
    expect(antes.map((m) => m.id)).not.toContain(message.id);

    const depois = await uow.run((ctx) =>
      ctx.outbox.claimDue(100, new Date(agora.getTime() + 2_000)),
    );
    expect(depois.map((m) => m.id)).toContain(message.id);
    expect(depois.find((m) => m.id === message.id)?.attempts).toBe(1);
  });

  it("conta pendentes e mede o lag da mais antiga", async () => {
    const message = await eventoPendente();
    await uow.run((ctx) => ctx.outbox.enqueue([message]));

    expect(await uow.read((ctx) => ctx.outbox.pendingCount())).toBeGreaterThan(0);
    const lag = await uow.read((ctx) =>
      ctx.outbox.oldestPendingAgeMs(new Date(Date.now() + 60_000)),
    );
    expect(lag).toBeGreaterThanOrEqual(60_000);
  });
});

describe("UnitOfWork — atomicidade", () => {
  it("erro no meio do trabalho nao deixa nada persistido", async () => {
    const walletId = uuid();
    const playerId = uuid();
    const { wallet } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.zero("BRL"),
    });

    await expect(
      uow.run(async (ctx) => {
        await ctx.wallets.insert(wallet);
        throw new Error("falha proposital depois da escrita");
      }),
    ).rejects.toThrow("falha proposital");

    expect(await uow.read((ctx) => ctx.wallets.findById(walletId))).toBeUndefined();
  });

  it("inbox, transacao, ledger e saldo commitam juntos ou nao commitam", async () => {
    const { walletId, playerId } = await abrirCarteira("100.00");
    const messageId = `msg-${uuid()}`;
    const tx = aposta(walletId, playerId);

    await expect(
      uow.run(async (ctx) => {
        await ctx.inbox.receiveIfAbsent(
          InboxMessage.receive({
            messageId,
            consumerName: "wager-transactions",
            payloadHash: "hash-abc",
            receivedAt: new Date(),
          }),
        );
        const wallet = await ctx.wallets.findByIdForUpdate(walletId);
        const versaoAntes = wallet!.version;
        const entry = wallet!.debit({
          entryId: uuid(),
          transactionId: tx.id,
          money: brl("25.00"),
          at: new Date(),
        });
        tx.markProcessed({ observedBalance: wallet!.balance, at: new Date() });
        await ctx.transactions.insertIfAbsent(tx);
        await ctx.ledger.insert(entry);
        await ctx.wallets.updateBalance(wallet!, versaoAntes);
        throw new Error("morreu antes do commit");
      }),
    ).rejects.toThrow("morreu antes do commit");

    const estado = await uow.read(async (ctx: TransactionalContext) => ({
      inbox: await ctx.inbox.find("wager-transactions", messageId),
      transacao: await ctx.transactions.findById(tx.id),
      saldo: (await ctx.wallets.findById(walletId))!.balance.toJSON().amount,
      lancamentos: await ctx.ledger.countEntries(walletId),
    }));

    expect(estado.inbox).toBeUndefined();
    expect(estado.transacao).toBeUndefined();
    expect(estado.saldo).toBe("100.00");
    expect(estado.lancamentos).toBe(1); // so o da abertura
  });
});

describe("invariante final", () => {
  it("wallet.balance e sempre o saldo reconstruido pelo ledger", async () => {
    const { walletId, playerId } = await abrirCarteira("500.00");

    for (const valor of ["10.00", "20.50", "0.01"]) {
      await uow.run(async (ctx) => {
        const wallet = await ctx.wallets.findByIdForUpdate(walletId);
        const tx = aposta(walletId, playerId, { amount: valor });
        const versaoAntes = wallet!.version;
        const entry = wallet!.debit({
          entryId: uuid(),
          transactionId: tx.id,
          money: brl(valor),
          at: new Date(),
        });
        tx.markProcessed({ observedBalance: wallet!.balance, at: new Date() });
        await ctx.transactions.insertIfAbsent(tx);
        await ctx.ledger.insert(entry);
        await ctx.wallets.updateBalance(wallet!, versaoAntes);
      });
    }

    const { saldo, reconstruido } = await uow.read(async (ctx) => ({
      saldo: (await ctx.wallets.findById(walletId))!.balance,
      reconstruido: await ctx.ledger.reconstructBalance(walletId, "BRL"),
    }));

    expect(saldo.toJSON().amount).toBe("469.49");
    expect(reconstruido.equals(saldo)).toBe(true);
  });
});
