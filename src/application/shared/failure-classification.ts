import {
  DomainRuleViolationError,
  InvalidInputError,
  InvariantViolationError,
} from "../../domain/shared/domain-error";

export enum FailureKind {
  /** Regra de negocio disse nao. Terminal: reenviar nao muda o resultado. */
  Business = "BUSINESS",
  /** Vai funcionar depois: banco indisponivel, deadlock, timeout. */
  Transient = "TRANSIENT",
  /** Retry nunca resolve: payload malformado, invariante violada. */
  Permanent = "PERMANENT",
}

/**
 * SQLSTATEs que significam "tente de novo".
 *
 * - 40001 serialization_failure, 40P01 deadlock_detected
 * - 08xxx falha de conexao
 * - 53xxx recursos insuficientes (conexoes, memoria, disco)
 * - 55P03 lock_not_available
 * - 57P01/57P02/57P03 shutdown e restart do servidor
 */
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57P01", "57P02", "57P03"]);
const TRANSIENT_PREFIXES = ["08", "53"];

/**
 * Erros de socket do Node. Sao transitorios por natureza, e precisam ser
 * reconhecidos **antes** da checagem de SQLSTATE: `EPIPE` tem exatamente 5
 * caracteres de [0-9A-Z] e passava pelo teste de SQLSTATE, sendo classificado
 * como permanente. Resultado: um socket de banco caindo virava 500 com
 * `retryable: false`, e DLQ em vez de retry no consumer. `ECONNRESET` e
 * `ETIMEDOUT` escapavam por serem mais longos — o que tornava o furo facil de
 * nao ver.
 */
const TRANSIENT_SYSCALLS = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** Classes de SQLSTATE que o PostgreSQL de fato usa. */
const SQLSTATE_CLASSES = new Set([
  "00", "01", "02", "03", "08", "09", "0A", "0B", "0F", "0L", "0P", "0Z",
  "20", "21", "22", "23", "24", "25", "26", "27", "28", "2B", "2D", "2F",
  "34", "38", "39", "3B", "3D", "3F", "40", "42", "44",
  "53", "54", "55", "57", "58", "72", "F0", "HV", "P0", "XX",
]);

function codigosDe(error: unknown): string[] {
  const candidatos: unknown[] = [
    error,
    (error as { previous?: unknown } | null)?.previous,
    (error as { cause?: unknown } | null)?.cause,
  ];
  return candidatos
    .map((candidato) => (candidato as { code?: unknown } | null | undefined)?.code)
    .filter((code): code is string => typeof code === "string");
}

function sqlState(codigos: readonly string[]): string | undefined {
  return codigos.find(
    (code) => /^[0-9A-Z]{5}$/.test(code) && SQLSTATE_CLASSES.has(code.slice(0, 2)),
  );
}

/**
 * Classificacao usada pelos **dois** canais de entrada: a API traduz para
 * status HTTP, o consumer decide entre ack, retry e DLQ. Colapsar as tres
 * classes e o erro classico — rejeicao de negocio voltando para a fila para
 * sempre, ou falha transitoria indo para a DLQ.
 *
 * Erro desconhecido cai em **transitorio**: dar retry a algo que talvez
 * funcione e preferivel a descartar algo que talvez fosse importante, e o
 * limite de tentativas da fila impede o loop infinito.
 */
export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof DomainRuleViolationError) return FailureKind.Business;
  if (error instanceof InvalidInputError) return FailureKind.Permanent;
  if (error instanceof InvariantViolationError) return FailureKind.Permanent;

  const codigos = codigosDe(error);
  if (codigos.some((code) => TRANSIENT_SYSCALLS.has(code))) {
    return FailureKind.Transient;
  }

  const state = sqlState(codigos);
  if (state !== undefined) {
    if (TRANSIENT_SQLSTATES.has(state)) return FailureKind.Transient;
    if (TRANSIENT_PREFIXES.some((prefixo) => state.startsWith(prefixo))) {
      return FailureKind.Transient;
    }
    // Qualquer outro SQLSTATE e erro de programacao ou de dado: constraint
    // violada, tipo invalido, coluna inexistente. Retry nao resolve.
    return FailureKind.Permanent;
  }

  return FailureKind.Transient;
}
