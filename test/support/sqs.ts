import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

import { loadEnv } from "../../src/config/env";
import { WAGER_TRANSACTION_REQUESTED } from "../../src/application/wagering/wager-transaction-message";

const env = loadEnv();

export const sqs = new SQSClient({
  region: env.AWS_REGION,
  endpoint: env.SQS_ENDPOINT,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

export const QUEUE_URL = env.SQS_QUEUE_URL;
export const DLQ_URL = env.SQS_DLQ_URL;

export interface EnvelopeDeTeste {
  readonly messageId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind?: string;
  readonly amount?: string;
  readonly externalTransactionId?: string;
  readonly idempotencyKey?: string;
  readonly referenceExternalTransactionId?: string;
}

/** Publica na fila principal como um provedor faria. */
export async function publicaOperacao(envelope: EnvelopeDeTeste): Promise<void> {
  const externalId = envelope.externalTransactionId ?? `external-${crypto.randomUUID()}`;
  const corpo = {
    messageId: envelope.messageId,
    type: WAGER_TRANSACTION_REQUESTED,
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: externalId,
      idempotencyKey: envelope.idempotencyKey ?? `provider-a:${externalId}`,
      playerId: envelope.playerId,
      walletId: envelope.walletId,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: envelope.kind ?? "BET",
      money: { amount: envelope.amount ?? "25.00", currency: "BRL" },
      ...(envelope.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: envelope.referenceExternalTransactionId }),
    },
  };
  await publicaCru(JSON.stringify(corpo), envelope.walletId, envelope.messageId);
}

/** Publica um corpo arbitrario — usado para testar envelope malformado. */
export async function publicaCru(
  body: string,
  grupo: string,
  deduplicacao: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: body,
      // MessageGroupId = walletId: ordena os eventos de uma mesma carteira.
      MessageGroupId: grupo,
      MessageDeduplicationId: deduplicacao,
    }),
  );
}

export async function esvaziaFilas(): Promise<void> {
  for (const url of [QUEUE_URL, DLQ_URL]) {
    try {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
    } catch {
      // PurgeQueue tem limite de uma chamada por minuto; drenar na mao resolve.
      await drena(url);
    }
  }
}

/** Recebe **e apaga**: sem o delete, a fila nunca esvazia e as mensagens
 * reaparecem quando o visibility timeout expira, dentro de outro teste. */
async function drena(url: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const resposta = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
    );
    const mensagens = resposta.Messages ?? [];
    if (mensagens.length === 0) return;
    for (const mensagem of mensagens) {
      if (mensagem.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: mensagem.ReceiptHandle }),
        );
      }
    }
  }
}

/**
 * Le **e remove** da DLQ. Sem apagar, a leitura deixa a mensagem invisivel
 * pelo visibility timeout, e uma segunda chamada volta vazia — o que faz um
 * teste que le duas vezes falhar por motivo alheio ao que mede.
 */
export async function leDaDlq(): Promise<
  Array<{ body: string; reason: string | undefined }>
> {
  const resposta = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: DLQ_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ["All"],
    }),
  );

  const mensagens = resposta.Messages ?? [];
  for (const mensagem of mensagens) {
    if (mensagem.ReceiptHandle) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: DLQ_URL, ReceiptHandle: mensagem.ReceiptHandle }),
      );
    }
  }

  return mensagens.map((m) => ({
    body: m.Body ?? "",
    reason: m.MessageAttributes?.["failureReason"]?.StringValue,
  }));
}

/**
 * Conta o que esta visivel na fila **via atributo**, nao recebendo mensagem.
 *
 * Receber faria do teste um consumidor concorrente: ele roubaria a mensagem
 * do consumer sob teste e, numa fila FIFO, manteria o grupo inteiro invisivel
 * enquanto a segurasse. Era exatamente o que tornava o teste de deduplicacao
 * instavel.
 */
export async function contaNaFila(url: string): Promise<number> {
  const resposta = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  const visiveis = Number(resposta.Attributes?.["ApproximateNumberOfMessages"] ?? "0");
  const emVoo = Number(resposta.Attributes?.["ApproximateNumberOfMessagesNotVisible"] ?? "0");
  return visiveis + emVoo;
}

export async function aguardaAte(
  condicao: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condicao nao satisfeita dentro do tempo");
}
