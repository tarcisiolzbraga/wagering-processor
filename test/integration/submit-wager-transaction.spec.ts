import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import type { Clock } from "../../src/application/ports/clock";
import type { Divergence, ReconciliationAlarm } from "../../src/application/ports/reconciliation-alarm";
import { OpenWallet, OpenWalletOutcome } from "../../src/application/wallets/open-wallet";
import { ReconcileWallet } from "../../src/application/wallets/reconcile-wallet";
import { WalletQueries } from "../../src/application/wallets/wallet-queries";
import { WagerTransactionQueries } from "../../src/application/wagering/wager-transaction-queries";
import {
  SubmitOutcome,
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from "../../src/application/wagering/submit-wager-transaction";
import { InvalidInputError } from "../../src/domain/shared/domain-error";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction";
import {
  WagerTransactionKind as Kind,
  WagerTransactionSource as Source,
} from "../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../src/domain/wagering/wager-transaction-status";
import { UuidV7Generator } from "../../src/infrastructure/system-clock";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { openOrmWithFreshSchema } from "../support/database";

class FixedClock implements Clock {
  constructor(private instante = new Date("2026-11-10T12:00:00.000Z")) {}
  now(): Date {
    return this.instante;
  }
  avanca(ms: number): void {
    this.instante = new Date(this.instante.getTime() + ms);
  }
}

class AlarmeEspiao implements ReconciliationAlarm {
  readonly divergencias: Divergence[] = [];
  divergenceDetected(divergence: Divergence): void {
    this.divergencias.push(divergence);
  }
}

let orm: MikroORM;
let uow: MikroUnitOfWork;
let clock: FixedClock;
let alarme: AlarmeEspiao;
let submit: SubmitWagerTransaction;
let open: OpenWallet;
let walletQueries: WalletQueries;
let txQueries: WagerTransactionQueries;
let reconcile: ReconcileWallet;

const ids = new UuidV7Generator();
const uuid = (): string => crypto.randomUUID();

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  uow = new MikroUnitOfWork(orm);
  clock = new FixedClock();
  alarme = new AlarmeEspiao();
  submit = new SubmitWagerTransaction(uow, clock, ids);
  open = new OpenWallet(uow, clock, ids);
  walletQueries = new WalletQueries(uow);
  txQueries = new WagerTransactionQueries(uow);
  reconcile = new ReconcileWallet(uow, alarme);
});

afterAll(async () => {
  if (orm) await orm.close(true);
});

async function carteira(saldo = "1000.00"): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuid();
  const resultado = await open.run({
    playerId,
    initialBalance: { amount: saldo, currency: "BRL" },
    correlationId: uuid(),
  });
  return { walletId: resultado.walletId, playerId };
}

function comando(
  walletId: string,
  playerId: string,
  over: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalId = over.externalTransactionId ?? `external-${uuid()}`;
  return {
    idempotencyKey: over.idempotencyKey ?? `provider-a:${externalId}`,
    providerId: "provider-a",
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: Kind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    source: Source.Api,
    correlationId: uuid(),
    ...over,
  };
}

const saldoDe = async (walletId: string): Promise<string> =>
  (await walletQueries.byId(walletId))!.balance.amount;

const lancamentosDe = async (walletId: string): Promise<number> =>
  (await walletQueries.ledger(walletId, undefined, 200)).entries.length;

/**
 * Dreno de verdade: reivindica **e** marca publicado. `claimDue` sozinho nao
 * escreve nada, entao a fila continuaria cumulativa e um `toContain` passaria
 * por causa de evento de um teste anterior.
 */
const drenaEventos = async (): Promise<string[]> =>
  uow.run(async (ctx) => {
    const mensagens = await ctx.outbox.claimDue({
      limit: 500,
      leaseSeconds: 30,
      workerId: "teste",
      maxAttempts: 10,
    });
    for (const mensagem of mensagens) {
      await ctx.outbox.markPublished(mensagem.id);
    }
    return mensagens.map((m) => m.eventType);
  });

// ---------------------------------------------------------------------------

