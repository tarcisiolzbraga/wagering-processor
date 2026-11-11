import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";

import type { EventPublisher, PublishOutcome } from "../../src/application/ports/event-publisher";
import {
  defaultOutboxOptions,
  OutboxPublisherWorker,
} from "../../src/application/wagering/publish-outbox";
import { WagerTransactionApplier } from "../../src/application/wagering/apply-wager-transaction";
import { SubmitWagerTransaction } from "../../src/application/wagering/submit-wager-transaction";
import { OpenWallet } from "../../src/application/wallets/open-wallet";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { SystemClock, UuidV7Generator } from "../../src/infrastructure/system-clock";
import { loadEnv } from "../../src/config/env";
import { NoopMetrics } from "../../src/infrastructure/observability/prometheus-metrics";
import { openOrmWithFreshSchema } from "../support/database";
import { sqs } from "../support/sqs";
import { loggerMudo } from "../support/logger";

const env = loadEnv();
const EVENTS_URL = env.SQS_EVENTS_QUEUE_URL;

let orm: MikroORM;
let uow: MikroUnitOfWork;
let submit: SubmitWagerTransaction;
let open: OpenWallet;

const clock = new SystemClock();
const ids = new UuidV7Generator();
const uuid = (): string => crypto.randomUUID();
const metrics = new NoopMetrics();

/** Publisher que sempre falha, para exercitar o caminho de retry. */
class PublisherQueFalha implements EventPublisher {
  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    return {
      publishedIds: [],
      failures: messages.map((m) => ({ id: m.id, reason: "broker indisponivel" })),
    };
  }
}

/** Publisher que registra o que recebeu sem enviar nada. */
class PublisherEspiao implements EventPublisher {
  readonly recebidos: string[] = [];
  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    this.recebidos.push(...messages.map((m) => m.id));
    return { publishedIds: messages.map((m) => m.id), failures: [] };
  }
}

/** Publisher que "morre" depois de publicar, sem deixar marcar. */
class PublisherQueMorre implements EventPublisher {
  readonly publicados: string[] = [];
  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    this.publicados.push(...messages.map((m) => m.id));
    throw new Error("processo morreu depois de publicar, antes de marcar");
  }
}

function worker(
  publisher: EventPublisher,
  over: Partial<ReturnType<typeof defaultOutboxOptions>> = {},
): OutboxPublisherWorker {
  return new OutboxPublisherWorker(uow, publisher, clock, loggerMudo, metrics, {
    ...defaultOutboxOptions(`worker-${uuid()}`),
    ...over,
  });
}

async function carteiraComEventos(saldo = "1000.00"): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuid();
  const resultado = await open.run({
    playerId,
    initialBalance: { amount: saldo, currency: "BRL" },
    correlationId: uuid(),
  });
  return { walletId: resultado.walletId, playerId };
}

async function aposta(walletId: string, playerId: string, amount = "25.00"): Promise<void> {
  const externalId = `external-${uuid()}`;
  await submit.run({
    idempotencyKey: `provider-a:${externalId}`,
    providerId: "provider-a",
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET" as never,
    money: { amount, currency: "BRL" },
    source: "API" as never,
    correlationId: uuid(),
  });
}

const pendentes = (): Promise<number> => uow.read((ctx) => ctx.outbox.pendingCount());

/**
 * Publica em ciclos, com teto.
 *
 * `pendingCount` conta tambem linha **reivindicada com lease ativo**, que o
 * publisher nao consegue pegar. Um `while (pendentes() > 0)` sem teto fica
 * infinito se qualquer teste deixar um lease pendurado — foi exatamente o que
 * esgotou o pool de conexoes na primeira versao deste arquivo.
 */
async function publicaTudo(w: OutboxPublisherWorker, maxCiclos = 10): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxCiclos; i += 1) {
    const publicadas = await w.publishOnce();
    total += publicadas;
    if (publicadas === 0) break;
  }
  return total;
}

async function esvaziaEventos(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const resposta = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: EVENTS_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
    );
    const mensagens = resposta.Messages ?? [];
    if (mensagens.length === 0) return;
    for (const m of mensagens) {
      if (m.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: EVENTS_URL, ReceiptHandle: m.ReceiptHandle }),
        );
      }
    }
  }
}

