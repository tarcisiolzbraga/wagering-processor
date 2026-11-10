import type { MoneyProps } from "../../domain/money/money";
import type { FailureCode } from "../../domain/shared/failure-code";
import type { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";
import type { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface WagerTransactionView {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | undefined;
  readonly referenceExternalTransactionId: string | undefined;
  readonly balance: MoneyProps | undefined;
  readonly createdAt: string;
  readonly processedAt: string | undefined;
}

function toView(tx: WagerTransaction): WagerTransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    playerId: tx.playerId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    /** Saldo observado no momento terminal — o mesmo que o replay devolve. */
    balance: tx.observedBalance?.toJSON(),
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString(),
  };
}

export class WagerTransactionQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView | undefined> {
    return this.uow.read(async (ctx) => {
      const tx = await ctx.transactions.findById(transactionId);
      return tx ? toView(tx) : undefined;
    });
  }

  async byProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView | undefined> {
    return this.uow.read(async (ctx) => {
      const tx = await ctx.transactions.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );
      return tx ? toView(tx) : undefined;
    });
  }
}
