import { EntitySchema } from "@mikro-orm/core";

export class OutboxMessageEntity {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  partitionKey!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const outboxMessageSchema = new EntitySchema<OutboxMessageEntity>({
  class: OutboxMessageEntity,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string" },
    partitionKey: { type: "string" },
    payload: { type: "json" },
    occurredAt: { type: "datetime" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", nullable: true },
    publishedAt: { type: "datetime", nullable: true },
  },
});
