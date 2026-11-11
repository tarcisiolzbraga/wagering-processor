import type { LoggerService } from "@nestjs/common";

import type { LogFields, Logger } from "../../application/ports/logger";

/**
 * Ponte entre o logger do Nest e o nosso.
 *
 * Sem ela, metade do que o processo escreve sai em prosa colorida — o Nest
 * imprime o mapeamento de rotas com ANSI — e metade em JSON. Agregador de log
 * nao parseia a primeira metade, entao a afirmacao "logs estruturados em JSON"
 * so vale se **todas** as linhas passarem por aqui.
 */
export class NestLoggerBridge implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.logger.info(texto(message), campos(rest));
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.logger.error(texto(message), campos(rest));
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.logger.warn(texto(message), campos(rest));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.logger.debug(texto(message), campos(rest));
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.logger.debug(texto(message), campos(rest));
  }
}

function texto(message: unknown): string {
  return typeof message === "string" ? message : JSON.stringify(message);
}

/**
 * O Nest passa o contexto como ultimo argumento posicional (`"RouterExplorer"`,
 * `"NestApplication"`). Virar campo nomeado e o que permite filtrar por ele.
 */
function campos(rest: unknown[]): LogFields {
  const contexto = rest.at(-1);
  return typeof contexto === "string" ? { nest: contexto } : {};
}
