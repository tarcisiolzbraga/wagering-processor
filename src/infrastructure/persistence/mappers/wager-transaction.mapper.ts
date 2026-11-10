import { Money } from "../../../domain/money/money";
import { FailureCode } from "../../../domain/shared/failure-code";
import {
  WagerTransactionKind,
  WagerTransactionSource,
} from "../../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";
import { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { WagerTransactionEntity } from "../entities/wager-transaction.entity";
import { asEnum } from "./enum-guard";
import { toNull, toUndefined } from "./nullable";

export const WagerTransactionMapper = {
  toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const currency = entity.moneyCurrency;
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: asEnum(WagerTransactionKind, entity.kind, "kind", entity.id),
      source: asEnum(WagerTransactionSource, entity.source, "source", entity.id),
      money: Money.from({ amount: entity.moneyAmount, currency }),
      referenceExternalTransactionId: toUndefined(entity.referenceExternalTransactionId),
      createdAt: entity.createdAt,
      status: asEnum(WagerTransactionStatus, entity.status, "status", entity.id),
      referenceTransactionId: toUndefined(entity.referenceTransactionId),
      failureCode:
        entity.failureCode === null
          ? undefined
          : asEnum(FailureCode, entity.failureCode, "failure_code", entity.id),
      processedAt: toUndefined(entity.processedAt),
      observedBalance:
        entity.observedBalanceAmount === null
          ? undefined
          : Money.from({ amount: entity.observedBalanceAmount, currency }),
      referenceAttempts: entity.referenceAttempts,
      pendingReferenceSince: toUndefined(entity.pendingReferenceSince),
    });
  },

  toEntity(
    tx: WagerTransaction,
    into: WagerTransactionEntity = new WagerTransactionEntity(),
  ): WagerTransactionEntity {
    const money = tx.money.toJSON();
    into.id = tx.id;
    into.providerId = tx.providerId;
    into.externalTransactionId = tx.externalTransactionId;
    into.idempotencyKey = tx.idempotencyKey;
    into.payloadHash = tx.payloadHash;
    into.walletId = tx.walletId;
    into.playerId = tx.playerId;
    into.roundId = tx.roundId;
    into.gameId = tx.gameId;
    into.kind = tx.kind;
    into.source = tx.source;
    into.moneyAmount = money.amount;
    into.moneyCurrency = money.currency;
    into.referenceExternalTransactionId = toNull(tx.referenceExternalTransactionId);
    into.referenceTransactionId = toNull(tx.referenceTransactionId);
    into.status = tx.status;
    into.failureCode = toNull(tx.failureCode);
    into.observedBalanceAmount = toNull(tx.observedBalance?.toJSON().amount);
    into.referenceAttempts = tx.referenceAttempts;
    into.pendingReferenceSince = toNull(tx.pendingReferenceSince);
    into.createdAt = tx.createdAt;
    into.processedAt = toNull(tx.processedAt);
    return into;
  },
};
