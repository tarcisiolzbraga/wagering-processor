import { LockMode, QueryOrder, type EntityManager } from "@mikro-orm/postgresql";

import type {
  InboxRepository,
  OutboxRepository,
} from "../../../application/ports/repositories";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { inboxMessageSchema, InboxMessageEntity } from "../entities/inbox-message.entity";
import { outboxMessageSchema, OutboxMessageEntity } from "../entities/outbox-message.entity";
import { InboxMessageMapper, OutboxMessageMapper } from "../mappers/messaging.mapper";
import { toNull } from "../mappers/nullable";

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
   * `LockMode.PESSIMISTIC_PARTIAL_WRITE` gera `FOR UPDATE SKIP LOCKED`:
   * publishers concorrentes pegam lotes disjuntos sem se bloquear. Sem o SKIP
   * LOCKED, o segundo publisher esperaria o primeiro — serializando o que
   * deveria escalar.
   *
   * Ordem com NULLs primeiro porque `next_attempt_at` nulo significa "vencida
   * agora", e e o que o indice parcial espelha.
   */
  async claimDue(limit: number, now: Date): Promise<readonly OutboxMessage[]> {
    const entities = await this.em.find(
      outboxMessageSchema,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: { nextAttemptAt: QueryOrder.ASC_NULLS_FIRST, occurredAt: QueryOrder.ASC },
        limit,
      },
    );
    return entities.map((entity) => OutboxMessageMapper.toDomain(entity));
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em
      .createQueryBuilder(outboxMessageSchema)
      .update({ publishedAt: toNull(message.publishedAt) })
      .where({ id: message.id })
      .execute("run");
  }

  async scheduleRetry(message: OutboxMessage): Promise<void> {
    await this.em
      .createQueryBuilder(outboxMessageSchema)
      .update({ attempts: message.attempts, nextAttemptAt: toNull(message.nextAttemptAt) })
      .where({ id: message.id })
      .execute("run");
  }

  async pendingCount(): Promise<number> {
    return this.em.count(outboxMessageSchema, { publishedAt: null });
  }

  /** Idade da pendencia mais antiga — a metrica que denuncia publisher parado. */
  async oldestPendingAgeMs(now: Date): Promise<number> {
    const rows = await this.em.getConnection().execute<Array<{ oldest: Date | null }>>(
      "select min(occurred_at) as oldest from outbox_messages where published_at is null",
      [],
      "all",
      this.em.getTransactionContext(),
    );
    const oldest = rows[0]?.oldest;
    if (oldest === null || oldest === undefined) return 0;
    return Math.max(0, now.getTime() - new Date(oldest).getTime());
  }
}
