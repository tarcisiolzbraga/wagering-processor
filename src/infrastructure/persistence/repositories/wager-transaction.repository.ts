import type { EntityManager } from "@mikro-orm/postgresql";

import {
  InsertTransactionOutcome,
  type WagerTransactionRepository,
} from "../../../application/ports/repositories";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import {
  wagerTransactionSchema,
  WagerTransactionEntity,
} from "../entities/wager-transaction.entity";
import { WagerTransactionMapper } from "../mappers/wager-transaction.mapper";
import { toNull } from "../mappers/nullable";
import { uniqueViolationConstraint } from "../unique-violation";

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Insert-first: o proprio INSERT e o teste de existencia.
   *
   * Um SELECT seguido de INSERT teria janela — duas requisicoes paralelas nao
   * acham nada e ambas inserem. E tem um efeito colateral valioso: enquanto a
   * transacao A tem a chave inserida e nao commitada, a B **bloqueia no indice
   * unico**, o que serializa as duplicatas usando o mecanismo que o PostgreSQL
   * ja tem.
   */
  async insertIfAbsent(transaction: WagerTransaction): Promise<InsertTransactionOutcome> {
    const entity = WagerTransactionMapper.toEntity(transaction, new WagerTransactionEntity());

    try {
      const result = await this.em
        .createQueryBuilder(wagerTransactionSchema)
        .insert(entity)
        .onConflict("idempotency_key")
        .ignore()
        .execute("run");

      return result.affectedRows === 1
        ? InsertTransactionOutcome.Inserted
        : InsertTransactionOutcome.IdempotencyKeyExists;
    } catch (error: unknown) {
      // ON CONFLICT cobre uma constraint so. A outra garantia de unicidade —
      // (provider, external id) — chega aqui como 23505 e precisa virar
      // resultado de negocio, nao erro de infraestrutura.
      if (
        uniqueViolationConstraint(error) ===
        "wager_transactions_provider_external_unique"
      ) {
        return InsertTransactionOutcome.ExternalTransactionExists;
      }
      throw error;
    }
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(wagerTransactionSchema, { idempotencyKey });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(wagerTransactionSchema, { id });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(wagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  /** Escreve so as colunas mutaveis: as de identidade sao imutaveis no banco. */
  async update(transaction: WagerTransaction): Promise<void> {
    await this.em
      .createQueryBuilder(wagerTransactionSchema)
      // toNull explicito: `undefined` faria o QueryBuilder omitir a coluna em
      // vez de gravar NULL, deixando valor antigo para tras.
      .update({
        status: transaction.status,
        failureCode: toNull(transaction.failureCode),
        observedBalanceAmount: toNull(transaction.observedBalance?.toJSON().amount),
        referenceTransactionId: toNull(transaction.referenceTransactionId),
        referenceAttempts: transaction.referenceAttempts,
        pendingReferenceSince: toNull(transaction.pendingReferenceSince),
        processedAt: toNull(transaction.processedAt),
      })
      .where({ id: transaction.id })
      .execute("run");
  }

  async findAwaitingReference(limit: number): Promise<readonly WagerTransaction[]> {
    const entities = await this.em.find(
      wagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference },
      { orderBy: { pendingReferenceSince: "asc" }, limit },
    );
    return entities.map((entity) => WagerTransactionMapper.toDomain(entity));
  }
}
