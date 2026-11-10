import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";

import type { MessageQueue, QueueMessage } from "../../application/ports/message-queue";

/** Limite do SQS para valor de atributo de mensagem. */
const MAX_REASON_LENGTH = 256;

export class SqsMessageQueue implements MessageQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly deadLetterUrl: string,
  ) {}

  async receive(max: number, waitSeconds: number): Promise<readonly QueueMessage[]> {
    const resposta = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        // Precisamos da contagem de entregas para saber quando o retry parou
        // de ajudar.
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
    );

    return (resposta.Messages ?? []).flatMap((mensagem) => {
      if (!mensagem.ReceiptHandle || !mensagem.MessageId) return [];
      return [
        {
          receiptHandle: mensagem.ReceiptHandle,
          brokerMessageId: mensagem.MessageId,
          body: mensagem.Body ?? "",
          receiveCount: Number(mensagem.Attributes?.["ApproximateReceiveCount"] ?? "1"),
          groupId: mensagem.Attributes?.["MessageGroupId"],
        },
      ];
    });
  }

  async ack(message: QueueMessage): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.receiptHandle,
      }),
    );
  }

  async releaseVisibility(message: QueueMessage, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /**
   * Envia para a DLQ e **depois** dá ack na original — nessa ordem. O
   * contrario perderia a mensagem se o envio falhasse.
   *
   * A DLQ e FIFO sem deduplicacao por conteudo, entao o id de deduplicacao e
   * obrigatorio; o id do broker serve, por ser unico por mensagem.
   */
  async sendToDeadLetter(message: QueueMessage, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.deadLetterUrl,
        MessageBody: message.body,
        MessageGroupId: message.brokerMessageId,
        MessageDeduplicationId: message.brokerMessageId,
        MessageAttributes: {
          failureReason: {
            DataType: "String",
            StringValue: reason.slice(0, MAX_REASON_LENGTH),
          },
          originalMessageId: { DataType: "String", StringValue: message.brokerMessageId },
          receiveCount: { DataType: "Number", StringValue: String(message.receiveCount) },
        },
      }),
    );
    await this.ack(message);
  }
}
