import Decimal from "decimal.js";

import { DomainRuleViolationError, InvalidInputError } from "../shared/domain-error";
import { FailureCode } from "../shared/failure-code";

/** DTO de fronteira — interface e adequada aqui. */
export interface MoneyProps {
  readonly amount: string; // string decimal, ex.: "25.00"
  readonly currency: string; // ISO-4217
}

/**
 * Decimal configurado localmente: o resto do codigo nunca toca decimal.js.
 * HALF_UP e a convencao financeira; os expoentes largos garantem que toString
 * nunca escorregue para notacao cientifica.
 */
const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

const SCALE = 2;
/** NUMERIC(20,2) guarda 18 digitos antes da virgula. */
const MAX_INTEGER_DIGITS = 18;

/** 10^18: o primeiro valor que NUMERIC(20,2) nao consegue guardar. */
const CAPACITY = new D(10).pow(MAX_INTEGER_DIGITS);

const DECIMAL_SHAPE = /^-?\d+(\.\d+)?$/;
const CURRENCY_SHAPE = /^[A-Z]{3}$/;

/**
 * Dinheiro. Imutavel: toda operacao devolve nova instancia.
 *
 * `from` rejeita valor negativo porque em contrato de entrada o sinal e decisao
 * do dominio (a direcao do lancamento), nao do provedor. Internamente valores
 * negativos existem — e assim que `subtract` sinaliza saldo insuficiente.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    const value = Money.parseAmount(props.amount);

    if (value.isNegative()) {
      throw new InvalidInputError(
        `valor monetario negativo nao e aceito em contrato de entrada: "${props.amount}"`,
      );
    }

    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return new Money(new D(0), Money.parseCurrency(currency));
  }

  /**
   * Construcao interna: aceita negativo, usada pelas operacoes.
   *
   * Verifica a capacidade tambem aqui, e nao so na entrada: sem isso uma soma
   * poderia passar por todo o dominio e morrer no INSERT com 22003, o que
   * seria lido como falha transitoria e viraria loop de retry.
   */
  private static of(value: Decimal, currency: string): Money {
    if (value.abs().greaterThanOrEqualTo(CAPACITY)) {
      throw new DomainRuleViolationError(
        FailureCode.AmountOverflow,
        `valor computado ${value.toFixed(2)} excede a capacidade de NUMERIC(20,2)`,
      );
    }
    return new Money(value, currency);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_SHAPE.test(currency)) {
      throw new InvalidInputError(
        `moeda invalida: esperado ISO-4217 com 3 letras maiusculas, recebido ${JSON.stringify(currency)}`,
      );
    }
    return currency;
  }

  private static parseAmount(amount: unknown): Decimal {
    if (typeof amount !== "string") {
      throw new InvalidInputError(
        `valor monetario deve ser string decimal, recebido ${typeof amount}`,
      );
    }
    if (amount.length === 0) {
      throw new InvalidInputError("valor monetario vazio");
    }
    // Barra de uma vez NaN, Infinity, notacao cientifica, espacos e lixo.
    if (!DECIMAL_SHAPE.test(amount)) {
      throw new InvalidInputError(
        `valor monetario malformado: "${amount}" (esperado string decimal simples, sem notacao cientifica)`,
      );
    }

    const [integerPart = "", fractionPart = ""] = amount.replace("-", "").split(".");
    if (fractionPart.length > SCALE) {
      throw new InvalidInputError(
        `valor monetario com ${fractionPart.length} casas decimais: "${amount}" (maximo ${SCALE}) — arredondar em silencio inventaria dinheiro`,
      );
    }
    if (integerPart.replace(/^0+(?=\d)/, "").length > MAX_INTEGER_DIGITS) {
      throw new InvalidInputError(
        `valor monetario excede ${MAX_INTEGER_DIGITS} digitos inteiros: "${amount}"`,
      );
    }

    const value = new D(amount);
    if (!value.isFinite()) {
      throw new InvalidInputError(`valor monetario nao finito: "${amount}"`);
    }
    return value;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new InvalidInputError(
        `operacao entre moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }
}
