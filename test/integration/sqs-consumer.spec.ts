import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import {
  DEFAULT_CONSUMER_OPTIONS,
  WagerTransactionConsumer,
} from "../../src/application/wagering/consume-wager-transactions";
import { WagerTransactionApplier } from "../../src/application/wagering/apply-wager-transaction";
import { SubmitWagerTransaction } from "../../src/application/wagering/submit-wager-transaction";
import { OpenWallet } from "../../src/application/wallets/open-wallet";
import { WalletQueries } from "../../src/application/wallets/wallet-queries";
import { WagerTransactionQueries } from "../../src/application/wagering/wager-transaction-queries";
import { WagerTransactionStatus as Status } from "../../src/domain/wagering/wager-transaction-status";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { SqsMessageQueue } from "../../src/infrastructure/messaging/sqs-message-queue";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { SystemClock, UuidV7Generator } from "../../src/infrastructure/system-clock";
import { NoopMetrics } from "../../src/infrastructure/observability/prometheus-metrics";
import { openOrmWithFreshSchema } from "../support/database";
import { loggerMudo } from "../support/logger";
import {
  aguardaAte,
  contaNaFila,
  DLQ_URL,
  esvaziaFilas,
  leDaDlq,
  publicaCru,
  publicaOperacao,
  QUEUE_URL,
  sqs,
} from "../support/sqs";

let orm: MikroORM;
let uow: MikroUnitOfWork;
let submit: SubmitWagerTransaction;
let open: OpenWallet;
let walletQueries: WalletQueries;
let txQueries: WagerTransactionQueries;
let queue: SqsMessageQueue;
let consumer: WagerTransactionConsumer | undefined;

const uuid = (): string => crypto.randomUUID();
const metrics = new NoopMetrics();
// Silencioso para nao poluir a saida do teste; o conteudo do log tem teste proprio.

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  uow = new MikroUnitOfWork(orm);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  submit = new SubmitWagerTransaction(
    uow,
    clock,
    ids,
    new WagerTransactionApplier(ids, metrics),
    loggerMudo,
    metrics,
  );
  open = new OpenWallet(uow, clock, ids, metrics);
  walletQueries = new WalletQueries(uow);
  txQueries = new WagerTransactionQueries(uow);
  queue = new SqsMessageQueue(sqs, QUEUE_URL, DLQ_URL);
  await esvaziaFilas();
});

afterEach(async () => {
  if (consumer) {
    await consumer.stop();
    consumer = undefined;
  }
});

afterAll(async () => {
  if (orm) await orm.close(true);
});

/** Liga o consumer, espera a condicao e desliga. */
async function consomeAte(condicao: () => Promise<boolean>): Promise<void> {
  consumer = new WagerTransactionConsumer(queue, submit, loggerMudo, metrics, {
    ...DEFAULT_CONSUMER_OPTIONS,
    waitSeconds: 1,
    idleDelayMs: 20,
  });
  const execucao = consumer.start();
  try {
    await aguardaAte(condicao);
  } finally {
    await consumer.stop();
    await execucao;
    consumer = undefined;
  }
}

async function carteira(saldo = "1000.00"): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuid();
  const resultado = await open.run({
    playerId,
    initialBalance: { amount: saldo, currency: "BRL" },
    correlationId: uuid(),
  });
  return { walletId: resultado.walletId, playerId };
}

const saldoDe = async (walletId: string): Promise<string> =>
  (await walletQueries.byId(walletId))!.balance.amount;

const lancamentos = async (walletId: string): Promise<number> =>
  (await walletQueries.ledger(walletId, undefined, 200)).entries.length;

