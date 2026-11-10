import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";

import type {
  EventPublisher,
  PublishOutcome,
} from "../../application/ports/event-publisher";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";

/** Limite do SendMessageBatch do SQS. */
export const MAX_BATCH = 10;

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    if (messages.length === 0) return { publishedIds: [], failures: [] };

    const publishedIds: string[] = [];
    const failures: Array<{ id: string; reason: string }> = [];

    for (let i = 0; i < messages.length; i += MAX_BATCH) {
      const lote = messages.slice(i, i + MAX_BATCH);
      const resultado = await this.enviaLote(lote);
      publishedIds.push(...resultado.publishedIds);
      failures.push(...resultado.failures);
    }

    return { publishedIds, failures };
  }

  private async enviaLote(lote: readonly OutboxMessage[]): Promise<{
    publishedIds: string[];
    failures: Array<{ id: string; reason: string }>;
  }> {
    try {
      const resposta = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: lote.map((mensagem) => ({
            // O id do eventId e UUID: cabe no formato de Id de entrada.
            Id: mensagem.id,
            MessageBody: JSON.stringify(mensagem.payload),
            // Agrupado pela carteira: preserva a ordem relativa dos eventos de
            // uma mesma conta.
            MessageGroupId: mensagem.partitionKey,
            // O eventId como id de deduplicacao da, de graca, uma segunda rede
            // contra publicacao duplicada dentro da janela do broker. A rede
            // principal continua sendo a deduplicacao do consumidor.
            MessageDeduplicationId: mensagem.id,
            MessageAttributes: {
              eventType: { DataType: "String", StringValue: mensagem.eventType },
              aggregateId: { DataType: "String", StringValue: mensagem.aggregateId },
            },
          })),
        }),
      );

      const publishedIds = (resposta.Successful ?? [])
        .map((entrada) => entrada.Id)
        .filter((id): id is string => id !== undefined);

      const failures = (resposta.Failed ?? []).flatMap((entrada) =>
        entrada.Id === undefined
          ? []
          : [{ id: entrada.Id, reason: entrada.Message ?? entrada.Code ?? "falha no envio" }],
      );

      return { publishedIds, failures };
    } catch (erro: unknown) {
      // Falha da chamada inteira: nenhuma mensagem saiu. Todas voltam para
      // retry, em vez de ficarem presas com lease vencendo.
      const reason = erro instanceof Error ? erro.message : String(erro);
      return {
        publishedIds: [],
        failures: lote.map((mensagem) => ({ id: mensagem.id, reason })),
      };
    }
  }
}
