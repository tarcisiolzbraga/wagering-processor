import { EntitySchema } from "@mikro-orm/core";

import { MoneyAmountType } from "../money-amount.type";

export class WalletEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

/**
 * `version` NAO usa `version: true` do MikroORM de proposito. O versionamento
 * automatico incrementa a cada update, e a regra do dominio e que `version`
 * incrementa **somente quando o saldo muda** — um LOSS toca updatedAt sem mover
 * dinheiro. O controle fica no `UPDATE ... WHERE version = $antiga`, explicito.
 */
export const walletSchema = new EntitySchema<WalletEntity>({
  class: WalletEntity,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    balanceAmount: { type: MoneyAmountType },
    version: { type: "integer" },
    createdAt: { type: "datetime" },
    updatedAt: { type: "datetime" },
  },
});
