import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import type { Clock } from "../../src/application/ports/clock";
import { WagerTransactionApplier } from "../../src/application/wagering/apply-wager-transaction";
import {
  DEFAULT_PENDING_REFERENCE_OPTIONS,
  PendingReferenceWorker,
} from "../../src/application/wagering/retry-pending-reference";
import {
  SubmitOutcome,
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from "../../src/application/wagering/submit-wager-transaction";
import { OpenWallet } from "../../src/application/wallets/open-wallet";
import { ReconcileWallet } from "../../src/application/wallets/reconcile-wallet";
import { WalletQueries } from "../../src/application/wallets/wallet-queries";
import { WagerTransactionQueries } from "../../src/application/wagering/wager-transaction-queries";
import { FailureCode } from "../../src/domain/shared/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionSource as Source,
} from "../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../src/domain/wagering/wager-transaction-status";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { UuidV7Generator } from "../../src/infrastructure/system-clock";
import { openOrmWithFreshSchema } from "../support/database";
import { loggerMudo } from "../support/logger";
import { MetricsEspia } from "../support/metrics";

class RelogioControlado implements Clock {
  constructor(private instante = new Date("2026-11-11T12:00:00.000Z")) {}
  now(): Date {
    return this.instante;
  }
  avanca(ms: number): void {
    this.instante = new Date(this.instante.getTime() + ms);
  }
}

let orm: MikroORM;
let uow: MikroUnitOfWork;
let submit: SubmitWagerTransaction;
let open: OpenWallet;
let walletQueries: WalletQueries;
let txQueries: WagerTransactionQueries;
let reconcile: ReconcileWallet;
let clock: RelogioControlado;
let worker: PendingReferenceWorker;

const ids = new UuidV7Generator();
const uuid = (): string => crypto.randomUUID();
const metrics = new MetricsEspia();

/** Worker com limites reduzidos, para esgotar sem esperar 24h. */
function workerCom(over: Partial<typeof DEFAULT_PENDING_REFERENCE_OPTIONS> = {}): PendingReferenceWorker {
  return new PendingReferenceWorker(
    uow,
    new WagerTransactionApplier(ids, metrics),
    clock,
    ids,
    loggerMudo,
    metrics,
    { ...DEFAULT_PENDING_REFERENCE_OPTIONS, ...over },
  );
}

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  uow = new MikroUnitOfWork(orm);
  clock = new RelogioControlado();
  const applier = new WagerTransactionApplier(ids, metrics);
  submit = new SubmitWagerTransaction(uow, clock, ids, applier, loggerMudo, metrics);
  open = new OpenWallet(uow, clock, ids, metrics);
  walletQueries = new WalletQueries(uow);
  txQueries = new WagerTransactionQueries(uow);
  reconcile = new ReconcileWallet(uow, { divergenceDetected: () => {} });
  worker = workerCom();
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

/**
 * Força a fila a estar vencida, sem esperar o backoff.
 *
 * A fila do worker e **global** e transacoes de testes anteriores deste arquivo
 * continuam nela — append-only no banco significa que nao ha DELETE para
 * limpar. Por isso as assercoes olham o estado da transacao em questao, e as
 * contagens do ciclo sao tratadas como piso, nao como igualdade.
 */
const venceAgendamentos = (): Promise<unknown> =>
  orm.em
    .getConnection()
    .execute(
      "update wager_transactions set next_reference_attempt_at = now() - interval '1 hour' where status = 'PENDING_REFERENCE'",
    );

