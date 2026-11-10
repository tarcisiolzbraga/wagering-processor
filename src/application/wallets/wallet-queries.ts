import type { MoneyProps } from "../../domain/money/money";
import type { LedgerDirection } from "../../domain/wallet/ledger-direction";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: string;
}

export interface LedgerPageView {
  readonly entries: readonly LedgerEntryView[];
  readonly nextCursor: string | undefined;
}

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(walletId: string): Promise<WalletView | undefined> {
    return this.uow.read(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) return undefined;
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  async ledger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPageView> {
    return this.uow.read(async (ctx) => {
      const pagina = await ctx.ledger.page(walletId, cursor, limit);
      return {
        entries: pagina.entries.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: pagina.nextCursor,
      };
    });
  }
}
