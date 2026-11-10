import type { FailureCode } from "./failure-code";

/** Raiz de tudo que o dominio rejeita. Nao estende nada de framework. */
export abstract class DomainError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Entrada que nao chega a virar objeto de dominio: moeda malformada, valor
 * com escala errada, payload sem campo obrigatorio. E 400, nao 422.
 */
export class InvalidInputError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Regra de negocio dizendo nao a uma operacao bem formada. Carrega um
 * FailureCode porque o provedor decide o que fazer a partir dele. E 422.
 */
export class DomainRuleViolationError extends DomainError {
  constructor(
    readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Invariante de agregado violada — ex.: debitar mais do que o saldo apos a
 * checagem ja ter passado, ou transicionar um estado terminal. Chegar aqui e
 * bug de programacao, nao caminho de negocio: silenciar esconderia a falha
 * exatamente na classe de problema que este sistema existe para evitar.
 */
export class InvariantViolationError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/** Tentativa de transicionar uma transacao que ja esta em estado terminal. */
export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(message: string) {
    super(message);
  }
}
