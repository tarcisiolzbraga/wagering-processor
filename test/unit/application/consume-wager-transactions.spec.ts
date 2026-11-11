import { describe, expect, it } from "bun:test";

import type { Logger } from "../../../src/application/ports/logger";
import type { MessageQueue, QueueMessage } from "../../../src/application/ports/message-queue";
import { NoopMetrics } from "../../../src/infrastructure/observability/prometheus-metrics";
import {
  DEFAULT_CONSUMER_OPTIONS,
  WagerTransactionConsumer,
} from "../../../src/application/wagering/consume-wager-transactions";
import {
  SubmitOutcome,
  type SubmitWagerTransaction,
  type SubmitWagerTransactionResult,
} from "../../../src/application/wagering/submit-wager-transaction";
import { WAGER_TRANSACTION_REQUESTED } from "../../../src/application/wagering/wager-transaction-message";
import {
  DomainRuleViolationError,
  InvalidInputError,
} from "../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { loggerMudo } from "../../support/logger";


interface Registro {
  readonly acks: string[];
  readonly devolvidas: Array<{ id: string; seconds: number }>;
  readonly dlq: Array<{ id: string; reason: string }>;
}

class FilaFake implements MessageQueue {
  readonly registro: Registro = { acks: [], devolvidas: [], dlq: [] };
  protected lotes: QueueMessage[][];