describe("worker de referencia ausente", () => {
  it("resolve quando a referencia chega depois", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const betExternalId = `bet-${uuid()}`;

    // O ROLLBACK chega primeiro — comportamento normal com at-least-once.
    const rollback = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    expect(rollback.outcome).toBe(SubmitOutcome.PendingReference);
    expect(await saldoDe(walletId)).toBe("100.00");

    // Nada a fazer enquanto a referencia nao existe.
    await venceAgendamentos();
    const primeiroCiclo = await worker.runOnce();
    expect(primeiroCiclo.resolved).toBe(0);
    expect(primeiroCiclo.deferred).toBeGreaterThanOrEqual(1);

    // A BET chega.
    const bet = await submit.run(
      comando(walletId, playerId, { externalTransactionId: betExternalId }),
    );
    expect(bet.outcome).toBe(SubmitOutcome.Processed);
    expect(await saldoDe(walletId)).toBe("75.00");

    // Agora o worker resolve: o ROLLBACK da BET credita de volta.
    await venceAgendamentos();
    expect((await worker.runOnce()).resolved).toBeGreaterThanOrEqual(1);

    expect(await saldoDe(walletId)).toBe("100.00");
    const tx = await txQueries.byId(rollback.transactionId!);
    expect(tx?.status).toBe(Status.Processed);
    expect((await reconcile.run(walletId))?.consistent).toBe(true);
  });

  it("conta tentativa e adia com backoff enquanto a referencia nao chega", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const pendente = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: `ausente-${uuid()}`,
      }),
    );

    for (let i = 0; i < 3; i += 1) {
      await venceAgendamentos();
      expect((await worker.runOnce()).deferred).toBeGreaterThanOrEqual(1);
    }

    const linhas = await orm.em
      .getConnection()
      .execute<Array<{ reference_attempts: number; next_reference_attempt_at: Date | null }>>(
        "select reference_attempts, next_reference_attempt_at from wager_transactions where id = ?",
        [pendente.transactionId],
      );
    // 1 da submissao + 3 do worker.
    expect(Number(linhas[0]?.reference_attempts)).toBe(4);
    expect(linhas[0]?.next_reference_attempt_at).not.toBeNull();
  });

  it("nao processa antes de a proxima tentativa vencer", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const pendente = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: `ausente-${uuid()}`,
      }),
    );

    // Sem vencer o agendamento, esta transacao nao e tocada: segue aguardando
    // com a contagem de tentativas da submissao.
    await worker.runOnce();
    const linhas = await orm.em
      .getConnection()
      .execute<Array<{ reference_attempts: number; status: string }>>(
        "select reference_attempts, status from wager_transactions where id = ?",
        [pendente.transactionId],
      );
    expect(linhas[0]?.status).toBe("PENDING_REFERENCE");
    expect(Number(linhas[0]?.reference_attempts)).toBe(1);
  });

  it("rejeita com REFERENCE_NOT_FOUND quando o limite esgota", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const pendente = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: `nunca-chega-${uuid()}`,
      }),
    );

    // Limite de 2 tentativas: a submissao gastou 1, uma rodada do worker gasta
    // a outra e a decisao de desistir acontece.
    const curto = workerCom({ maxAttempts: 2 });
    await venceAgendamentos();
    expect((await curto.runOnce()).rejected).toBeGreaterThanOrEqual(1);

    const tx = await txQueries.byId(pendente.transactionId!);
    expect(tx?.status).toBe(Status.Rejected);
    expect(tx?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await saldoDe(walletId)).toBe("100.00");
  });

  it("rejeita por TTL mesmo com tentativas de sobra", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const pendente = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: `nunca-chega-${uuid()}`,
      }),
    );

    // O TTL e o limite que vale: avanca o relogio alem dele.
    clock.avanca(25 * 60 * 60 * 1000);
    await venceAgendamentos();
    expect((await worker.runOnce()).rejected).toBeGreaterThanOrEqual(1);

    const tx = await txQueries.byId(pendente.transactionId!);
    expect(tx?.status).toBe(Status.Rejected);
    expect(tx?.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it("publica o evento de rejeicao para o provedor conciliar", async () => {
    const { walletId, playerId } = await carteira("100.00");
    await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: `nunca-chega-${uuid()}`,
      }),
    );
    await uow.run((ctx) =>
      ctx.outbox.claimDue({ limit: 500, leaseSeconds: 1, workerId: "dreno", maxAttempts: 999 }),
    );

    const curto = workerCom({ maxAttempts: 2 });
    await venceAgendamentos();
    await curto.runOnce();

    const eventos = await uow.run((ctx) =>
      ctx.outbox.claimDue({ limit: 500, leaseSeconds: 30, workerId: "verificador", maxAttempts: 999 }),
    );
    expect(eventos.map((e) => e.eventType)).toContain("WagerTransactionRejected");
  });

  it("recusa referencia de escopo errado em vez de ficar aguardando", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const betExternalId = `bet-${uuid()}`;
    await submit.run(
      comando(walletId, playerId, { externalTransactionId: betExternalId, roundId: "round-A" }),
    );

    const refund = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: betExternalId,
        roundId: "round-B",
      }),
    );
    // A referencia existe, so nao serve: rejeicao imediata, sem espera.
    expect(refund.outcome).toBe(SubmitOutcome.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceScopeMismatch);
  });

  it("ignora transacao que outro worker ja resolveu", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const betExternalId = `bet-${uuid()}`;
    const rollback = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    await submit.run(comando(walletId, playerId, { externalTransactionId: betExternalId }));

    // Dois workers no mesmo ciclo: um resolve, o outro ve estado terminal.
    await venceAgendamentos();
    await Promise.all([worker.runOnce(), workerCom().runOnce()]);

    const tx = await txQueries.byId(rollback.transactionId!);
    expect(tx?.status).toBe(Status.Processed);
    // Creditado uma vez so.
    expect(await saldoDe(walletId)).toBe("100.00");
  });
});