describe("consumer com SQS real", () => {
  it("aplica a operacao e remove a mensagem da fila", async () => {
    const { walletId, playerId } = await carteira("100.00");
    await publicaOperacao({ messageId: `msg-${uuid()}`, walletId, playerId });

    await consomeAte(async () => (await saldoDe(walletId)) === "75.00");

    expect(await saldoDe(walletId)).toBe("75.00");
    expect(await lancamentos(walletId)).toBe(2);
    expect(await contaNaFila(QUEUE_URL)).toBe(0);
  });

  it("grava a inbox com o messageId do envelope, nao o do broker", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const messageId = `msg-${uuid()}`;
    await publicaOperacao({ messageId, walletId, playerId });

    await consomeAte(async () => (await saldoDe(walletId)) === "75.00");

    const inbox = await uow.read((ctx) =>
      ctx.inbox.find(DEFAULT_CONSUMER_OPTIONS.consumerName, messageId),
    );
    expect(inbox?.isProcessed()).toBe(true);
  });

  it("o mesmo messageId reenviado aplica o efeito uma vez", async () => {
    // Ids de deduplicacao distintos de proposito: o que se mede aqui e a
    // deduplicacao da **inbox**, nao a janela de 5 min do FIFO.
    const { walletId, playerId } = await carteira("100.00");
    const messageId = `msg-${uuid()}`;
    const externalId = `external-${uuid()}`;

    for (let i = 0; i < 3; i += 1) {
      await publicaCru(
        JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "provider-a",
            externalTransactionId: externalId,
            idempotencyKey: `provider-a:${externalId}`,
            playerId,
            walletId,
            roundId: "round-987",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "25.00", currency: "BRL" },
          },
        }),
        walletId,
        `dedup-${uuid()}`,
      );
    }

    await consomeAte(async () => (await contaNaFila(QUEUE_URL)) === 0);

    expect(await saldoDe(walletId)).toBe("75.00");
    expect(await lancamentos(walletId)).toBe(2);
  });

  it("rejeicao de negocio da ack e fica auditavel", async () => {
    const { walletId, playerId } = await carteira("10.00");
    const externalId = `external-${uuid()}`;
    await publicaOperacao({
      messageId: `msg-${uuid()}`,
      walletId,
      playerId,
      externalTransactionId: externalId,
      amount: "500.00",
    });

    await consomeAte(async () =>
      (await txQueries.byProviderAndExternalId("provider-a", externalId)) !== undefined,
    );

    const tx = await txQueries.byProviderAndExternalId("provider-a", externalId);
    expect(tx?.status).toBe(Status.Rejected);
    expect(tx?.failureCode).toBe(FailureCode.InsufficientFunds);
    // Reenviar nao mudaria o resultado: a mensagem sai da fila.
    expect(await contaNaFila(QUEUE_URL)).toBe(0);
    expect(await saldoDe(walletId)).toBe("10.00");
  });

  it("referencia ausente fica PENDING_REFERENCE e a mensagem sai da fila", async () => {
    const { walletId, playerId } = await carteira("100.00");
    const externalId = `external-${uuid()}`;
    await publicaOperacao({
      messageId: `msg-${uuid()}`,
      walletId,
      playerId,
      externalTransactionId: externalId,
      kind: "ROLLBACK",
      referenceExternalTransactionId: `ausente-${uuid()}`,
    });

    await consomeAte(async () =>
      (await txQueries.byProviderAndExternalId("provider-a", externalId)) !== undefined,
    );

    const tx = await txQueries.byProviderAndExternalId("provider-a", externalId);
    expect(tx?.status).toBe(Status.PendingReference);
    expect(await contaNaFila(QUEUE_URL)).toBe(0);
  });
});

describe("consumer — dead letter", () => {
  it("corpo que nao e JSON vai para a DLQ com o motivo", async () => {
    await esvaziaFilas();
    const grupo = uuid();
    await publicaCru("{ isto nao e json", grupo, `dedup-${uuid()}`);

    // Captura na propria espera: a leitura remove da DLQ, entao ler de novo
    // depois devolveria vazio.
    let mortas: Array<{ body: string; reason: string | undefined }> = [];
    await consomeAte(async () => {
      const lidas = await leDaDlq();
      if (lidas.length === 0) return false;
      mortas = lidas;
      return true;
    });

    expect(mortas.length).toBeGreaterThan(0);
    expect(mortas[0]?.reason).toContain("JSON");
    expect(await contaNaFila(QUEUE_URL)).toBe(0);
  });

  it("tipo de evento desconhecido vai para a DLQ", async () => {
    await esvaziaFilas();
    const grupo = uuid();
    await publicaCru(
      JSON.stringify({
        messageId: `msg-${uuid()}`,
        type: "AlgoQueNaoConhecemos",
        occurredAt: new Date().toISOString(),
        data: {},
      }),
      grupo,
      `dedup-${uuid()}`,
    );

    let mortas: Array<{ body: string; reason: string | undefined }> = [];
    await consomeAte(async () => {
      const lidas = await leDaDlq();
      if (lidas.length === 0) return false;
      mortas = lidas;
      return true;
    });

    expect(mortas[0]?.reason).toContain("envelope invalido");
  });
});
