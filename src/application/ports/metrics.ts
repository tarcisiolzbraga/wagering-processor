import type { FailureCode } from "../../domain/shared/failure-code";
import type {
  WagerTransactionKind,
  WagerTransactionSource,
} from "../../domain/wagering/wager-transaction-kind";

/** Onde a duplicata foi detectada. Cada uma significa uma coisa diferente. */
export type DuplicateKind =
  /** Mesma idempotency key, mesmo payload: replay legitimo. */
  | "idempotency_replay"
  /** Mesma key, payload diferente: bug do provedor. */
  | "idempotency_conflict"
  /** Mesma operacao reapresentada com outra key. */
  | "external_transaction"
  /** Mensagem da fila ja processada, barrada pela inbox. */
  | "inbox_message";

/** O que esta sendo retentado. */
export type RetrySubject = "queue_message" | "outbox_event" | "reference_resolution";

/**
 * Por que houve contencao. Separados de proposito: `version_mismatch` e
 * **deteccao** de um caminho que esqueceu o lock, enquanto `deadlock` e
 * `serialization` sao o banco interrompendo concorrencia real. Colapsar os dois
 * esconderia um bug de codigo dentro do ruido de carga.
 */
export type LockConflictReason = "version_mismatch" | "deadlock" | "serialization";

/**
 * Por que a mensagem acabou na dead-letter. `delivery_limit` e o redrive do
 * broker: a mensagem esgotou as entregas e o SQS a move, sem passar por nos.
 */
export type DeadLetterReason = "invalid_envelope" | "permanent_failure" | "delivery_limit";

export interface TransactionObservation {
  readonly outcome: string;
  readonly kind: WagerTransactionKind | "unknown";
  readonly source: WagerTransactionSource;
  readonly failureCode?: FailureCode | undefined;
  readonly durationMs: number;
}

/**
 * Metricas com vocabulario de dominio, nao `counter(name, labels)` genérico.
 *
 * O call site fica legivel e a lista de series e fechada: nao da para criar uma
 * metrica nova por acidente de digitacao, e renomear uma serie e uma mudanca de
 * tipo, nao uma busca por string.
 */
export interface Metrics {
  /** Transacoes por status e latencia de processamento, de uma vez. */
  transactionObserved(observation: TransactionObservation): void;

  duplicateDetected(kind: DuplicateKind): void;
  retryScheduled(subject: RetrySubject): void;
  /**
   * Motivo **categorizado**, nao a mensagem de erro: label de cardinalidade
   * ilimitada explode a serie temporal no Prometheus. A mensagem fica no log,
   * onde cardinalidade nao custa nada.
   */
  deadLetterSent(reason: DeadLetterReason): void;
  lockConflictDetected(reason: LockConflictReason): void;

  /** Idade da pendencia mais antiga da outbox. */
  outboxLagObserved(ms: number): void;

  /**
   * Saldo materializado divergiu do ledger. Nunca deveria incrementar: se
   * incrementar uma vez, o invariante central do sistema foi violado e o alerta
   * tem que acordar alguem.
   */
  reconciliationDivergenceDetected(): void;

  /** Exposicao no formato de texto do Prometheus. */
  render(): Promise<string>;
  readonly contentType: string;
}

export const METRICS = Symbol("METRICS");
