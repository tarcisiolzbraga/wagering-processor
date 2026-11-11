import { LockMode, type EntityManager } from "@mikro-orm/postgresql";

import {
  InsertTransactionOutcome,
  type PendingReferenceRef,
  type WagerTransactionRepository,
} from "../../../application/ports/repositories";
import { WagerTransactionKind } from "../../../domain/wagering/wager-transaction-kind";
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
      // Savepoint, nao try/catch solto: no PostgreSQL uma violacao de unicidade
      // **aborta a transacao SQL inteira**. Sem isolar o insert, capturar o
      // 23505 e seguir deixaria o COMMIT virar ROLLBACK em silencio — e a
      // linha de inbox gravada antes desapareceria junto, quebrando
      // exatamente a atomicidade que a inbox existe para garantir.
      return await this.em.transactional(async (em) => {
        const result = await em
          .createQueryBuilder(wagerTransactionSchema)
          .insert(entity)
          .onConflict("idempotency_key")
          .ignore()
          .execute("run");

        return result.affectedRows === 1
          ? InsertTransactionOutcome.Inserted
          : InsertTransactionOutcome.IdempotencyKeyExists;
      });
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
        // Zerado fora de PENDING_REFERENCE: o CHECK do schema exige, e deixar
        // valor para tras faria o indice parcial apontar para lixo.
        nextReferenceAttemptAt:
          transaction.status === WagerTransactionStatus.PendingReference
            ? undefined
            : null,
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

  async findProcessedReversalOf(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(wagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async findDueReferenceRetries(limit: number): Promise<readonly PendingReferenceRef[]> {
    // `now()` do banco, nao o relogio do processo: a coluna foi escrita por
    // outro processo e comparar relogios diferentes convida clock skew.
    const linhas = await this.em.getConnection().execute<
      Array<{ id: string; wallet_id: string }>
    >(
      `select id, wallet_id
         from wager_transactions
        where status = 'PENDING_REFERENCE'
          and (next_reference_attempt_at is null or next_reference_attempt_at <= now())
        order by next_reference_attempt_at nulls first, pending_reference_since
        limit ?::int`,
      [limit],
      "all",
      this.em.getTransactionContext(),
    );

    return linhas.map((linha) => ({
      transactionId: linha.id,
      walletId: linha.wallet_id,
    }));
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(
      wagerTransactionSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async lockDueReferenceRetry(id: string): Promise<WagerTransaction | undefined> {
    // O vencimento entra no proprio predicado do lock, avaliado com `now()` do
    // banco: e isso que impede duas replicas de queimarem tentativa da mesma
    // linha no mesmo ciclo.
    const travadas = await this.em.getConnection().execute<Array<{ id: string }>>(
      `select id
         from wager_transactions
        where id = ?::uuid
          and status = 'PENDING_REFERENCE'
          and (next_reference_attempt_at is null or next_reference_attempt_at <= now())
          for update`,
      [id],
      "all",
      this.em.getTransactionContext(),
    );
    if (travadas.length === 0) return undefined;

    // A linha ja esta travada pelo statement acima; carregar pela entidade
    // mantem o mapeamento e os custom types valendo.
    const entity = await this.em.findOne(wagerTransactionSchema, { id });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async penalizeReferenceRetry(id: string, delayMs: number): Promise<void> {
    await this.em.getConnection().execute(
      `update wager_transactions
          set reference_attempts        = reference_attempts + 1,
              next_reference_attempt_at = now() + make_interval(secs => ?::numeric)
        where id = ?::uuid and status = 'PENDING_REFERENCE'`,
      [delayMs / 1000, id],
      "run",
      this.em.getTransactionContext(),
    );
  }

  async scheduleReferenceRetry(id: string, delayMs: number): Promise<void> {
    await this.em.getConnection().execute(
      `update wager_transactions
          set next_reference_attempt_at = now() + make_interval(secs => ?::numeric)
        where id = ?::uuid and status = 'PENDING_REFERENCE'`,
      [delayMs / 1000, id],
      "run",
      this.em.getTransactionContext(),
    );
  }
}
