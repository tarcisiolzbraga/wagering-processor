import { Money } from "../money/money";
import { InvariantViolationError } from "../shared/domain-error";
import { LedgerDirection } from "./ledger-direction";

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lancamento do ledger. Sem campo mutavel e sem metodo de transicao — a
 * imutabilidade e estrutural, nao uma convencao: um objeto sem setter nao
 * precisa de disciplina de quem o usa.
 *
 * `create` valida a aritmetica do lancamento. A mesma verificacao vira CHECK
 * no schema (Fase 2), porque o banco e o unico ponto por onde toda escrita
 * obrigatoriamente passa.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!props.money.isPositive()) {
      throw new InvariantViolationError(
        `lancamento com valor nao positivo (${props.money.toString()}): o sinal e a direction, nunca o valor`,
      );
    }
    const moedas = new Set([
      props.money.currency,
      props.balanceBefore.currency,
      props.balanceAfter.currency,
    ]);
    if (moedas.size > 1) {
      throw new InvariantViolationError(
        `lancamento mistura moedas: ${[...moedas].join(", ")}`,
      );
    }
    if (props.balanceAfter.isNegative()) {
      throw new InvariantViolationError(
        `lancamento deixaria saldo negativo: ${props.balanceAfter.toString()}`,
      );
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `aritmetica do lancamento nao fecha: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} deveria dar ${props.balanceAfter.toString()}`,
      );
    }

    return entry;
  }

  /** Reconstrucao a partir da persistencia — nao revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const esperado =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return esperado.equals(this.balanceAfter);
  }
}