describe("OpenWallet", () => {
  it("abre com saldo, OPENING e lancamento na mesma transacao", async () => {
    const playerId = uuid();
    const resultado = await open.run({
      playerId,
      initialBalance: { amount: "1000.00", currency: "BRL" },
      correlationId: uuid(),
    });

    expect(resultado.outcome).toBe(OpenWalletOutcome.Opened);
    expect(resultado.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    // A abertura e a criacao, nao uma movimentacao posterior.
    expect(resultado.version).toBe(1);

    const extrato = await walletQueries.ledger(resultado.walletId, undefined, 10);
    expect(extrato.entries).toHaveLength(1);
    expect(extrato.entries[0]?.direction).toBe(LedgerDirection.Credit);
    expect(extrato.entries[0]?.balanceBefore).toEqual({ amount: "0.00", currency: "BRL" });
    expect(extrato.entries[0]?.balanceAfter).toEqual({ amount: "1000.00", currency: "BRL" });
  });

  it("abre zerada sem lancamento nenhum", async () => {
    const resultado = await open.run({
      playerId: uuid(),
      initialBalance: { amount: "0.00", currency: "BRL" },
      correlationId: uuid(),
    });
    expect(resultado.balance.amount).toBe("0.00");
    expect(await lancamentosDe(resultado.walletId)).toBe(0);
  });

  it("segunda carteira do mesmo player e moeda e conflito", async () => {
    const playerId = uuid();
    const primeira = await open.run({
      playerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
      correlationId: uuid(),
    });
    const segunda = await open.run({
      playerId,
      initialBalance: { amount: "99.00", currency: "BRL" },
      correlationId: uuid(),
    });

    expect(segunda.outcome).toBe(OpenWalletOutcome.AlreadyExists);
    expect(segunda.walletId).toBe(primeira.walletId);
    // O saldo devolvido e o da carteira existente, nao o pedido.
    expect(segunda.balance.amount).toBe("10.00");
  });
});

describe("BET", () => {
  it("debita, gera um lancamento e publica dois eventos", async () => {
    const { walletId, playerId } = await carteira("100.00");
    await drenaEventos();
    const resultado = await submit.run(comando(walletId, playerId));

    expect(resultado.outcome).toBe(SubmitOutcome.Processed);
    expect(resultado.status).toBe(Status.Processed);
    expect(resultado.balance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(resultado.idempotentReplay).toBe(false);

    expect(await saldoDe(walletId)).toBe("75.00");
    expect(await lancamentosDe(walletId)).toBe(2); // abertura + aposta

    const eventos = await drenaEventos();
    expect(eventos).toContain("WagerTransactionProcessed");
    expect(eventos).toContain("WalletBalanceChanged");
  });

  it("sem saldo e rejeitada, sem mover nada", async () => {
    const { walletId, playerId } = await carteira("10.00");
    const resultado = await submit.run(
      comando(walletId, playerId, { money: { amount: "25.00", currency: "BRL" } }),
    );

    expect(resultado.outcome).toBe(SubmitOutcome.Rejected);
    expect(resultado.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(resultado.balance).toEqual({ amount: "10.00", currency: "BRL" });
    expect(await saldoDe(walletId)).toBe("10.00");
    expect(await lancamentosDe(walletId)).toBe(1); // so a abertura

    const tx = await txQueries.byId(resultado.transactionId!);
    expect(tx?.status).toBe(Status.Rejected);
    expect(tx?.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe("idempotencia", () => {
  it("replay devolve o resultado original e o saldo da epoca", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const cmd = comando(walletId, playerId);

    const primeira = await submit.run(cmd);
    // Outra aposta muda o saldo atual entre a original e o replay.
    await submit.run(comando(walletId, playerId, { money: { amount: "5.00", currency: "BRL" } }));
    const replay = await submit.run(cmd);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(primeira.transactionId);
    expect(replay.status).toBe(Status.Processed);
    // 75.00, nao 70.00: o saldo observado naquele momento.
    expect(replay.balance).toEqual({ amount: "75.00", currency: "BRL" });

    expect(await saldoDe(walletId)).toBe("70.00");
    expect(await lancamentosDe(walletId)).toBe(3);
  });

  it("replay de rejeicao devolve a rejeicao original", async () => {
    const { walletId, playerId } = await carteira("10.00");
    const cmd = comando(walletId, playerId, { money: { amount: "25.00", currency: "BRL" } });

    await submit.run(cmd);
    const replay = await submit.run(cmd);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.outcome).toBe(SubmitOutcome.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it("mesma key com payload diferente e conflito, nao replay", async () => {
    const { walletId, playerId } = await carteira("1000.00");
    const key = `provider-a:${uuid()}`;

    await submit.run(comando(walletId, playerId, { idempotencyKey: key }));
    const conflito = await submit.run(
      comando(walletId, playerId, {
        idempotencyKey: key,
        money: { amount: "999.00", currency: "BRL" },
      }),
    );

    expect(conflito.outcome).toBe(SubmitOutcome.IdempotencyConflict);
    expect(conflito.idempotentReplay).toBe(false);
    // A operacao nova nao desapareceu em silencio nem foi aplicada.
    expect(await saldoDe(walletId)).toBe("975.00");
  });

  it("formatacao do valor nao cria conflito: 25 e 25.00 sao o mesmo payload", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const externalId = `external-${uuid()}`;
    const key = `provider-a:${externalId}`;

    await submit.run(
      comando(walletId, playerId, { externalTransactionId: externalId, idempotencyKey: key }),
    );
    // Mesmo payload de negocio, so com o valor escrito de outro jeito.
    const replay = await submit.run(
      comando(walletId, playerId, {
        externalTransactionId: externalId,
        idempotencyKey: key,
        money: { amount: "25", currency: "BRL" },
      }),
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.outcome).toBe(SubmitOutcome.Processed);
    expect(await saldoDe(walletId)).toBe("75.00");
  });

  it("mesma operacao com outra key e conflito de operacao, nao erro de infra", async () => {
    const { walletId, playerId } = await carteira("1000.00");
    const externalId = `external-${uuid()}`;

    await submit.run(comando(walletId, playerId, { externalTransactionId: externalId }));
    const duplicada = await submit.run(
      comando(walletId, playerId, {
        externalTransactionId: externalId,
        idempotencyKey: `provider-a:outra-${uuid()}`,
      }),
    );

    expect(duplicada.outcome).toBe(SubmitOutcome.DuplicateExternalTransaction);
    expect(await saldoDe(walletId)).toBe("975.00");
  });
});

describe("LOSS", () => {
  it("e aplicada sem mover saldo, sem lancamento e sem WalletBalanceChanged", async () => {
    const { walletId, playerId } = await carteira("100.00");
    await drenaEventos();

    const resultado = await submit.run(comando(walletId, playerId, { kind: Kind.Loss }));

    expect(resultado.outcome).toBe(SubmitOutcome.Processed);
    expect(resultado.balance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(await saldoDe(walletId)).toBe("100.00");
    expect(await lancamentosDe(walletId)).toBe(1);

    const eventos = await drenaEventos();
    expect(eventos).toContain("WagerTransactionProcessed");
    // O saldo nao mudou, entao nao ha o que anunciar.
    expect(eventos).not.toContain("WalletBalanceChanged");

    const tx = await txQueries.byId(resultado.transactionId!);
    expect(tx?.status).toBe(Status.Processed);
  });
});

describe("WIN", () => {
  it("credita", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const resultado = await submit.run(
      comando(walletId, playerId, { kind: Kind.Win, money: { amount: "50.00", currency: "BRL" } }),
    );

    expect(resultado.balance).toEqual({ amount: "150.00", currency: "BRL" });
    expect(await saldoDe(walletId)).toBe("150.00");
  });
});

describe("REFUND e ROLLBACK", () => {
  async function apostaProcessada(
    walletId: string,
    playerId: string,
    amount = "25.00",
  ): Promise<string> {
    const externalId = `bet-${uuid()}`;
    const r = await submit.run(
      comando(walletId, playerId, { externalTransactionId: externalId, money: { amount, currency: "BRL" } }),
    );
    expect(r.outcome).toBe(SubmitOutcome.Processed);
    return externalId;
  }

  it("REFUND de uma BET credita de volta", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const bet = await apostaProcessada(walletId, playerId);
    expect(await saldoDe(walletId)).toBe("75.00");

    const refund = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet,
      }),
    );

    expect(refund.outcome).toBe(SubmitOutcome.Processed);
    expect(refund.balance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("segunda reversao da mesma referencia e recusada", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const bet = await apostaProcessada(walletId, playerId);

    await submit.run(
      comando(walletId, playerId, { kind: Kind.Refund, referenceExternalTransactionId: bet }),
    );
    const segunda = await submit.run(
      comando(walletId, playerId, { kind: Kind.Refund, referenceExternalTransactionId: bet }),
    );

    expect(segunda.outcome).toBe(SubmitOutcome.Rejected);
    expect(segunda.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await saldoDe(walletId)).toBe("100.00");
  });

  it("REFUND e ROLLBACK da mesma BET: o segundo e recusado", async () => {
    // Mais estrito que a letra do enunciado, de proposito: permitir os dois
    // renderia +50,00 numa aposta de 25,00, duplicando credito.
    const { walletId, playerId } = await carteira("100.00");
    const bet = await apostaProcessada(walletId, playerId);

    await submit.run(
      comando(walletId, playerId, { kind: Kind.Refund, referenceExternalTransactionId: bet }),
    );
    const rollback = await submit.run(
      comando(walletId, playerId, { kind: Kind.Rollback, referenceExternalTransactionId: bet }),
    );

    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await saldoDe(walletId)).toBe("100.00");
  });

  it("ROLLBACK de um WIN debita", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const externalId = `win-${uuid()}`;
    await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Win,
        externalTransactionId: externalId,
        money: { amount: "50.00", currency: "BRL" },
      }),
    );
    expect(await saldoDe(walletId)).toBe("150.00");

    const rollback = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: externalId,
        money: { amount: "50.00", currency: "BRL" },
      }),
    );

    expect(rollback.outcome).toBe(SubmitOutcome.Processed);
    expect(await saldoDe(walletId)).toBe("100.00");
  });

  it("ROLLBACK que deixaria saldo negativo tem codigo proprio", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const externalId = `win-${uuid()}`;
    await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Win,
        externalTransactionId: externalId,
        money: { amount: "50.00", currency: "BRL" },
      }),
    );
    // Gasta o dinheiro antes de tentar reverter o WIN.
    await submit.run(
      comando(walletId, playerId, { money: { amount: "140.00", currency: "BRL" } }),
    );
    expect(await saldoDe(walletId)).toBe("10.00");

    const rollback = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: externalId,
        money: { amount: "50.00", currency: "BRL" },
      }),
    );

    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(await saldoDe(walletId)).toBe("10.00");
  });

  it("referencia ausente fica PENDING_REFERENCE, nao rejeitada", async () => {
    const { walletId, playerId } = await carteira("100.00");
    await drenaEventos();
    const resultado = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: `ainda-nao-chegou-${uuid()}`,
      }),
    );

    expect(resultado.outcome).toBe(SubmitOutcome.PendingReference);
    expect(resultado.status).toBe(Status.PendingReference);
    expect(await saldoDe(walletId)).toBe("100.00");
    expect(await drenaEventos()).toContain("WagerTransactionPendingReference");
  });

  it("referencia nao processada e recusada", async () => {
    const { walletId, playerId } = await carteira("10.00");
    const externalId = `bet-${uuid()}`;
    const rejeitada = await submit.run(
      comando(walletId, playerId, {
        externalTransactionId: externalId,
        money: { amount: "25.00", currency: "BRL" },
      }),
    );
    expect(rejeitada.outcome).toBe(SubmitOutcome.Rejected);

    const refund = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: externalId,
        money: { amount: "25.00", currency: "BRL" },
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  it("valor diferente da referencia e recusado — reversao parcial esta fora de escopo", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const bet = await apostaProcessada(walletId, playerId, "25.00");

    const refund = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet,
        money: { amount: "10.00", currency: "BRL" },
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });

  it("REFUND de um WIN e recusado: REFUND so reverte BET", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const externalId = `win-${uuid()}`;
    await submit.run(
      comando(walletId, playerId, { kind: Kind.Win, externalTransactionId: externalId }),
    );

    const refund = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: externalId,
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotReversible);
  });

  it("referencia de outra rodada e recusada", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const externalId = `bet-${uuid()}`;
    await submit.run(
      comando(walletId, playerId, { externalTransactionId: externalId, roundId: "round-A" }),
    );

    const refund = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: externalId,
        roundId: "round-B",
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReferenceScopeMismatch);
  });
});

