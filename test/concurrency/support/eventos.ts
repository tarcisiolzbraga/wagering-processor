import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";

import { loadEnv } from "../../../src/config/env";
import { sqs } from "../../support/sqs";

const EVENTS_URL = loadEnv().SQS_EVENTS_QUEUE_URL;

export interface EventoLido {
  readonly eventId: string;
  readonly eventType: string;
  readonly grupo: string | undefined;
}

export interface OpcoesDeDreno {
  /**
   * Quantos eventos o teste espera. Enquanto nao chegarem, continua lendo ate
   * o prazo — e so entao devolve o que tem, para a assercao falhar com o
   * numero real.
   */
  readonly esperando?: number;
  readonly prazoMs?: number;
}

/**
 * Drena a fila de eventos.
 *
 * Le **e apaga**: sem o delete, a mensagem volta quando o visibility timeout
 * expira, dentro de outro teste, e a contagem do proximo passa a incluir
 * evento de rodada anterior.
 *
 * Um `receive` vazio **nao** significa fila vazia: o short poll amostra um
 * subconjunto dos servidores. Parar no primeiro vazio deixaria evento para
 * tras — exatamente a contaminacao que este helper existe para evitar. Entao o
 * criterio de parada e a contagem esperada, ou varios vazios seguidos.
 */
export async function drenaEventos(opcoes: OpcoesDeDreno = {}): Promise<EventoLido[]> {
  const { esperando, prazoMs = 10_000 } = opcoes;
  const limite = Date.now() + prazoMs;
  const lidos: EventoLido[] = [];
  let vaziosSeguidos = 0;

  while (Date.now() < limite) {
    const resposta = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: EVENTS_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    const mensagens = resposta.Messages ?? [];
    if (mensagens.length === 0) {
      vaziosSeguidos += 1;
      // Sem contagem esperada, tres vazios seguidos com long poll de 1s e o
      // melhor sinal disponivel de que a fila acabou.
      if (esperando === undefined ? vaziosSeguidos >= 3 : lidos.length >= esperando) break;
      continue;
    }
    vaziosSeguidos = 0;

    for (const mensagem of mensagens) {
      const corpo = JSON.parse(mensagem.Body ?? "{}") as {
        eventId?: string;
        eventType?: string;
      };
      lidos.push({
        eventId: corpo.eventId ?? "",
        eventType: corpo.eventType ?? "",
        grupo: mensagem.Attributes?.["MessageGroupId"],
      });
      if (mensagem.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: EVENTS_URL, ReceiptHandle: mensagem.ReceiptHandle }),
        );
      }
    }

    if (esperando !== undefined && lidos.length >= esperando) break;
  }

  return lidos;
}
