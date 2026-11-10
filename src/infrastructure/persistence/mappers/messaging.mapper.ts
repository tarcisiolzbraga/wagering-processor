import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { InboxMessageEntity } from "../entities/inbox-message.entity";
import { OutboxMessageEntity } from "../entities/outbox-message.entity";
import { toNull, toUndefined } from "./nullable";

export const InboxMessageMapper = {
  toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      processedAt: toUndefined(entity.processedAt),
    });
  },

  toEntity(
    message: InboxMessage,
    into: InboxMessageEntity = new InboxMessageEntity(),
  ): InboxMessageEntity {
    into.consumerName = message.consumerName;
    into.messageId = message.messageId;
    into.payloadHash = message.payloadHash;
    into.receivedAt = message.receivedAt;
    into.processedAt = toNull(message.processedAt);
    return into;
  },
};

export const OutboxMessageMapper = {
  toDomain(entity: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: entity.id,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      partitionKey: entity.partitionKey,
      payload: entity.payload,
      occurredAt: entity.occurredAt,
      attempts: entity.attempts,
      nextAttemptAt: toUndefined(entity.nextAttemptAt),
      publishedAt: toUndefined(entity.publishedAt),
    });
  },

  toEntity(
    message: OutboxMessage,
    into: OutboxMessageEntity = new OutboxMessageEntity(),
  ): OutboxMessageEntity {
    into.id = message.id;
    into.aggregateId = message.aggregateId;
    into.eventType = message.eventType;
    into.partitionKey = message.partitionKey;
    into.payload = message.payload as Record<string, unknown>;
    into.occurredAt = message.occurredAt;
    into.attempts = message.attempts;
    into.nextAttemptAt = toNull(message.nextAttemptAt);
    into.publishedAt = toNull(message.publishedAt);
    return into;
  },
};