describe("rejeicoes que o schema impede de persistir", () => {
  it("carteira inexistente: recusada sem transactionId", async () => {
    const resultado = await submit.run(comando(uuid(), uuid()));
    expect(resultado.outcome).toBe(SubmitOutcome.Rejected);
    expect(resultado.failureCode).toBe(FailureCode.WalletNotFound);
    expect(resultado.transactionId).toBeUndefined();
  });

  it("moeda diferente da carteira: recusada sem transactionId", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const resultado = await submit.run(
      comando(walletId, playerId, { money: { amount: "10.00", currency: "USD" } }),
    );
    expect(resultado.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(resultado.transactionId).toBeUndefined();
  });

  it("REFUND sem referencia: recusada sem transactionId", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const resultado = await submit.run(comando(walletId, playerId, { kind: Kind.Refund }));
    expect(resultado.failureCode).toBe(FailureCode.MissingReference);
    expect(resultado.transactionId).toBeUndefined();
  });

  it("OPENING pela API: recusada sem transactionId", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const resultado = await submit.run(comando(walletId, playerId, { kind: Kind.Opening }));
    expect(resultado.failureCode).toBe(FailureCode.InternalKindNotSubmittable);
    expect(resultado.transactionId).toBeUndefined();
  });
});

describe("rejeicoes auditaveis", () => {
  it("player que nao e o dono da carteira fica registrado como REJECTED", async () => {
    const { walletId } = await carteira("100.00");
    const resultado = await submit.run(comando(walletId, uuid()));

    expect(resultado.failureCode).toBe(FailureCode.PlayerMismatch);
    expect(resultado.transactionId).toBeDefined();
    const tx = await txQueries.byId(resultado.transactionId!);
    expect(tx?.status).toBe(Status.Rejected);
    expect(tx?.failureCode).toBe(FailureCode.PlayerMismatch);
  });
});

