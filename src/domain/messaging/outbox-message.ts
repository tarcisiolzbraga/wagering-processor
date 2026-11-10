import type { IntegrationEvent } from "../events/integration-event";
import { InvariantViolationError } from "../shared/domain-error";

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  /** MessageGroupId da publicacao — a walletId. */
  readonly partitionKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly publishedAt?: Date | undefined;
}

/**
 * Backoff deterministico: 1s, 2s, 4s… com teto de 5 min. Sem jitter de
 * proposito — o publisher reclama linhas com FOR UPDATE SKIP LOCKED, entao
 * publishers concorrentes nao disputam as mesmas linhas e nao ha efeito de
 * manada a dispersar. Em troca, o backoff fica exatamente testavel.
 */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;

export function backoffDelayMs(attempts: number): number {
  if (attempts < 1) return BASE_DELAY_MS;
  const exponencial = BASE_DELAY_MS * 2 ** (attempts - 1);
  return Math.min(exponencial, MAX_DELAY_MS);
}

/**
 * Evento aguardando publicacao, gravado na **mesma transacao SQL** do dinheiro.
 * Ou os dois existem, ou nenhum: e isso que torna impossivel publicar um evento
 * de algo que sofreu rollback, e impossivel perder um evento ja confirmado.
 *
 * O `id` da linha e o `eventId` do evento — isso da ao consumidor uma chave de
 * deduplicacao estavel sem inventar um segundo identificador.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly partitionKey: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date | undefined,
    private _publishedAt?: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.partitionKey,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  /** Reconstrucao a partir da persistencia — nao revalida. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.partitionKey,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e sem espera de retry em curso. */
  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      // Publicar duas vezes a mesma linha significa que a reivindicacao
      // (SKIP LOCKED) falhou — bug, nao caminho normal.
      throw new InvariantViolationError(`outbox ${this.id} ja foi publicada`);
    }
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda a proxima tentativa com backoff. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(
        `outbox ${this.id} ja publicada, nao ha retry a agendar`,
      );
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts));
  }
}
