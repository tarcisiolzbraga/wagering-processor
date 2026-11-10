import { Money } from "../../../domain/money/money";
import { Wallet } from "../../../domain/wallet/wallet";
import { WalletEntity } from "../entities/wallet.entity";

export const WalletMapper = {
  toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({ amount: entity.balanceAmount, currency: entity.currency }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  },

  toEntity(wallet: Wallet, into: WalletEntity = new WalletEntity()): WalletEntity {
    const balance = wallet.balance.toJSON();
    into.id = wallet.id;
    into.playerId = wallet.playerId;
    into.currency = wallet.currency;
    into.balanceAmount = balance.amount;
    into.version = wallet.version;
    into.createdAt = wallet.createdAt;
    into.updatedAt = wallet.updatedAt;
    return into;
  },
};