describe("deduplicacao pela inbox", () => {
  it("a mesma mensagem duas vezes aplica o efeito uma vez", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const messageId = `msg-${uuid()}`;
    const cmd = comando(walletId, playerId, {
      source: Source.Queue,
      inbox: { consumerName: "wager-transactions", messageId },
    });

    const primeira = await submit.run(cmd);
    expect(primeira.outcome).toBe(SubmitOutcome.Processed);

    const segunda = await submit.run(cmd);
    expect(segunda.outcome).toBe(SubmitOutcome.DuplicateMessage);
    expect(segunda.idempotentReplay).toBe(true);

    expect(await saldoDe(walletId)).toBe("75.00");
    expect(await lancamentosDe(walletId)).toBe(2);
  });
});

describe("cenario obrigatorio da secao 8", () => {
  it("saldo 100, duas apostas de 80: uma processa, outra e recusada, saldo 20", async () => {
    // Sequencial aqui; o paralelismo real com multiplos processos chega na
    // Fase 10. O que este teste fixa e o resultado esperado.
    const { walletId, playerId } = await carteira("100.00");

    const a = await submit.run(
      comando(walletId, playerId, { money: { amount: "80.00", currency: "BRL" } }),
    );
    const b = await submit.run(
      comando(walletId, playerId, { money: { amount: "80.00", currency: "BRL" } }),
    );

    const processadas = [a, b].filter((r) => r.outcome === SubmitOutcome.Processed);
    const recusadas = [a, b].filter((r) => r.outcome === SubmitOutcome.Rejected);

    expect(processadas).toHaveLength(1);
    expect(recusadas).toHaveLength(1);
    expect(recusadas[0]?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await saldoDe(walletId)).toBe("20.00");
    // Exatamente um debito: abertura + uma aposta.
    expect(await lancamentosDe(walletId)).toBe(2);
  });
});