async function leEventos(): Promise<
  Array<{ body: string; eventType: string | undefined; grupo: string | undefined }>
> {
  const resposta = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: EVENTS_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
      MessageAttributeNames: ["All"],
      MessageSystemAttributeNames: ["MessageGroupId"],
    }),
  );
  const mensagens = resposta.Messages ?? [];
  for (const m of mensagens) {
    if (m.ReceiptHandle) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: EVENTS_URL, ReceiptHandle: m.ReceiptHandle }),
      );
    }
  }
  return mensagens.map((m) => ({
    body: m.Body ?? "",
    eventType: m.MessageAttributes?.["eventType"]?.StringValue,
    grupo: m.Attributes?.["MessageGroupId"],
  }));
}

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  uow = new MikroUnitOfWork(orm);
  submit = new SubmitWagerTransaction(
    uow,
    clock,
    ids,
    new WagerTransactionApplier(ids, metrics),
    loggerMudo,
    metrics,
  );
  open = new OpenWallet(uow, clock, ids, metrics);
});

beforeEach(async () => {
  await esvaziaEventos();
  // A outbox e fila de trabalho, nao registro de auditoria: limpar entre
  // testes e isolamento legitimo. Sem isso, um teste que deixa pendencia de
  // proposito (o de retry) quebra as assercoes globais dos seguintes.
  await orm.em.getConnection().execute("delete from outbox_messages");
});

afterAll(async () => {
  if (orm) await orm.close(true);
});

describe("publisher da outbox", () => {
  it("publica o pendente e marca como publicado", async () => {
    const { walletId, playerId } = await carteiraComEventos("100.00");
    await aposta(walletId, playerId);
    expect(await pendentes()).toBeGreaterThan(0);

    const espiao = new PublisherEspiao();
    const publicadas = await publicaTudo(worker(espiao));

    expect(publicadas).toBeGreaterThan(0);
    expect(await pendentes()).toBe(0);
    expect(espiao.recebidos.length).toBe(publicadas);
  });

  it("o evento chega no SQS agrupado pela carteira", async () => {
    const { walletId, playerId } = await carteiraComEventos("100.00");
    await aposta(walletId, playerId);

    await publicaTudo(worker(new SqsEventPublisher(sqs, EVENTS_URL)));

    const eventos = await leEventos();
    expect(eventos.length).toBeGreaterThan(0);
    // MessageGroupId = walletId: ordena os eventos de uma mesma conta.
    expect(eventos.every((e) => e.grupo === walletId)).toBe(true);
    expect(eventos.map((e) => e.eventType)).toContain("WalletBalanceChanged");

    const envelope = JSON.parse(eventos[0]!.body) as Record<string, unknown>;
    expect(envelope["eventId"]).toBeTypeOf("string");
    expect(envelope["correlationId"]).toBeTypeOf("string");
    expect(envelope["version"]).toBe(1);
  });

  it("falha de publicacao agenda retry em vez de perder o evento", async () => {
    const { walletId, playerId } = await carteiraComEventos("100.00");
    await aposta(walletId, playerId);
    const antes = await pendentes();

    const w = worker(new PublisherQueFalha());
    expect(await w.publishOnce()).toBe(0);

    // Continua pendente, com tentativa contada e proxima tentativa agendada.
    expect(await pendentes()).toBe(antes);
    // Le direto a linha: `claimDue` e escrita e so reivindicaria o que ja
    // esta vencido — o ponto aqui e conferir o agendamento, nao reivindicar.
    const linhas = await orm.em
      .getConnection()
      .execute<Array<{ attempts: number; next_attempt_at: Date | null; last_error: string | null }>>(
        `select attempts, next_attempt_at, last_error from outbox_messages
          where published_at is null and abandoned_at is null`,
      );
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.every((l) => Number(l.attempts) >= 1)).toBe(true);
    expect(linhas.every((l) => l.next_attempt_at !== null)).toBe(true);
    expect(linhas.every((l) => l.last_error === "broker indisponivel")).toBe(true);
  });
});

