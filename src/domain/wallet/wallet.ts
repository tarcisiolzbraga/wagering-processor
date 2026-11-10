import { Money } from "../money/money";
import {
  DomainRuleViolationError,
  InvalidInputError,
  InvariantViolationError,
} from "../shared/domain-error";
import { FailureCode } from "../shared/failure-code";
import { assertIdentifier } from "../shared/identifier";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MovementProps {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  /** Obrigatorios quando o saldo inicial e maior que zero. */
  readonly openingTransactionId?: string | undefined;
  readonly openingEntryId?: string | undefined;
  readonly now?: Date | undefined;
}

export interface WalletOpening {
  readonly wallet: Wallet;
  /** undefined quando o saldo inicial e zero — nao ha o que lancar. */
  readonly openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Aggregate root. Saldo e ledger andam juntos por construcao: toda operacao
 * que move dinheiro **devolve** o lancamento correspondente, inclusive a
 * abertura. Nao existe caminho em que o saldo muda sem lancamento, e por isso
 * `wallet.balance` sempre reconstroi somando o ledger.
 *
 * `version` serve ao optimistic locking e **incrementa somente quando o saldo
 * muda** — e marcador de movimentacao, nao de escrita de linha. Um LOSS toca
 * updatedAt mas nao move dinheiro; se incrementasse version, um consumidor que
 * acompanha walletVersion veria uma mudanca de saldo que nao existiu.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet zerada e, quando ha saldo inicial, devolve junto o
   * lancamento de credito da abertura. A abertura **e** a criacao, nao uma
   * movimentacao posterior, entao `version` permanece 1.
   */
  static open(props: OpenWalletProps): WalletOpening {
    assertIdentifier("id", props.id);
    assertIdentifier("playerId", props.playerId);

    if (props.initialBalance.isNegative()) {
      throw new InvalidInputError(
        `wallet nao abre com saldo negativo: ${props.initialBalance.toString()}`,
      );
    }

    const now = props.now ?? new Date();
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      Money.zero(currency),
      1,
      now,
      now,
    );

    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    if (!props.openingTransactionId || !props.openingEntryId) {
      throw new InvariantViolationError(
        `abertura com saldo ${props.initialBalance.toString()} exige openingTransactionId e openingEntryId para o lancamento`,
      );
    }

    const openingEntry = wallet.apply(
      LedgerDirection.Credit,
      {
        entryId: props.openingEntryId,
        transactionId: props.openingTransactionId,
        money: props.initialBalance,
        at: now,
      },
      false,
    );

    return { wallet, openingEntry };
  }

  /** Reconstrucao a partir da persistencia — nao revalida transicoes. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Pergunta sem efeito colateral, para quem precisa decidir **qual**
   * FailureCode emitir: uma aposta sem saldo e InsufficientFunds, uma reversao
   * que nao cabe e ReversalWouldOverdraw. O agregado nao conhece essa
   * diferenca, e nao deveria.
   */
  hasSufficientBalance(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.subtract(money).isNegative();
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (!this.hasSufficientBalance(props.money)) {
      // Chegar aqui e bug: o caller tinha que ter checado e rejeitado com o
      // codigo certo. Lancar em vez de silenciar mantem o bug visivel.
      throw new InvariantViolationError(
        `debito de ${props.money.toString()} excede o saldo ${this._balance.toString()} da wallet ${this.id}`,
      );
    }
    return this.apply(LedgerDirection.Debit, props, true);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, props, true);
  }

  private apply(
    direction: LedgerDirection,
    props: MovementProps,
    countsAsMovement: boolean,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(props.money)
        : balanceBefore.subtract(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    if (countsAsMovement) {
      this._version += 1;
    }
    this._updatedAt = props.at;

    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvariantViolationError(
        `movimentacao com valor nao positivo: ${money.toString()}`,
      );
    }
  }

  /**
   * Conflito de moeda e regra de negocio, nao payload malformado: a requisicao
   * estava bem formada e foi compreendida — foi o dominio que disse nao. Por
   * isso carrega FailureCode e vira 422, nao 400.
   */
  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainRuleViolationError(
        FailureCode.CurrencyMismatch,
        `moeda da operacao (${money.currency}) difere da moeda da wallet (${this.currency})`,
      );
    }
  }
}