describe("cenario obrigatorio da secao 8 — em paralelo de verdade", () => {
  it("duas apostas de 80 sobre saldo 100, 10 rodadas, sem deadlock", async () => {
    // Este e o teste que pega o erro de ordem de lock. Com o INSERT da
    // transacao antes do FOR UPDATE, o FK toma FOR KEY SHARE na carteira e o
    // lock seguinte e um upgrade: duas operacoes concorrentes formam ciclo e o
    // PostgreSQL mata uma com 40P01. Medido: 28 falhas em 30 rodadas.
    for (let rodada = 0; rodada < 10; rodada += 1) {
      const { walletId, playerId } = await carteira("100.00");

      const resultados = await Promise.all([
        submit.run(comando(walletId, playerId, { money: { amount: "80.00", currency: "BRL" } })),
        submit.run(comando(walletId, playerId, { money: { amount: "80.00", currency: "BRL" } })),
      ]);

      const processadas = resultados.filter((r) => r.outcome === SubmitOutcome.Processed);
      const recusadas = resultados.filter((r) => r.outcome === SubmitOutcome.Rejected);

      expect(processadas).toHaveLength(1);
      expect(recusadas).toHaveLength(1);
      expect(recusadas[0]?.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(await saldoDe(walletId)).toBe("20.00");
      expect(await lancamentosDe(walletId)).toBe(2); // abertura + um debito
    }
  });

  it("quatro apostas concorrentes na mesma carteira: nenhuma falha de infraestrutura", async () => {
    const { walletId, playerId } = await carteira("100.00");

    const resultados = await Promise.all(
      Array.from({ length: 4 }, () =>
        submit.run(comando(walletId, playerId, { money: { amount: "30.00", currency: "BRL" } })),
      ),
    );

    // Todas terminam com resultado de negocio — nenhuma estoura erro cru.
    for (const resultado of resultados) {
      expect([SubmitOutcome.Processed, SubmitOutcome.Rejected]).toContain(resultado.outcome);
    }
    const processadas = resultados.filter((r) => r.outcome === SubmitOutcome.Processed);
    expect(processadas).toHaveLength(3); // 3 x 30 = 90 cabe em 100; a quarta nao
    expect(await saldoDe(walletId)).toBe("10.00");

    const reconciliacao = await reconcile.run(walletId);
    expect(reconciliacao?.consistent).toBe(true);
  });

  it("a mesma aposta enviada 20 vezes em paralelo produz um unico debito", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const cmd = comando(walletId, playerId, { money: { amount: "25.00", currency: "BRL" } });

    const resultados = await Promise.all(Array.from({ length: 20 }, () => submit.run(cmd)));

    const aplicadas = resultados.filter((r) => !r.idempotentReplay);
    expect(aplicadas).toHaveLength(1);
    expect(await saldoDe(walletId)).toBe("75.00");
    expect(await lancamentosDe(walletId)).toBe(2);
  });

  it("carteiras distintas em paralelo nao se bloqueiam", async () => {
    const carteiras = await Promise.all([carteira("100.00"), carteira("100.00"), carteira("100.00")]);

    const resultados = await Promise.all(
      carteiras.map(({ walletId, playerId }) =>
        submit.run(comando(walletId, playerId, { money: { amount: "80.00", currency: "BRL" } })),
      ),
    );

    expect(resultados.every((r) => r.outcome === SubmitOutcome.Processed)).toBe(true);
    for (const { walletId } of carteiras) {
      expect(await saldoDe(walletId)).toBe("20.00");
    }
  });
});

