import { hostname } from "node:os";

import pino from "pino";

import type { LogFields, Logger } from "../../application/ports/logger";

/**
 * Caminhos redigidos.
 *
 * O enunciado proibe dado sensivel e payload financeiro completo no log, e log
 * vaza para agregador, backup e print em chamada. A redacao e rede de
 * seguranca: os call sites hoje nao mandam valor monetario, mas um campo novo
 * adicionado sem atencao passaria batido sem isso.
 */
const REDACTED = [
  "money",
  "balance",
  "balanceBefore",
  "balanceAfter",
  "amount",
  "payload",
  "initialBalance",
  "observedBalance",
  // Campos da reconciliacao: `difference` e a diferenca em dinheiro entre o
  // saldo materializado e o ledger.
  "difference",
  "expected",
  "actual",
  "*.money",
  "*.balance",
  "*.balanceBefore",
  "*.balanceAfter",
  "*.amount",
  "*.payload",
  "*.initialBalance",
  "*.observedBalance",
  "*.difference",
  "*.expected",
  "*.actual",
];

export class PinoLogger implements Logger {
  private constructor(private readonly base: pino.Logger) {}

  /**
   * `destination` existe para o teste poder ler o que foi escrito. Sem ele a
   * redacao seria uma afirmacao no comentario, nao uma garantia verificada.
   */
  static create(
    level: string,
    bindings: LogFields = {},
    destination?: pino.DestinationStream,
  ): PinoLogger {
    const opcoes: pino.LoggerOptions = {
      level,
      // `base` substitui o default do pino, que inclui o hostname. Sem ele, as
      // tres replicas de API logam `role=api, pid=1` — em container o pid e
      // sempre 1 — e ficam indistinguiveis na investigacao.
      base: { hostname: hostname(), ...bindings },
      // ISO em vez do epoch default: o log e lido por humano investigando
      // incidente, nao so por maquina.
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACTED, censor: "[redigido]" },
      formatters: {
        level: (label) => ({ level: label }),
      },
    };

    return new PinoLogger(
      destination === undefined ? pino(opcoes) : pino(opcoes, destination),
    );
  }

  child(fields: LogFields): Logger {
    return new PinoLogger(this.base.child(fields));
  }

  debug(message: string, fields?: LogFields): void {
    this.base.debug(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.base.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.base.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.base.error(fields ?? {}, message);
  }
}
