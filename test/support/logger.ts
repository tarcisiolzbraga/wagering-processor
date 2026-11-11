import type { LogFields, Logger } from "../../src/application/ports/logger";

/** Logger que nao escreve: o teste nao e lugar de ruido em stdout. */
export const loggerMudo: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => loggerMudo,
};

export interface LinhaDeLog {
  readonly nivel: "debug" | "info" | "warn" | "error";
  readonly mensagem: string;
  readonly campos: LogFields;
}

/**
 * Logger que guarda o que foi registrado, para o teste poder afirmar sobre o
 * log — campo de correlacao presente, nivel certo — em vez de so confiar que
 * a chamada existe.
 */
export function loggerQueGrava(linhas: LinhaDeLog[] = [], fixos: LogFields = {}): Logger {
  const grava =
    (nivel: LinhaDeLog["nivel"]) =>
    (mensagem: string, campos: LogFields = {}): void =>
      void linhas.push({ nivel, mensagem, campos: { ...fixos, ...campos } });

  return {
    debug: grava("debug"),
    info: grava("info"),
    warn: grava("warn"),
    error: grava("error"),
    child: (campos) => loggerQueGrava(linhas, { ...fixos, ...campos }),
  };
}
