import type { LogFields, Logger } from "../../application/ports/logger";

type Nivel = "debug" | "info" | "warn" | "error";

const ORDEM: Readonly<Record<Nivel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logger JSON em uma linha por registro. Substituido por pino na Fase 9; o que
 * importa agora e que o contrato (`Logger`) e os campos de correlacao estejam
 * no lugar, para que a troca seja de implementacao e nao de todo call site.
 */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly nivelMinimo: Nivel = "info",
    private readonly fixos: LogFields = {},
  ) {}

  child(fields: LogFields): Logger {
    return new ConsoleLogger(this.nivelMinimo, { ...this.fixos, ...fields });
  }

  debug(message: string, fields?: LogFields): void {
    this.escreve("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.escreve("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.escreve("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.escreve("error", message, fields);
  }

  private escreve(nivel: Nivel, message: string, fields?: LogFields): void {
    if (ORDEM[nivel] < ORDEM[this.nivelMinimo]) return;

    const registro = JSON.stringify({
      level: nivel,
      time: new Date().toISOString(),
      msg: message,
      ...this.fixos,
      ...fields,
    });

    if (nivel === "error" || nivel === "warn") console.error(registro);
    else console.log(registro);
  }
}
