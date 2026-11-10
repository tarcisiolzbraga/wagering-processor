export type LogFields = Record<string, unknown>;

/**
 * Log estruturado. Os campos de correlacao — `correlationId`, `messageId`,
 * `transactionId`, `walletId`, `providerId` — sao o que permite seguir **uma**
 * operacao por HTTP, outbox, SQS e consumer. Sem eles, investigar um incidente
 * financeiro e costurar logs de tres sistemas sem ligacao.
 *
 * Nunca recebe payload financeiro completo: log vaza para agregador, backup e
 * print em chamada.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Novo logger com campos fixos, herdados por toda chamada. */
  child(fields: LogFields): Logger;
}

export const LOGGER = Symbol("LOGGER");