describe("publishers concorrentes", () => {
  it("pegam lotes disjuntos — nenhum evento publicado duas vezes", async () => {
    const { walletId, playerId } = await carteiraComEventos("1000.00");
    for (let i = 0; i < 6; i += 1) await aposta(walletId, playerId, "10.00");

    const a = new PublisherEspiao();
    const b = new PublisherEspiao();
    const wa = worker(a, { batchSize: 5 });
    const wb = worker(b, { batchSize: 5 });

    // Rodam ao mesmo tempo, varias vezes, ate esvaziar.
    for (let i = 0; i < 8; i += 1) {
      const [x, y] = await Promise.all([wa.publishOnce(), wb.publishOnce()]);
      if (x === 0 && y === 0) break;
    }

    expect(await pendentes()).toBe(0);
    const intersecao = a.recebidos.filter((id) => b.recebidos.includes(id));
    expect(intersecao).toEqual([]);
    // E ninguem publicou o mesmo id duas vezes.
    for (const recebidos of [a.recebidos, b.recebidos]) {
      expect(new Set(recebidos).size).toBe(recebidos.length);
    }
  });

  it("o lease impede outro publisher de pegar a mesma linha enquanto vale", async () => {
    const { walletId, playerId } = await carteiraComEventos("100.00");
    await aposta(walletId, playerId);

    const reivindicadas = await uow.run((ctx) =>
      ctx.outbox.claimDue({ limit: 50, leaseSeconds: 60, workerId: "primeiro", maxAttempts: 10 }),
    );
    expect(reivindicadas.length).toBeGreaterThan(0);

    const segundo = await uow.run((ctx) =>
      ctx.outbox.claimDue({ limit: 50, leaseSeconds: 60, workerId: "segundo", maxAttempts: 10 }),
    );
    expect(segundo).toEqual([]);

    // Libera o que foi reivindicado: um lease de 60s pendurado bloquearia os
    // testes seguintes, porque pendingCount conta a linha e o claim nao a pega.
    await uow.run(async (ctx) => {
      for (const mensagem of reivindicadas) {
        await ctx.outbox.markPublished(mensagem.id);
      }
    });
  });
});

describe("cenario obrigatorio: processo morre antes de publicar", () => {
  it("outra instancia assume quando o lease expira", async () => {
    // 1. o commit confirma — a transacao e o evento existem juntos
    const { walletId, playerId } = await carteiraComEventos("100.00");
    await aposta(walletId, playerId);
    const antes = await pendentes();
    expect(antes).toBeGreaterThan(0);

    // 2. o processo reivindica com lease curto e morre antes de marcar
    const morrendo = new PublisherQueMorre();
    const w1 = worker(morrendo, { leaseSeconds: 1 });
    await expect(w1.publishOnce()).rejects.toThrow("morreu depois de publicar");
    expect(morrendo.publicados.length).toBeGreaterThan(0);

    // Nada marcado: continua pendente.
    expect(await pendentes()).toBe(antes);

    // 3. o lease expira e outra instancia assume
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const outro = new PublisherEspiao();
    await publicaTudo(worker(outro, { leaseSeconds: 30 }));

    // 4. o evento foi publicado — duas vezes no total, o que e tolerado por
    // desenho: o consumidor deduplica pelo eventId.
    expect(outro.recebidos.length).toBeGreaterThan(0);
    expect(await pendentes()).toBe(0);
    const republicados = outro.recebidos.filter((id) => morrendo.publicados.includes(id));
    expect(republicados.length).toBeGreaterThan(0);
  });
});

describe("metrica de atraso da outbox", () => {
  it("mede a idade da pendencia mais antiga", async () => {
    const { walletId, playerId } = await carteiraComEventos("100.00");
    await aposta(walletId, playerId);

    const lag = await uow.read((ctx) =>
      ctx.outbox.oldestPendingAgeMs(new Date(Date.now() + 120_000)),
    );
    // E a metrica que denuncia publisher parado: o dinheiro esta certo no
    // banco, a API responde 200, e o mundo externo nao esta sendo avisado.
    expect(lag).toBeGreaterThanOrEqual(120_000);

    await publicaTudo(worker(new PublisherEspiao()));
    expect(await uow.read((ctx) => ctx.outbox.oldestPendingAgeMs(new Date()))).toBe(0);
  });
});
