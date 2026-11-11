import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

import type {
  DeadLetterReason,
  DuplicateKind,
  LockConflictReason,
  Metrics,
  RetrySubject,
  TransactionObservation,
} from "../../application/ports/metrics";

/**
 * Buckets em segundos. Escolhidos em torno do caminho financeiro real: a
 * operacao tipica fica em dezenas de milissegundos, e o que interessa observar
 * e a cauda — contencao no lock de uma carteira quente aparece nos buckets de
 * centenas de ms, nao no p50.
 */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export class PrometheusMetrics implements Metrics {
  readonly contentType: string;
  private readonly registry = new Registry();

  private readonly transactions: Counter<"outcome" | "kind" | "source" | "failure_code">;
  private readonly duration: Histogram<"outcome" | "source">;
  private readonly duplicates: Counter<"kind">;
  private readonly retries: Counter<"subject">;
  private readonly deadLetters: Counter<"reason">;
  private readonly lockConflicts: Counter<"reason">;
  private readonly divergences: Counter<string>;
  /**
   * Criado na primeira observacao, nao no construtor.
   *
   * Um gauge registrado nasce em zero, e os papeis que nunca publicam a outbox
   * exportariam `wager_outbox_lag_seconds 0` para sempre — um alerta em `avg`
   * ou `min` sobre a serie que existe para expor publisher parado leria ~0 por
   * causa deles. Serie que nao se aplica ao processo nao deve existir nele.
   */
  private outboxLag?: Gauge<string>;

  constructor(role: string, collectProcessMetrics = true) {
    this.registry.setDefaultLabels({ role });
    this.contentType = this.registry.contentType;

    this.transactions = new Counter({
      name: "wager_transactions_total",
      help: "Transacoes por desfecho, tipo, origem e codigo de falha",
      labelNames: ["outcome", "kind", "source", "failure_code"],
      registers: [this.registry],
    });

    this.duration = new Histogram({
      name: "wager_transaction_duration_seconds",
      help: "Latencia de processamento de uma transacao",
      // Por origem tambem: a latencia do consumer e da API tem causas
      // diferentes, e sem o label a cauda de uma fica escondida atras do
      // volume da outra.
      labelNames: ["outcome", "source"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.duplicates = new Counter({
      name: "wager_duplicates_total",
      help: "Duplicatas detectadas, por onde foram detectadas",
      labelNames: ["kind"],
      registers: [this.registry],
    });

    this.retries = new Counter({
      name: "wager_retries_total",
      help: "Retentativas agendadas, por assunto",
      labelNames: ["subject"],
      registers: [this.registry],
    });

    this.deadLetters = new Counter({
      name: "wager_dead_letter_total",
      help: "Mensagens enviadas para a dead-letter",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    this.lockConflicts = new Counter({
      name: "wager_lock_conflicts_total",
      help: "Contencao detectada, por causa",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    this.divergences = new Counter({
      name: "wager_reconciliation_divergences_total",
      help: "Divergencias entre saldo materializado e ledger",
      registers: [this.registry],
    });

    if (collectProcessMetrics) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  transactionObserved(observation: TransactionObservation): void {
    this.transactions.inc({
      outcome: observation.outcome,
      kind: observation.kind,
      source: observation.source,
      // Label vazio em vez de ausente: serie com conjunto de labels variavel
      // fica mais dificil de agregar em consulta.
      failure_code: observation.failureCode ?? "none",
    });
    this.duration.observe(
      { outcome: observation.outcome, source: observation.source },
      observation.durationMs / 1000,
    );
  }

  duplicateDetected(kind: DuplicateKind): void {
    this.duplicates.inc({ kind });
  }

  retryScheduled(subject: RetrySubject): void {
    this.retries.inc({ subject });
  }

  deadLetterSent(reason: DeadLetterReason): void {
    this.deadLetters.inc({ reason });
  }

  lockConflictDetected(reason: LockConflictReason): void {
    this.lockConflicts.inc({ reason });
  }

  outboxLagObserved(ms: number): void {
    this.outboxLag ??= new Gauge({
      name: "wager_outbox_lag_seconds",
      help: "Idade da pendencia mais antiga da outbox",
      registers: [this.registry],
    });
    this.outboxLag.set(ms / 1000);
  }

  reconciliationDivergenceDetected(): void {
    this.divergences.inc();
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}

/** Implementacao vazia, para teste e para caminhos sem observabilidade. */
export class NoopMetrics implements Metrics {
  readonly contentType = "text/plain";
  transactionObserved(): void {}
  duplicateDetected(): void {}
  retryScheduled(): void {}
  deadLetterSent(): void {}
  lockConflictDetected(): void {}
  outboxLagObserved(): void {}
  reconciliationDivergenceDetected(): void {}
  async render(): Promise<string> {
    return "";
  }
}
