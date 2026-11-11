import type {
  DeadLetterReason,
  DuplicateKind,
  LockConflictReason,
  Metrics,
  RetrySubject,
  TransactionObservation,
} from "../../src/application/ports/metrics";

/**
 * Metrica que guarda o que foi observado.
 *
 * Existe para o teste poder afirmar **que** uma transacao foi contada, e não
 * só que o código chama o port. Uma transação aplicada fora da série é o tipo
 * de furo que nenhuma asserção de saldo pega.
 */
export class MetricsEspia implements Metrics {
  readonly contentType = "text/plain";
  readonly transacoes: TransactionObservation[] = [];
  readonly duplicatas: DuplicateKind[] = [];
  readonly retries: RetrySubject[] = [];
  readonly deadLetters: DeadLetterReason[] = [];
  readonly conflitos: LockConflictReason[] = [];
  readonly atrasos: number[] = [];
  divergencias = 0;

  transactionObserved(observation: TransactionObservation): void {
    this.transacoes.push(observation);
  }

  duplicateDetected(kind: DuplicateKind): void {
    this.duplicatas.push(kind);
  }

  retryScheduled(subject: RetrySubject): void {
    this.retries.push(subject);
  }

  deadLetterSent(reason: DeadLetterReason): void {
    this.deadLetters.push(reason);
  }

  lockConflictDetected(reason: LockConflictReason): void {
    this.conflitos.push(reason);
  }

  outboxLagObserved(ms: number): void {
    this.atrasos.push(ms);
  }

  reconciliationDivergenceDetected(): void {
    this.divergencias += 1;
  }

  async render(): Promise<string> {
    return "";
  }

  limpa(): void {
    this.transacoes.length = 0;
    this.duplicatas.length = 0;
    this.retries.length = 0;
    this.deadLetters.length = 0;
    this.conflitos.length = 0;
    this.atrasos.length = 0;
    this.divergencias = 0;
  }
}
