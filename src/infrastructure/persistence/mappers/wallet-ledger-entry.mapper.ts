import { Money } from "../../../domain/money/money";
import { LedgerDirection } from "../../../domain/wallet/ledger-direction";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { WalletLedgerEntryEntity } from "../entities/wallet-ledger-entry.entity";
import { asEnum } from "./enum-guard";

export const WalletLedgerEntryMapper = {
  toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    const currency = entity.moneyCurrency;
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: asEnum(LedgerDirection, entity.direction, "direction", entity.id),
      money: Money.from({ amount: entity.moneyAmount, currency }),
      balanceBefore: Money.from({ amount: entity.balanceBeforeAmount, currency }),
      balanceAfter: Money.from({ amount: entity.balanceAfterAmount, currency }),
      createdAt: entity.createdAt,
    });
  },

  toEntity(
    entry: WalletLedgerEntry,
    into: WalletLedgerEntryEntity = new WalletLedgerEntryEntity(),
  ): WalletLedgerEntryEntity {
    into.id = entry.id;
    into.walletId = entry.walletId;
    into.transactionId = entry.transactionId;
    into.direction = entry.direction;
    into.moneyAmount = entry.money.toJSON().amount;
    into.moneyCurrency = entry.money.currency;
    into.balanceBeforeAmount = entry.balanceBefore.toJSON().amount;
    into.balanceAfterAmount = entry.balanceAfter.toJSON().amount;
    into.createdAt = entry.createdAt;
    return into;
  },
};
