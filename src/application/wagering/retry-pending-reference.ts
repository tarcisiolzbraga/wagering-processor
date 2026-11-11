import { FailureCode } from "../../domain/shared/failure-code";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import {
  REFERENCE_MAX_ATTEMPTS,
  REFERENCE_TTL_MS,
  referenceBackoffDelayMs,
} from "../../domain/wagering/wager-transaction";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { Logger } from "../ports/logger";
import type { Metrics } from "../ports/metrics";
import type { UnitOfWork } from "../ports/unit-of-work";
import { ApplyOutcomeKind, type WagerTransactionApplier } from "./apply-wager-transaction";

export interface PendingReferenceOptions {
  readonly batchSize: number;
  readonly idleDelayMs: number;
  readonly maxAttempts: number;
  readonly ttlMs: number;
  /** Adiamento aplicado quando o ciclo da linha estoura. */
  readonly failureBackoffMs: number;
}

export const DEFAULT_PENDING_REFERENCE_OPTIONS: PendingReferenceOptions = {
  batchSize: 20,
  idleDelayMs: 1_000,
  maxAttempts: REFERENCE_MAX_ATTEMPTS,
  ttlMs: REFERENCE_TTL_MS,
  failureBackoffMs: 60_000,
};

export interface CycleSummary {
  readonly resolved: number;
  readonly rejected: number;
  readonly deferred: number;
  readonly skipped: number;
  readonly failed: number;
}

type Resultado = "resolved" | "rejected" | "deferred" | "skipped" | "failed";

/**
 * Reprocessa as transacoes que aguardam referencia.
 *
 * Referencia ausente nao e rejeicao: com entrega at-least-once e sem ordenacao
 * garantida, um ROLLBACK chegar antes da BET e comportamento normal. Rejeitar
 * ali deixaria o provedor achando que reverteu enquanto nosso saldo diz que
 * nao — divergencia financeira com o provedor, que e o pior resultado possivel.
 *
 * Esgotado o limite, a transacao e rejeitada com `REFERENCE_NOT_FOUND` e o
 * evento correspondente e publicado, para o provedor conciliar do lado dele.
 */