describe("worker de referencia ausente — replicas concorrentes", () => {
  it("duas replicas no mesmo ciclo consomem uma tentativa so", async () => {
    // A fila e lida sem claim de proposito (reivindicar a transacao antes da
    // carteira inverteria a ordem de lock e traria o deadlock de volta). Quem
    // serializa e o predicado de vencimento na releitura sob o lock: sem ele,
    // cada replica queimaria uma tentativa por ciclo e o backoff deixaria de
    // existir — as 120 tentativas esgotariam muito antes das 24h do TTL.
    const { walletId, playerId } = await carteira("100.00");
    const pendente = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: `ausente-${uuid()}`,
      }),
    );

    const tentativasDe = async (): Promise<number> => {
      const linhas = await orm.em
        .getConnection()
        .execute<Array<{ reference_attempts: number }>>(
          "select reference_attempts from wager_transactions where id = ?",
          [pendente.transactionId],
        );
      return Number(linhas[0]?.reference_attempts);
    };

    expect(await tentativasDe()).toBe(1); // a submissao

    await venceAgendamentos();
    await Promise.all([
      workerCom().runOnce(),
      workerCom().runOnce(),
      workerCom().runOnce(),
    ]);

    // Tres replicas, uma tentativa.
    expect(await tentativasDe()).toBe(2);
  });

  it("linha que falha nao starva as seguintes na fila", async () => {
    // Sem try/catch por linha, uma linha que estoura abortaria o ciclo; e como
    // o rollback desfaz o adiamento, ela continuaria vencida na mesma posicao
    // e nada ordenado depois dela seria alcancado.
    const { walletId, playerId } = await carteira("100.00");
    const betExternalId = `bet-${uuid()}`;

    const problematica = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: `ausente-${uuid()}`,
      }),
    );
    const resolvivel = await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    await submit.run(comando(walletId, playerId, { externalTransactionId: betExternalId }));

    // Um aplicador que estoura so para a primeira transacao.
    const aplicadorInstavel = new WagerTransactionApplier(ids, metrics);
    const originalApply = aplicadorInstavel.apply.bind(aplicadorInstavel);
    aplicadorInstavel.apply = async (params) => {
      if (params.transaction.id === problematica.transactionId) {
        throw new Error("falha proposital nesta linha");
      }
      return originalApply(params);
    };

    const instavel = new PendingReferenceWorker(
      uow,
      aplicadorInstavel,
      clock,
      ids,
      loggerMudo,
      metrics,
      { ...DEFAULT_PENDING_REFERENCE_OPTIONS, failureBackoffMs: 600_000 },
    );

    await venceAgendamentos();
    const resumo = await instavel.runOnce();

    expect(resumo.failed).toBeGreaterThanOrEqual(1);
    // A que vinha depois na fila foi alcancada e resolvida.
    expect((await txQueries.byId(resolvivel.transactionId!))?.status).toBe(Status.Processed);

    // E a que falhou foi adiada, em vez de ficar vencida no mesmo lugar.
    const linhas = await orm.em
      .getConnection()
      .execute<Array<{ next_reference_attempt_at: Date | null; reference_attempts: number }>>(
        "select next_reference_attempt_at, reference_attempts from wager_transactions where id = ?",
        [problematica.transactionId],
      );
    expect(linhas[0]?.next_reference_attempt_at).not.toBeNull();
    expect(Number(linhas[0]?.reference_attempts)).toBe(2);
  });
});

