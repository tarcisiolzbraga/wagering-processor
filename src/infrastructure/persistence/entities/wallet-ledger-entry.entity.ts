import { EntitySchema } from "@mikro-orm/core";

import { MoneyAmountType } from "../money-amount.type";

export class WalletLedgerEntryEntity {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  moneyAmount!: string;
  moneyCurrency!: string;
  balanceBeforeAmount!: string;
  balanceAfterAmount!: string;
  createdAt!: Date;
}

/** Append-only no banco: triggers recusam UPDATE, DELETE e TRUNCATE. */
export const walletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryEntity>({
  class: WalletLedgerEntryEntity,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string", columnType: "ledger_direction" },
    moneyAmount: { type: MoneyAmountType },
    moneyCurrency: { type: "string", length: 3 },
    balanceBeforeAmount: { type: MoneyAmountType },
    balanceAfterAmount: { type: MoneyAmountType },
    createdAt: { type: "datetime" },
  },
});