export class PendingReferenceWorker {
  private rodando = false;
  private ciclo: Promise<void> | undefined;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly applier: WagerTransactionApplier,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly options: PendingReferenceOptions = DEFAULT_PENDING_REFERENCE_OPTIONS,
  ) {}

  get running(): boolean {
    return this.rodando;
  }

  async start(): Promise<void> {
    this.rodando = true;
    this.logger.info("worker de referencia ausente iniciado", {
      maxAttempts: this.options.maxAttempts,
      ttlMs: this.options.ttlMs,
    });

    while (this.rodando) {
      this.ciclo = this.runOnce()
        .then(async (resumo) => {
          if (resumo.resolved + resumo.rejected + resumo.deferred === 0) {
            await this.espera(this.options.idleDelayMs);
          }
        })
        .catch(async (erro: unknown) => {
          this.logger.error("ciclo do worker de referencia falhou", {
            reason: erro instanceof Error ? erro.message : String(erro),
          });
          await this.espera(this.options.idleDelayMs);
        });
      await this.ciclo;
    }

    this.logger.info("worker de referencia ausente encerrado");
  }

  async stop(): Promise<void> {
    if (!this.rodando) return;
    this.rodando = false;
    await this.ciclo?.catch(() => undefined);
  }

  async runOnce(): Promise<CycleSummary> {
    const pendentes = await this.uow.read((ctx) =>
      ctx.transactions.findDueReferenceRetries(this.options.batchSize),
    );

    const contagem: Record<Resultado, number> = {
      resolved: 0,
      rejected: 0,
      deferred: 0,
      skipped: 0,
      failed: 0,
    };

    for (const pendente of pendentes) {
      contagem[await this.processa(pendente.transactionId, pendente.walletId)] += 1;
    }

    if (pendentes.length > 0) {
      this.logger.info("ciclo de referencia ausente", { ...contagem, due: pendentes.length });
    }

    return contagem;
  }

  /**
   * Trata uma linha. Falha de uma nao pode parar o ciclo: sem o try/catch, uma
   * linha que estoura sempre abortaria o ciclo inteiro, e como o rollback
   * desfaz o adiamento ela continuaria vencida na mesma posicao da fila —
   * starvando indefinidamente tudo ordenado depois dela.
   */
  private async processa(transactionId: string, walletId: string): Promise<Resultado> {
    try {
      return await this.processaOuEstoura(transactionId, walletId);
    } catch (erro: unknown) {
      const reason = erro instanceof Error ? erro.message : String(erro);
      this.logger.error("falha ao reprocessar referencia", {
        transactionId,
        walletId,
        reason,
      });

      // Transacao propria: a anterior sofreu rollback e levou o incremento de
      // tentativa com ela.
      await this.uow
        .run((ctx) =>
          ctx.transactions.penalizeReferenceRetry(transactionId, this.options.failureBackoffMs),
        )
        .catch((segunda: unknown) => {
          this.logger.error("nao foi possivel adiar a linha que falhou", {
            transactionId,
            reason: segunda instanceof Error ? segunda.message : String(segunda),
          });
        });

      return "failed";
    }
  }

  private async processaOuEstoura(
    transactionId: string,
    walletId: string,
  ): Promise<Resultado> {
    const correlationId = this.ids.next();
    const now = this.clock.now();
    const iniciado = performance.now();

    return this.uow.run(async (ctx) => {
      // ---- Ordem de lock: carteira **antes** da transacao.
      //
      // O SubmitWagerTransaction trava a carteira e depois escreve na
      // transacao. Se este worker fizesse o contrario, dois escritores com
      // ordens opostas formariam ciclo e o PostgreSQL mataria um como
      // deadlock. Por isso a fila devolve apenas os ids: a carteira e travada
      // antes de a transacao ser reaberta.
      const wallet = await ctx.wallets.findByIdForUpdate(walletId);
      if (!wallet) return "skipped";

      // A releitura confere estado **e vencimento**, com o relogio do banco.
      //
      // E isso que serializa replicas: a fila e lida sem claim de proposito —
      // reivindicar com FOR UPDATE SKIP LOCKED na transacao exigiria trava-la
      // antes da carteira, invertendo a ordem de lock do
      // SubmitWagerTransaction e trazendo de volta o ciclo de deadlock. Duas
      // replicas podem ler a mesma linha, mas a que chega depois do commit da
      // primeira ve a proxima tentativa no futuro e desiste sem queimar
      // tentativa. Sem o predicado de vencimento, cada replica consumiria uma
      // tentativa por ciclo e o backoff deixaria de existir.
      const transaction = await ctx.transactions.lockDueReferenceRetry(transactionId);
      if (!transaction) {
        // Outra replica resolveu, adiou, ou a transacao ja e terminal.
        return "skipped";
      }

      const resultado = await this.applier.apply({
        ctx,
        transaction,
        wallet,
        now,
        correlationId,
      });

      if (resultado.kind !== ApplyOutcomeKind.ReferenceMissing) {
        const desfecho = resultado.kind === ApplyOutcomeKind.Processed ? "resolved" : "rejected";
        // A transacao foi aplicada **aqui**, nao na submissao: ela saiu de lá
        // como PENDING_REFERENCE. Sem esta chamada, toda reversao que chegou
        // antes da referencia ficaria fora de `wager_transactions_total`, e a
        // serie nao fecharia com o ledger.
        this.observa(transaction, resultado.kind, resultado.failureCode, iniciado);
        this.logger.info(`referencia ${desfecho === "resolved" ? "resolvida" : "recusada"}`, {
          transactionId,
          walletId,
          correlationId,
          failureCode: resultado.failureCode,
          attempts: transaction.referenceAttempts,
        });
        return desfecho;
      }

      // Continua ausente: conta a tentativa.
      transaction.markPendingReference(now);
      await ctx.transactions.update(transaction);

      if (
        transaction.hasExhaustedReferenceRetries({
          now,
          maxAttempts: this.options.maxAttempts,
          ttlMs: this.options.ttlMs,
        })
      ) {
        await this.applier.reject(
          { ctx, transaction, wallet, now, correlationId },
          FailureCode.ReferenceNotFound,
        );
        this.observa(transaction, ApplyOutcomeKind.Rejected, FailureCode.ReferenceNotFound, iniciado);
        this.logger.warn("referencia nunca chegou; transacao rejeitada", {
          transactionId,
          walletId,
          correlationId,
          attempts: transaction.referenceAttempts,
          pendingSince: transaction.pendingReferenceSince?.toISOString(),
        });
        return "rejected";
      }

      this.metrics.retryScheduled("reference_resolution");
      await ctx.transactions.scheduleReferenceRetry(
        transaction.id,
        referenceBackoffDelayMs(transaction.referenceAttempts),
      );
      return "deferred";
    });
  }

  /**
   * Conta a transacao que **este** worker aplicou, com o `source` original da
   * submissao: o canal de entrada nao muda por ela ter esperado a referencia.
   */
  private observa(
    transaction: WagerTransaction,
    kind: ApplyOutcomeKind.Processed | ApplyOutcomeKind.Rejected,
    failureCode: FailureCode | undefined,
    iniciado: number,
  ): void {
    this.metrics.transactionObserved({
      outcome: kind === ApplyOutcomeKind.Processed ? "PROCESSED" : "REJECTED",
      kind: transaction.kind,
      source: transaction.source,
      failureCode,
      durationMs: performance.now() - iniciado,
    });
  }

  private espera(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
