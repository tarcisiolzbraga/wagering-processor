import { EntitySchema } from "@mikro-orm/core";

export class InboxMessageEntity {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

/** A deduplicacao e a propria chave primaria composta. */
export const inboxMessageSchema = new EntitySchema<InboxMessageEntity>({
  class: InboxMessageEntity,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string" },
    receivedAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});
