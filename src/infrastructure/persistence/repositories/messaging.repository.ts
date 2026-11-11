import type { EntityManager } from "@mikro-orm/postgresql";

import type {
  ClaimOptions,
  InboxRepository,
  OutboxRepository,
} from "../../../application/ports/repositories";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { inboxMessageSchema, InboxMessageEntity } from "../entities/inbox-message.entity";
import { outboxMessageSchema, OutboxMessageEntity } from "../entities/outbox-message.entity";
import { InboxMessageMapper, OutboxMessageMapper } from "../mappers/messaging.mapper";
import { toNull } from "../mappers/nullable";

/** Limite do texto de erro guardado na linha. */
const MAX_ERROR_LENGTH = 500;

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * A deduplicacao e a chave primaria composta, e o insert e o teste. Escrito
   * na **mesma transacao** do efeito financeiro: dedup e efeito commitam juntos
   * ou nao commitam.
   */
  async receiveIfAbsent(message: InboxMessage): Promise<boolean> {
    const entity = InboxMessageMapper.toEntity(message, new InboxMessageEntity());
    const result = await this.em
      .createQueryBuilder(inboxMessageSchema)
      .insert(entity)
      .onConflict(["consumer_name", "message_id"])
      .ignore()
      .execute("run");

    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const entity = await this.em.findOne(inboxMessageSchema, { consumerName, messageId });
    return entity ? InboxMessageMapper.toDomain(entity) : undefined;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em
      .createQueryBuilder(inboxMessageSchema)
      .update({ processedAt: toNull(message.processedAt) })
      .where({ consumerName: message.consumerName, messageId: message.messageId })
      .execute("run");
  }
}

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const entities = messages.map((m) =>
      OutboxMessageMapper.toEntity(m, new OutboxMessageEntity()),
    );
    await this.em.insertMany(outboxMessageSchema, entities);
  }

  /**
   * `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` numa tacada: a
   * reivindicacao e atomica e nao bloqueia publisher concorrente.
   *
   * Os casts sao obrigatorios, nao estilo: um `?` sem tipo tem o tipo inferido
   * pelo contexto, e em `? + make_interval(...)` o PostgreSQL concluia
   * `interval` para o primeiro parametro.
   */
  async claimDue(options: ClaimOptions): Promise<readonly OutboxMessage[]> {
    const linhas = await this.raw<{ id: string }>(
      `update outbox_messages o
          set locked_until = now() + make_interval(secs => ?::int),
              locked_by    = ?::text,
              attempts     = o.attempts + 1
         from (
           select id
             from outbox_messages
            where published_at is null
              and abandoned_at is null
              and attempts < ?::int
              and (next_attempt_at is null or next_attempt_at <= now())
              and (locked_until is null or locked_until <= now())
            order by next_attempt_at nulls first, occurred_at, id
            limit ?::int
            for update skip locked
         ) as alvo
        where o.id = alvo.id
       returning o.id`,
      [options.leaseSeconds, options.workerId, options.maxAttempts, options.limit],
    );

    if (linhas.length === 0) return [];

    // Recarregar pelas entidades mantem o mapeamento e os custom types
    // valendo. A ordenacao e repetida aqui porque `$in` nao preserva ordem, e
    // `occurred_at` empata entre eventos da mesma transacao — o `id` (UUIDv7,
    // ordenado no tempo) desempata.
    const entities = await this.em.find(
      outboxMessageSchema,
      { id: { $in: linhas.map((linha) => linha.id) } },
      { orderBy: { occurredAt: "asc", id: "asc" } },
    );

    return entities.map((entity) => OutboxMessageMapper.toDomain(entity));
  }

  async markPublished(id: string): Promise<void> {
    await this.raw(
      `update outbox_messages
          set published_at = now(), locked_until = null, locked_by = null
        where id = ?::uuid`,
      [id],
    );
  }

  async deferRetry(id: string, delayMs: number, reason: string): Promise<void> {
    await this.raw(
      `update outbox_messages
          set next_attempt_at = now() + make_interval(secs => ?::numeric),
              last_error      = ?::text,
              locked_until    = null,
              locked_by       = null
        where id = ?::uuid`,
      [delayMs / 1000, reason.slice(0, MAX_ERROR_LENGTH), id],
    );
  }

  async abandon(id: string, reason: string): Promise<void> {
    await this.raw(
      `update outbox_messages
          set abandoned_at = now(), last_error = ?::text,
              locked_until = null, locked_by = null
        where id = ?::uuid and published_at is null`,
      [reason.slice(0, MAX_ERROR_LENGTH), id],
    );
  }

  async abandonExhausted(maxAttempts: number): Promise<number> {
    const linhas = await this.raw<{ id: string }>(
      `update outbox_messages
          set abandoned_at = now(),
              last_error   = coalesce(last_error, 'tentativas esgotadas'),
              locked_until = null,
              locked_by    = null
        where published_at is null
          and abandoned_at is null
          and attempts >= ?::int
          and (locked_until is null or locked_until <= now())
       returning id`,
      [maxAttempts],
    );
    return linhas.length;
  }

  async pendingCount(): Promise<number> {
    return this.em.count(outboxMessageSchema, { publishedAt: null, abandonedAt: null });
  }

  /**
   * Metrica local, por isso aceita o relogio do processo: ela observa, nao
   * coordena. Abandonadas ficam fora — senao uma mensagem impublicavel fixaria
   * o lag no teto e esconderia um publisher realmente travado.
   */
  async oldestPendingAgeMs(now: Date): Promise<number> {
    const linhas = await this.raw<{ idade: string | null }>(
      `select (extract(epoch from (?::timestamptz - min(occurred_at))) * 1000)::text as idade
         from outbox_messages
        where published_at is null and abandoned_at is null`,
      [now],
    );
    const idade = linhas[0]?.idade;
    if (idade === null || idade === undefined) return 0;
    return Math.max(0, Math.round(Number(idade)));
  }

  private async raw<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.em
      .getConnection()
      .execute<T[]>(sql, params, "all", this.em.getTransactionContext());
  }
}