describe("atomicidade preservada nos caminhos de conflito", () => {
  it("DUPLICATE_EXTERNAL_TRANSACTION nao derruba a linha de inbox", async () => {
    // A violacao de unicidade aborta a transacao SQL. Sem savepoint isolando o
    // insert, o COMMIT viraria ROLLBACK em silencio e a dedup da mensagem
    // desapareceria — a mensagem voltaria pela fila e seria reprocessada.
    const { walletId, playerId } = await carteira("1000.00");
    const externalId = `external-${uuid()}`;
    await submit.run(comando(walletId, playerId, { externalTransactionId: externalId }));

    const messageId = `msg-${uuid()}`;
    const resultado = await submit.run(
      comando(walletId, playerId, {
        externalTransactionId: externalId,
        idempotencyKey: `provider-a:outra-${uuid()}`,
        source: Source.Queue,
        inbox: { consumerName: "wager-transactions", messageId },
      }),
    );

    expect(resultado.outcome).toBe(SubmitOutcome.DuplicateExternalTransaction);
    const inbox = await uow.read((ctx) => ctx.inbox.find("wager-transactions", messageId));
    expect(inbox?.isProcessed()).toBe(true);
  });
});

describe("identificadores malformados", () => {
  it("walletId que nao e UUID e payload invalido, nao falha de infraestrutura", async () => {
    await expect(submit.run(comando("wallet-42", uuid()))).rejects.toThrow(InvalidInputError);
  });

  it("playerId que nao e UUID tambem", async () => {
    const { walletId } = await carteira("100.00");
    await expect(submit.run(comando(walletId, "player-42"))).rejects.toThrow(InvalidInputError);
  });
});

