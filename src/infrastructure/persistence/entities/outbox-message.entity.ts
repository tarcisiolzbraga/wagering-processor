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
  /**
   * Lease de publicacao. Vive so na persistencia: e coordenacao entre workers,
   * nao conceito de dominio — `OutboxMessage` nao sabe que existe.
   */
  lockedUntil!: Date | null;
  lockedBy!: string | null;
  /** Desistiu: nunca vai publicar. Sai da fila e da metrica de lag. */
  abandonedAt!: Date | null;
  lastError!: string | null;
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
    lockedUntil: { type: "datetime", nullable: true },
    lockedBy: { type: "string", nullable: true },
    abandonedAt: { type: "datetime", nullable: true },
    lastError: { type: "string", nullable: true },
  },
});
