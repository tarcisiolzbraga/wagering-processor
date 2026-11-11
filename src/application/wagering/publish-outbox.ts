import { backoffDelayMs, type OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Clock } from "../ports/clock";
import type { EventPublisher } from "../ports/event-publisher";
import type { Logger } from "../ports/logger";
import type { Metrics } from "../ports/metrics";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface OutboxPublisherOptions {
  readonly workerId: string;
  readonly batchSize: number;
  /** Validade da reivindicacao. Expirado, outro publisher assume. */
  readonly leaseSeconds: number;
  /** Pausa quando nao ha nada pendente. */
  readonly idleDelayMs: number;
  /**
   * Tentativas antes de desistir.
   *
   * Mais generoso que o limite da fila de entrada (5): ali reenviar e do
   * provedor, aqui o evento **tem** que sair, e uma indisponibilidade de
   * broker nao deve custar o evento. O horizonte que o numero compra sai
   * do backoff; a aritmetica fica em `defaultOutboxOptions`, num lugar so.
   */
  readonly maxAttempts: number;
  /** Acima disto o atraso da outbox vira aviso. */
  readonly lagWarnMs: number;
}

export function defaultOutboxOptions(workerId: string): OutboxPublisherOptions {
  return {
    workerId,
    batchSize: 10,
    leaseSeconds: 30,
    idleDelayMs: 200,
    // 20 tentativas, nao 10. O numero sai do horizonte pretendido, nao do
    // gosto: com backoff dobrando de 1s e teto de 5 min, 10 tentativas cobrem
    // 8,5 min e **nunca** alcancam o teto — a maior espera usada seria de
    // 256s. O teto ficaria decorativo e uma indisponibilidade de broker de
    // quinze minutos custaria o evento. Com 20, o horizonte vai a ~58 min e o
    // teto passa a valer, que era a intencao de "o evento tem que sair".
    maxAttempts: 20,
    lagWarnMs: 30_000,
  };
}

/**
 * Publica os eventos pendentes da outbox.
 *
 * O ciclo e deliberadamente em tres etapas, com a publicacao **fora** de
 * transacao:
 *
 * 1. reivindica com `FOR UPDATE SKIP LOCKED` e grava lease — transacao curta;
 * 2. publica no broker — nenhuma transacao aberta;
 * 3. marca publicada ou agenda retry — transacao curta.
 *
 * Morrer entre 2 e 3 deixa o lease expirar, outro publisher reivindica e
 * publica de novo. Publicacao duplicada e tolerada por desenho: o consumidor
 * deduplica pelo eventId. A alternativa — segurar a transacao durante o envio
 * — amarraria lock e conexao de banco a latencia do broker.
 */
export class OutboxPublisherWorker {
  private rodando = false;
  private ciclo: Promise<void> | undefined;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly options: OutboxPublisherOptions,
  ) {}

  get running(): boolean {
    return this.rodando;
  }

  async start(): Promise<void> {
    this.rodando = true;
    this.logger.info("publisher da outbox iniciado", { workerId: this.options.workerId });

    while (this.rodando) {
      this.ciclo = this.publishOnce()
        .then(async (publicadas) => {
          if (publicadas === 0) await this.espera(this.options.idleDelayMs);
        })
        .catch(async (erro: unknown) => {
          this.logger.error("ciclo do publisher falhou", {
            reason: erro instanceof Error ? erro.message : String(erro),
          });
          await this.espera(this.options.idleDelayMs);
        });
      await this.ciclo;
    }

    this.logger.info("publisher da outbox encerrado");
  }

  async stop(): Promise<void> {
    if (!this.rodando) return;
    this.rodando = false;
    // Espera o ciclo em curso: parar no meio deixaria mensagens reivindicadas
    // com lease valido, inativas ate ele expirar.
    await this.ciclo?.catch(() => undefined);
  }

  /** Um ciclo completo. Devolve quantas mensagens foram publicadas. */
  async publishOnce(): Promise<number> {
    // Varredura antes de reivindicar: um publisher que morre repetidamente
    // consome as tentativas sem nunca executar o caminho de desistencia, e a
    // linha ficaria pendente para sempre fixando o lag no teto.
    const abandonadas = await this.uow.run((ctx) =>
      ctx.outbox.abandonExhausted(this.options.maxAttempts),
    );
    if (abandonadas > 0) {
      this.logger.error("eventos abandonados por esgotar tentativas", {
        workerId: this.options.workerId,
        abandoned: abandonadas,
        maxAttempts: this.options.maxAttempts,
      });
    }

    const reivindicadas = await this.uow.run((ctx) =>
      ctx.outbox.claimDue({
        limit: this.options.batchSize,
        leaseSeconds: this.options.leaseSeconds,
        workerId: this.options.workerId,
        maxAttempts: this.options.maxAttempts,
      }),
    );
    if (reivindicadas.length === 0) {
      await this.observaAtraso();
      return 0;
    }

    const resultado = await this.publisher.publish(reivindicadas);
    const porId = new Map(reivindicadas.map((mensagem) => [mensagem.id, mensagem]));

    await this.uow.run(async (ctx) => {
      for (const id of resultado.publishedIds) {
        await ctx.outbox.markPublished(id);
      }

      for (const falha of resultado.failures) {
        const mensagem = porId.get(falha.id);
        if (!mensagem) continue;

        // `attempts` ja foi incrementado na reivindicacao.
        if (mensagem.attempts >= this.options.maxAttempts) {
          await ctx.outbox.abandon(mensagem.id, falha.reason);
        } else {
          this.metrics.retryScheduled("outbox_event");
          await ctx.outbox.deferRetry(
            mensagem.id,
            backoffDelayMs(mensagem.attempts),
            falha.reason,
          );
        }
      }
    });

    this.registra(resultado.publishedIds.length, resultado.failures, reivindicadas);
    await this.observaAtraso();
    return resultado.publishedIds.length;
  }

  /**
   * Observa o outbox lag.
   *
   * E o sintoma direto da unica falha silenciosa deste desenho: o dinheiro
   * esta correto no banco, a API responde 200, e o mundo externo nao esta
   * sendo avisado. Enquanto nao existe metrica (Fase 9), o log e o sinal.
   */
  private async observaAtraso(): Promise<void> {
    const lagMs = await this.uow.read((ctx) =>
      ctx.outbox.oldestPendingAgeMs(this.clock.now()),
    );
    // A metrica que denuncia publisher parado: o dinheiro esta correto no
    // banco, a API responde 200, e o mundo externo nao esta sendo avisado.
    this.metrics.outboxLagObserved(lagMs);
    const campos = { workerId: this.options.workerId, outboxLagMs: lagMs };

    if (lagMs >= this.options.lagWarnMs) this.logger.warn("outbox atrasada", campos);
    else this.logger.debug("outbox em dia", campos);
  }

  private registra(
    publicadas: number,
    falhas: ReadonlyArray<{ id: string; reason: string }>,
    reivindicadas: readonly OutboxMessage[],
  ): void {
    const campos = {
      workerId: this.options.workerId,
      claimed: reivindicadas.length,
      published: publicadas,
      failed: falhas.length,
    };

    if (falhas.length > 0) {
      // Todas as razoes distintas, nao so a primeira: com uma so, uma falha
      // generalizada e uma pontual ficam indistinguiveis no log.
      this.logger.warn("publicacao parcial da outbox", {
        ...campos,
        reasons: [...new Set(falhas.map((f) => f.reason))].slice(0, 5),
      });
    } else {
      this.logger.debug("lote da outbox publicado", campos);
    }
  }

  private espera(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
