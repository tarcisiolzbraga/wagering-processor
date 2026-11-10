import type { MoneyProps } from "../../domain/money/money";
import type { ReconciliationAlarm } from "../ports/reconciliation-alarm";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface ReconcileWalletResult {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * Compara o saldo materializado com o saldo reconstruido pelo ledger.
 *
 * Roda dentro de `read()`, que e REPEATABLE READ: as duas leituras precisam
 * ver o **mesmo snapshot**, senao uma aposta commitando entre elas produziria
 * divergencia falsa. Alarme financeiro falso e pior que nenhum alarme, porque
 * ensina a ignorar o alarme.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly alarm: ReconciliationAlarm,
  ) {}

  async run(walletId: string): Promise<ReconcileWalletResult | undefined> {
    const resultado = await this.uow.read(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) return undefined;

      const calculated = await ctx.ledger.reconstructBalance(walletId, wallet.currency);
      const checkedEntries = await ctx.ledger.countEntries(walletId);
      const difference = wallet.balance.subtract(calculated);

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries,
      };
    });

    if (resultado && !resultado.consistent) {
      this.alarm.divergenceDetected({
        walletId: resultado.walletId,
        storedBalance: resultado.storedBalance,
        calculatedBalance: resultado.calculatedBalance,
        difference: resultado.difference,
        checkedEntries: resultado.checkedEntries,
      });
    }

    return resultado;
  }
}