describe("invariante final apos reprocessamento", () => {
  it("o saldo continua sendo o saldo reconstruido pelo ledger", async () => {
    const { walletId, playerId } = await carteira("500.00");
    const betExternalId = `bet-${uuid()}`;

    await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    await submit.run(
      comando(walletId, playerId, { externalTransactionId: betExternalId, money: { amount: "25.00", currency: "BRL" } }),
    );
    await venceAgendamentos();
    await worker.runOnce();

    const resultado = await reconcile.run(walletId);
    expect(resultado?.consistent).toBe(true);
    expect(resultado?.storedBalance.amount).toBe("500.00");
  });
});

describe("metrica do que o worker aplica", () => {
  it("conta a transacao resolvida pelo worker, com o source original", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const betExternalId = `bet-${uuid()}`;

    await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    await submit.run(comando(walletId, playerId, { externalTransactionId: betExternalId }));

    await venceAgendamentos();
    metrics.limpa();
    expect((await worker.runOnce()).resolved).toBeGreaterThanOrEqual(1);

    // A transacao saiu da submissao como PENDING_REFERENCE e foi aplicada
    // aqui. Sem esta contagem, toda reversao que chega antes da referencia
    // ficaria fora da serie e ela nao fecharia com o ledger.
    const aplicadas = metrics.transacoes.filter((t) => t.outcome === "PROCESSED");
    expect(aplicadas).toHaveLength(1);
    expect(aplicadas[0]).toMatchObject({ kind: Kind.Rollback, source: Source.Api });
  });

  it("conta a rejeicao por TTL esgotado", async () => {
    const { walletId, playerId } = await carteira("100.00");
    await submit.run(
      comando(walletId, playerId, {
        kind: Kind.Refund,
        referenceExternalTransactionId: `ausente-${uuid()}`,
      }),
    );

    const curto = workerCom({ maxAttempts: 1, ttlMs: 0 });
    await venceAgendamentos();
    metrics.limpa();
    expect((await curto.runOnce()).rejected).toBeGreaterThanOrEqual(1);

    // `ttlMs: 0` esgota tambem as pendencias dos testes anteriores do arquivo,
    // entao a afirmacao e sobre a natureza do que foi contado, nao a
    // quantidade: toda rejeicao deste ciclo e por referencia inexistente.
    expect(metrics.transacoes.length).toBeGreaterThanOrEqual(1);
    expect(
      metrics.transacoes.every(
        (t) => t.outcome === "REJECTED" && t.failureCode === FailureCode.ReferenceNotFound,
      ),
    ).toBe(true);
    expect(metrics.transacoes.some((t) => t.kind === Kind.Refund)).toBe(true);
  });
});