  constructor(lotes: QueueMessage[][]) {
    this.lotes = [...lotes];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async receive(): Promise<readonly QueueMessage[]> {
    return this.lotes.shift() ?? [];
  }

  async ack(message: QueueMessage): Promise<void> {
    this.registro.acks.push(message.brokerMessageId);
  }

  async releaseVisibility(message: QueueMessage, seconds: number): Promise<void> {
    this.registro.devolvidas.push({ id: message.brokerMessageId, seconds });
  }

  async sendToDeadLetter(message: QueueMessage, reason: string): Promise<void> {
    this.registro.dlq.push({ id: message.brokerMessageId, reason });
  }
}

function mensagem(over: Partial<QueueMessage> & { corpo?: unknown } = {}): QueueMessage {
  const corpo =
    over.corpo ??
    {
      messageId: "msg-1",
      type: WAGER_TRANSACTION_REQUESTED,
      occurredAt: "2026-11-11T12:00:00.000Z",
      data: {
        providerId: "provider-a",
        externalTransactionId: "tx-1",
        idempotencyKey: "provider-a:tx-1",
        playerId: crypto.randomUUID(),
        walletId: crypto.randomUUID(),
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      },
    };

  return {
    receiptHandle: over.receiptHandle ?? "handle-1",
    brokerMessageId: over.brokerMessageId ?? "broker-1",
    body: over.body ?? JSON.stringify(corpo),
    receiveCount: over.receiveCount ?? 1,
    groupId: "groupId" in over ? over.groupId : "wallet-1",
  };
}

function submitQue(
  comportamento: (comando: unknown) => Promise<SubmitWagerTransactionResult>,
): SubmitWagerTransaction {
  return { run: comportamento } as unknown as SubmitWagerTransaction;
}

const processado: SubmitWagerTransactionResult = {
  outcome: SubmitOutcome.Processed,
  transactionId: "tx",
  idempotentReplay: false,
};

/** Roda um lote e para, sem depender de tempo de parede. */
async function rodaUmLote(
  fila: FilaFake,
  submit: SubmitWagerTransaction,
  esperaMs = 20,
): Promise<void> {
  const consumer = new WagerTransactionConsumer(fila, submit, loggerMudo, new NoopMetrics(), {
    ...DEFAULT_CONSUMER_OPTIONS,
    waitSeconds: 0,
    idleDelayMs: 1,
  });
  const execucao = consumer.start();
  await new Promise((resolve) => setTimeout(resolve, esperaMs));
  await consumer.stop();
  await execucao;
}

describe("consumer — ack somente apos o commit", () => {
  it("resultado de negocio da ack", async () => {
    const fila = new FilaFake([[mensagem()]]);
    await rodaUmLote(fila, submitQue(async () => processado));

    expect(fila.registro.acks).toEqual(["broker-1"]);
    expect(fila.registro.dlq).toEqual([]);
    expect(fila.registro.devolvidas).toEqual([]);
  });

  it("replay e duplicata tambem dao ack — reenviar nao muda o resultado", async () => {
    for (const outcome of [SubmitOutcome.DuplicateMessage, SubmitOutcome.Rejected]) {
      const fila = new FilaFake([[mensagem()]]);
      await rodaUmLote(
        fila,
        submitQue(async () => ({ outcome, idempotentReplay: true })),
      );
      expect(fila.registro.acks).toHaveLength(1);
    }
  });
});

describe("consumer — classificacao de erro", () => {
  it("erro de negocio e terminal: ack, sem DLQ", async () => {
    const fila = new FilaFake([[mensagem()]]);
    await rodaUmLote(
      fila,
      submitQue(async () => {
        throw new DomainRuleViolationError(FailureCode.CurrencyMismatch, "moeda errada");
      }),
    );

    expect(fila.registro.acks).toEqual(["broker-1"]);
    expect(fila.registro.dlq).toEqual([]);
  });

  it("erro permanente vai direto para a DLQ", async () => {
    const fila = new FilaFake([[mensagem()]]);
    await rodaUmLote(
      fila,
      submitQue(async () => {
        throw new InvalidInputError("payload impossivel");
      }),
    );

    expect(fila.registro.dlq).toHaveLength(1);
    expect(fila.registro.dlq[0]?.reason).toContain("payload impossivel");
    // sendToDeadLetter faz o ack por dentro; o consumer nao duplica.
    expect(fila.registro.acks).toEqual([]);
  });

  it("envelope malformado e permanente, nao reenfileirado", async () => {
    const fila = new FilaFake([[mensagem({ body: "{ nao e json" })]]);
    await rodaUmLote(fila, submitQue(async () => processado));

    expect(fila.registro.dlq).toHaveLength(1);
    expect(fila.registro.devolvidas).toEqual([]);
  });

  it("tipo de evento desconhecido vai para a DLQ", async () => {
    const fila = new FilaFake([
      [mensagem({ corpo: { messageId: "m", type: "OutraCoisa", occurredAt: "x", data: {} } })],
    ]);
    await rodaUmLote(fila, submitQue(async () => processado));
    expect(fila.registro.dlq).toHaveLength(1);
  });

  it("falha transitoria devolve a mensagem sem ack", async () => {
    const fila = new FilaFake([[mensagem()]]);
    await rodaUmLote(
      fila,
      submitQue(async () => {
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }),
    );

    expect(fila.registro.acks).toEqual([]);
    expect(fila.registro.dlq).toEqual([]);
    expect(fila.registro.devolvidas).toEqual([
      { id: "broker-1", seconds: DEFAULT_CONSUMER_OPTIONS.retryVisibilitySeconds },
    ]);
  });

  it("no limite de entregas para de devolver e deixa o redrive agir", async () => {
    const fila = new FilaFake([
      [mensagem({ receiveCount: DEFAULT_CONSUMER_OPTIONS.maxReceiveCount })],
    ]);
    await rodaUmLote(
      fila,
      submitQue(async () => {
        throw Object.assign(new Error("banco fora"), { code: "08006" });
      }),
    );

    expect(fila.registro.acks).toEqual([]);
    expect(fila.registro.devolvidas).toEqual([]);
  });
});

describe("consumer — ordem dentro do grupo, paralelo entre grupos", () => {
  function envelopeCom(messageId: string): unknown {
    return {
      messageId,
      type: WAGER_TRANSACTION_REQUESTED,
      occurredAt: "2026-11-11T12:00:00.000Z",
      data: {
        providerId: "provider-a",
        externalTransactionId: messageId,
        idempotencyKey: `provider-a:${messageId}`,
        playerId: crypto.randomUUID(),
        walletId: crypto.randomUUID(),
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      },
    };
  }

  it("mensagens do mesmo grupo sao processadas em ordem", async () => {
    // O FIFO entrega varias mensagens do mesmo grupo num ReceiveMessage. Em
    // paralelo, um ROLLBACK poderia ultrapassar a BET que ele reverte.
    const ordem: string[] = [];
    const fila = new FilaFake([
      [
        mensagem({ brokerMessageId: "b1", groupId: "wallet-A", corpo: envelopeCom("m1") }),
        mensagem({ brokerMessageId: "b2", groupId: "wallet-A", corpo: envelopeCom("m2") }),
        mensagem({ brokerMessageId: "b3", groupId: "wallet-A", corpo: envelopeCom("m3") }),
      ],
    ]);

    await rodaUmLote(
      fila,
      submitQue(async (cmd) => {
        const id = (cmd as { idempotencyKey: string }).idempotencyKey;
        ordem.push(`inicio:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
        ordem.push(`fim:${id}`);
        return processado;
      }),
      200,
    );

    // Sequencial: cada uma termina antes da proxima comecar.
    expect(ordem).toEqual([
      "inicio:provider-a:m1",
      "fim:provider-a:m1",
      "inicio:provider-a:m2",
      "fim:provider-a:m2",
      "inicio:provider-a:m3",
      "fim:provider-a:m3",
    ]);
    expect(fila.registro.acks).toEqual(["b1", "b2", "b3"]);
  });

  it("grupos diferentes sao processados em paralelo", async () => {
    const ordem: string[] = [];
    const fila = new FilaFake([
      [
        mensagem({ brokerMessageId: "b1", groupId: "wallet-A", corpo: envelopeCom("a") }),
        mensagem({ brokerMessageId: "b2", groupId: "wallet-B", corpo: envelopeCom("b") }),
      ],
    ]);

    await rodaUmLote(
      fila,
      submitQue(async (cmd) => {
        const id = (cmd as { idempotencyKey: string }).idempotencyKey;
        ordem.push(`inicio:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        ordem.push(`fim:${id}`);
        return processado;
      }),
      200,
    );

    // Carteiras sem relacao nenhuma nao se serializam: os dois inicios vem
    // antes de qualquer fim.
    expect(ordem.slice(0, 2).every((e) => e.startsWith("inicio:"))).toBe(true);
    expect(fila.registro.acks.sort()).toEqual(["b1", "b2"]);
  });
});

describe("consumer — religar depois de parar", () => {
  it("volta a processar em vez de devolver tudo para sempre", async () => {
    // `drenando` nao era resetado no start, entao o consumer religado
    // devolvia toda mensagem sem processar nenhuma.
    const fila = new FilaFake([[mensagem({ brokerMessageId: "antes" })]]);
    const consumer = new WagerTransactionConsumer(fila, submitQue(async () => processado), loggerMudo, new NoopMetrics(), {
      ...DEFAULT_CONSUMER_OPTIONS,
      waitSeconds: 0,
      idleDelayMs: 1,
    });

    const primeira = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await consumer.stop();
    await primeira;
    expect(fila.registro.acks).toEqual(["antes"]);

    // Religa com uma mensagem nova na fila.
    (fila as unknown as { lotes: unknown[] }).lotes = [[mensagem({ brokerMessageId: "depois" })]];
    const segunda = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await consumer.stop();
    await segunda;

    expect(fila.registro.acks).toEqual(["antes", "depois"]);
    expect(fila.registro.devolvidas).toEqual([]);
  });
});

describe("consumer — falha na propria fila nao escapa", () => {
  it("ack que falha vira aviso, nao erro de poll", async () => {
    const avisos: string[] = [];
    const logger: Logger = {
      ...loggerMudo,
      warn: (msg) => avisos.push(msg),
      child: () => logger,
    };

    class FilaComAckRuim extends FilaFake {
      override async ack(): Promise<void> {
        throw new Error("ReceiptHandleIsInvalid");
      }
    }

    const fila = new FilaComAckRuim([[mensagem()]]);
    const consumer = new WagerTransactionConsumer(fila, submitQue(async () => processado), logger, new NoopMetrics(), {
      ...DEFAULT_CONSUMER_OPTIONS,
      waitSeconds: 0,
      idleDelayMs: 1,
    });
    const execucao = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await consumer.stop();
    await execucao;

    // O trabalho esta commitado; a reentrega sera deduplicada pela inbox.
    expect(avisos.some((m) => m.includes("ack"))).toBe(true);
  });
});

describe("consumer — nivel de log por resultado", () => {
  it("operacao descartada fica em warn, nao em info", async () => {
    // Em info, um conflito de idempotencia passaria invisivel ao alerta: a
    // mensagem recebeu ack, a inbox foi gravada, e nenhuma transacao existe.
    const infos: string[] = [];
    const avisos: string[] = [];
    const logger: Logger = {
      ...loggerMudo,
      info: (msg) => infos.push(msg),
      warn: (msg) => avisos.push(msg),
      child: () => logger,
    };

    const fila = new FilaFake([[mensagem()]]);
    const consumer = new WagerTransactionConsumer(
      fila,
      submitQue(async () => ({
        outcome: SubmitOutcome.IdempotencyConflict,
        transactionId: "tx-anterior",
        idempotentReplay: false,
      })),
      logger,
      new NoopMetrics(),
      { ...DEFAULT_CONSUMER_OPTIONS, waitSeconds: 0, idleDelayMs: 1 },
    );
    const execucao = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await consumer.stop();
    await execucao;

    expect(avisos).toContain("operacao descartada");
    expect(infos).not.toContain("mensagem processada");
  });

  it("rejeicao sem linha de transacao tambem fica em warn", async () => {
    const avisos: string[] = [];
    const logger: Logger = { ...loggerMudo, warn: (msg) => avisos.push(msg), child: () => logger };

    const fila = new FilaFake([[mensagem()]]);
    const consumer = new WagerTransactionConsumer(
      fila,
      submitQue(async () => ({ outcome: SubmitOutcome.Rejected, idempotentReplay: false })),
      logger,
      new NoopMetrics(),
      { ...DEFAULT_CONSUMER_OPTIONS, waitSeconds: 0, idleDelayMs: 1 },
    );
    const execucao = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await consumer.stop();
    await execucao;

    expect(avisos).toContain("operacao descartada");
  });
});

describe("consumer — fila vazia nao starva o event loop", () => {
  it("continua respondendo a stop() com a fila sempre vazia", async () => {
    // Sem a pausa no poll vazio, o laco vira espera ativa de microtasks e o
    // processo fica surdo: nem setTimeout nem SIGTERM chegam a rodar. Este
    // teste travava indefinidamente antes da correcao.
    const fila = new FilaFake([]);
    const consumer = new WagerTransactionConsumer(fila, submitQue(async () => processado), loggerMudo, new NoopMetrics(), {
      ...DEFAULT_CONSUMER_OPTIONS,
      waitSeconds: 0,
      idleDelayMs: 1,
    });

    const execucao = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await consumer.stop();
    await execucao;

    expect(consumer.running).toBe(false);
  });
});

describe("consumer — shutdown", () => {
  it("espera a mensagem em andamento concluir antes de encerrar", async () => {
    let concluida = false;
    const fila = new FilaFake([[mensagem()]]);
    const consumer = new WagerTransactionConsumer(
      fila,
      submitQue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        concluida = true;
        return processado;
      }),
      loggerMudo,
      new NoopMetrics(),
      { ...DEFAULT_CONSUMER_OPTIONS, waitSeconds: 0, idleDelayMs: 1 },
    );

    const execucao = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await consumer.stop();
    await execucao;

    expect(concluida).toBe(true);
    expect(fila.registro.acks).toEqual(["broker-1"]);
    expect(consumer.running).toBe(false);
  });

  it("mensagem que chega durante o dreno e devolvida na hora", async () => {
    // Devolver com visibilidade 0 em vez de deixar invisivel ate o timeout
    // expirar reduz a latencia de reentrega num deploy.
    const fila = new FilaFake([
      [mensagem({ brokerMessageId: "primeira" })],
      [mensagem({ brokerMessageId: "durante-o-dreno" })],
    ]);
    const consumer = new WagerTransactionConsumer(
      fila,
      submitQue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return processado;
      }),
      loggerMudo,
      new NoopMetrics(),
      { ...DEFAULT_CONSUMER_OPTIONS, waitSeconds: 0, idleDelayMs: 1 },
    );

    const execucao = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const parada = consumer.stop();
    await Promise.all([execucao, parada]);

    expect(fila.registro.acks).toContain("primeira");
  });
});
