import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-events";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import {
  DomainRuleViolationError,
  InvariantViolationError,
} from "../../domain/shared/domain-error";
import { FailureCode } from "../../domain/shared/failure-code";
import type {
  WagerTransactionKind,
  WagerTransactionSource,
} from "../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import {
  referenceBackoffDelayMs,
  WagerTransaction,
} from "../../domain/wagering/wager-transaction";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import { InsertTransactionOutcome } from "../ports/repositories";
import type { TransactionalContext, UnitOfWork } from "../ports/unit-of-work";
import { assertUuid } from "../shared/assert-uuid";
import {
  ApplyOutcomeKind,
  type WagerTransactionApplier,
} from "./apply-wager-transaction";
import { computePayloadHash } from "./payload-hash";

export interface SubmitWagerTransactionCommand {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly source: WagerTransactionSource;
  readonly correlationId: string;
  /** Presente quando a entrada veio da fila. */
  readonly inbox?: { readonly consumerName: string; readonly messageId: string } | undefined;
}

export enum SubmitOutcome {
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  PendingReference = "PENDING_REFERENCE",
  /** Mesma key, payload diferente. Nao e replay. */
  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",
  /** Mesma operacao reapresentada com outra idempotency key. */
  DuplicateExternalTransaction = "DUPLICATE_EXTERNAL_TRANSACTION",
  /** A mensagem da fila ja foi processada; nada a fazer alem do ack. */
  DuplicateMessage = "DUPLICATE_MESSAGE",
}

export interface SubmitWagerTransactionResult {
  readonly outcome: SubmitOutcome;
  readonly transactionId?: string | undefined;
  readonly status?: WagerTransactionStatus | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly balance?: MoneyProps | undefined;
  readonly idempotentReplay: boolean;
}

