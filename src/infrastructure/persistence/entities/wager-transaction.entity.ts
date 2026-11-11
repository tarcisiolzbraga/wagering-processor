import { EntitySchema } from "@mikro-orm/core";

import { MoneyAmountType } from "../money-amount.type";

export class WagerTransactionEntity {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  source!: string;
  moneyAmount!: string;
  moneyCurrency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  observedBalanceAmount!: string | null;
  referenceAttempts!: number;
  pendingReferenceSince!: Date | null;
  /** Quando o worker deve tentar resolver a referencia de novo. */
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

/**
 * `columnType` aponta para os enums nativos do PostgreSQL criados na migration:
 * o banco recusa valor fora do vocabulario, e nao apenas o codigo.
 */
export const wagerTransactionSchema = new EntitySchema<WagerTransactionEntity>({
  class: WagerTransactionEntity,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string", columnType: "wager_transaction_kind" },
    source: { type: "string", columnType: "wager_transaction_source" },
    moneyAmount: { type: MoneyAmountType },
    moneyCurrency: { type: "string", length: 3 },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string", columnType: "wager_transaction_status" },
    failureCode: { type: "string", nullable: true },
    observedBalanceAmount: { type: MoneyAmountType, nullable: true },
    referenceAttempts: { type: "integer" },
    pendingReferenceSince: { type: "datetime", nullable: true },
    nextReferenceAttemptAt: { type: "datetime", nullable: true },
    createdAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});