describe("referencia vazia nao cria conflito de idempotencia", () => {
  it("sem o campo e com string vazia sao o mesmo payload", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const externalId = `external-${uuid()}`;
    const key = `provider-a:${externalId}`;

    await submit.run(
      comando(walletId, playerId, { externalTransactionId: externalId, idempotencyKey: key }),
    );
    const replay = await submit.run(
      comando(walletId, playerId, {
        externalTransactionId: externalId,
        idempotencyKey: key,
        referenceExternalTransactionId: "",
      }),
    );

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.outcome).toBe(SubmitOutcome.Processed);
  });
});

describe("reconciliacao", () => {
  it("consistente depois de uma sequencia de operacoes", async () => {
    const { walletId, playerId } = await carteira("500.00");
    await submit.run(comando(walletId, playerId, { money: { amount: "10.00", currency: "BRL" } }));
    await submit.run(
      comando(walletId, playerId, { kind: Kind.Win, money: { amount: "3.50", currency: "BRL" } }),
    );
    await submit.run(comando(walletId, playerId, { kind: Kind.Loss }));

    const resultado = await reconcile.run(walletId);

    expect(resultado?.consistent).toBe(true);
    expect(resultado?.storedBalance).toEqual({ amount: "493.50", currency: "BRL" });
    expect(resultado?.calculatedBalance).toEqual({ amount: "493.50", currency: "BRL" });
    expect(resultado?.difference).toEqual({ amount: "0.00", currency: "BRL" });
    expect(resultado?.checkedEntries).toBe(3); // abertura + bet + win; LOSS nao lanca
    expect(alarme.divergencias).toHaveLength(0);
  });

  it("carteira inexistente devolve undefined", async () => {
    expect(await reconcile.run(uuid())).toBeUndefined();
  });
});

describe("invariante final", () => {
  it("o saldo e sempre o saldo reconstruido pelo ledger", async () => {
    const { walletId, playerId } = await carteira("1000.00");
    const bet = `bet-${uuid()}`;

    await submit.run(
      comando(walletId, playerId, { externalTransactionId: bet, money: { amount: "250.50", currency: "BRL" } }),
    );
    await submit.run(
      comando(walletId, playerId, { kind: Kind.Win, money: { amount: "99.99", currency: "BRL" } }),
    );
    await submit.run(comando(walletId, playerId, { kind: Kind.Loss }));
    await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet,
        money: { amount: "250.50", currency: "BRL" },
      }),
    );
    await submit.run(comando(walletId, playerId, { money: { amount: "5000.00", currency: "BRL" } }));

    const resultado = await reconcile.run(walletId);
    expect(resultado?.consistent).toBe(true);
    expect(resultado?.storedBalance.amount).toBe("1099.99");
  });
});