/**
 * O use case central. **Um unico**, usado tanto pelo controller HTTP quanto
 * pelo consumer SQS: duas implementacoes da mesma regra financeira divergem na
 * primeira correcao aplicada num caminho e esquecida no outro. A diferenca
 * entre os canais (inbox, ack, status HTTP) fica nas bordas, nao na regra.
 *
 * Tudo abaixo roda numa unica transacao SQL. Eventos sao **gravados** na
 * outbox, nunca publicados aqui.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly applier: WagerTransactionApplier,
  ) {}

  async run(entrada: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    // Normaliza antes de tudo: o hash, as consultas e as comparacoes usam o
    // mesmo valor que o banco vai gravar.
    const command: SubmitWagerTransactionCommand = {
      ...entrada,
      walletId: assertUuid("walletId", entrada.walletId),
      playerId: assertUuid("playerId", entrada.playerId),
    };

    const payloadHash = computePayloadHash(command);
    const now = this.clock.now();

    return this.uow.run(async (ctx) => {
      // ---- 1. Deduplicacao da mensagem, quando a entrada e a fila.
      //
      // Gravada ja processada e numa escrita so: inbox e efeito commitam
      // juntos, entao nao existe estado intermediario ambiguo. Se outra
      // instancia tem a mesma mensagem em voo, este insert **bloqueia** na
      // chave primaria ate ela commitar.
      if (command.inbox) {
        const message = InboxMessage.receive({
          consumerName: command.inbox.consumerName,
          messageId: command.inbox.messageId,
          payloadHash,
          receivedAt: now,
        });
        message.markProcessed(now);

        if (!(await ctx.inbox.receiveIfAbsent(message))) {
          return { outcome: SubmitOutcome.DuplicateMessage, idempotentReplay: true };
        }
      }

      // ---- 2. Secao critica: trava a linha da carteira ANTES de qualquer
      // outra escrita.
      //
      // A ordem importa e nao e obvia. O INSERT da transacao dispara a
      // checagem do FK (wallet_id, money_currency) -> wallets (id, currency),
      // que toma FOR KEY SHARE na linha da carteira. Pedir FOR UPDATE depois
      // disso e **upgrade de lock**, e duas operacoes concorrentes na mesma
      // carteira formam ciclo: o PostgreSQL mata uma como deadlock (40P01).
      // Medido antes da correcao: 28 deadlocks em 30 execucoes do cenario da
      // secao 8. Com o lock primeiro, o FOR KEY SHARE do FK ja esta coberto
      // pelo FOR UPDATE, e nao ha upgrade.
      const wallet = await ctx.wallets.findByIdForUpdate(command.walletId);

      // Os FKs compostos exigem que a carteira exista e que a moeda seja a
      // dela. Uma transacao que viola isso nao pode virar linha, logo esta
      // rejeicao nao tem transactionId — a auditoria dela e log e metrica.
      if (!wallet) {
        return this.rejectWithoutRecord(FailureCode.WalletNotFound);
      }
      if (wallet.currency !== command.money.currency) {
        return this.rejectWithoutRecord(FailureCode.CurrencyMismatch);
      }

      // ---- 3. Insert-first: o proprio INSERT e o teste de existencia.
      let transaction: WagerTransaction;
      try {
        transaction = WagerTransaction.create({
          id: this.ids.next(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money: Money.from(command.money),
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          source: command.source,
          createdAt: now,
        });
      } catch (error: unknown) {
        // MISSING_REFERENCE e INTERNAL_KIND_NOT_SUBMITTABLE tambem sao
        // proibidos por CHECK no schema: nao podem virar linha.
        if (error instanceof DomainRuleViolationError) {
          return this.rejectWithoutRecord(error.failureCode);
        }
        throw error;
      }

      const insercao = await ctx.transactions.insertIfAbsent(transaction);

      if (insercao === InsertTransactionOutcome.ExternalTransactionExists) {
        return {
          outcome: SubmitOutcome.DuplicateExternalTransaction,
          idempotentReplay: false,
        };
      }

      if (insercao === InsertTransactionOutcome.IdempotencyKeyExists) {
        const anterior = await ctx.transactions.findByIdempotencyKey(command.idempotencyKey);
        if (!anterior) {
          throw new InvariantViolationError(
            `idempotency key ${command.idempotencyKey} conflitou mas a transacao nao foi encontrada`,
          );
        }
        if (!anterior.matchesPayload(payloadHash)) {
          return {
            outcome: SubmitOutcome.IdempotencyConflict,
            transactionId: anterior.id,
            status: anterior.status,
            idempotentReplay: false,
          };
        }
        return replayOf(anterior);
      }

      // ---- 4. Aplica. O mesmo aplicador que o worker de referencia usa.
      const resultado = await this.applier.apply({
        ctx,
        transaction,
        wallet,
        now,
        correlationId: command.correlationId,
        causationId: command.inbox?.messageId,
      });

      if (resultado.kind === ApplyOutcomeKind.ReferenceMissing) {
        return this.markPendingReference(ctx, transaction, now, command);
      }

      return {
        outcome:
          resultado.kind === ApplyOutcomeKind.Processed
            ? SubmitOutcome.Processed
            : SubmitOutcome.Rejected,
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: resultado.failureCode,
        balance: resultado.balance,
        idempotentReplay: false,
      };
    });
  }

  // ------------------------------------------------------------- auxiliares

  /** Rejeicao que o schema impede de persistir: auditada por log e metrica. */
  private rejectWithoutRecord(failureCode: FailureCode): SubmitWagerTransactionResult {
    return {
      outcome: SubmitOutcome.Rejected,
      failureCode,
      idempotentReplay: false,
    };
  }

  /**
   * Referencia ausente na primeira submissao: a transacao fica aguardando e o
   * worker reprocessa com backoff. O instante da proxima tentativa e calculado
   * pelo **banco**, porque e comparado por outro processo.
   */
  private async markPendingReference(
    ctx: TransactionalContext,
    transaction: WagerTransaction,
    now: Date,
    command: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    transaction.markPendingReference(now);
    await ctx.transactions.update(transaction);
    await ctx.transactions.scheduleReferenceRetry(
      transaction.id,
      referenceBackoffDelayMs(transaction.referenceAttempts),
    );
    await ctx.outbox.enqueue([
      OutboxMessage.enqueue(
        WagerTransactionPendingReference.from(transaction, {
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          causationId: command.inbox?.messageId,
          occurredAt: now,
        }),
      ),
    ]);

    return {
      outcome: SubmitOutcome.PendingReference,
      transactionId: transaction.id,
      status: transaction.status,
      idempotentReplay: false,
    };
  }
}

/**
 * Replay devolve o resultado **original**, incluindo o saldo observado naquele
 * momento (regra 7.7). Recalcular devolveria o saldo atual, que e uma resposta
 * factualmente errada: um provedor que concilia por ela acusaria divergencia.
 */
function replayOf(anterior: WagerTransaction): SubmitWagerTransactionResult {
  const outcome =
    anterior.status === WagerTransactionStatus.Processed
      ? SubmitOutcome.Processed
      : anterior.status === WagerTransactionStatus.PendingReference
        ? SubmitOutcome.PendingReference
        : SubmitOutcome.Rejected;

  return {
    outcome,
    transactionId: anterior.id,
    status: anterior.status,
    failureCode: anterior.failureCode,
    balance: anterior.observedBalance?.toJSON(),
    idempotentReplay: true,
  };
}
