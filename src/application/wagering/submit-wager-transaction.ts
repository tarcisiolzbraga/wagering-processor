import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/wager-transaction-events";
import type { EventContext } from "../../domain/events/integration-event";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import {
  DomainRuleViolationError,
  InvariantViolationError,
} from "../../domain/shared/domain-error";
import { FailureCode } from "../../domain/shared/failure-code";
import { LedgerDirection } from "../../domain/wallet/ledger-direction";
import type { Wallet } from "../../domain/wallet/wallet";
import type {
  WagerTransactionKind,
  WagerTransactionSource,
} from "../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import { InsertTransactionOutcome } from "../ports/repositories";
import type { TransactionalContext, UnitOfWork } from "../ports/unit-of-work";
import { assertUuid } from "../shared/assert-uuid";
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
      //
      // O custo e que um replay duplicado passa pelo lock antes de ser
      // detectado. Vale: correcao acima de vazao.
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

      const ctx4 = { ctx, transaction, wallet, now, command };

      if (wallet.playerId !== command.playerId) {
        return this.rejectAndRecord(ctx4, FailureCode.PlayerMismatch);
      }

      // ---- 5. Resolucao da referencia, dentro do lock.
      let reference: WagerTransaction | undefined;
      if (transaction.requiresReference()) {
        const resolucao = await this.resolveReference(ctx4);
        if ("failureCode" in resolucao) {
          return this.rejectAndRecord(ctx4, resolucao.failureCode);
        }
        if (resolucao.pending) {
          return this.markPendingReference(ctx4);
        }
        reference = resolucao.reference;
      }

      // ---- 6. LOSS: registra o resultado da rodada sem mover saldo.
      if (!transaction.affectsBalance()) {
        transaction.markProcessed({ observedBalance: wallet.balance, at: now });
        await ctx.transactions.update(transaction);
        await this.enqueue(ctx, [
          WagerTransactionProcessed.from(transaction, this.eventContext(command, now)),
        ]);
        return {
          outcome: SubmitOutcome.Processed,
          transactionId: transaction.id,
          status: transaction.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
      }

      // ---- 7. Movimenta o saldo.
      const direction = transaction.ledgerDirectionFor(reference);

      if (direction === LedgerDirection.Debit && !wallet.hasSufficientBalance(transaction.money)) {
        // Codigos distintos de proposito: aposta sem saldo e operacao normal,
        // reversao que nao cabe significa estado inconsistente com o provedor.
        return this.rejectAndRecord(
          ctx4,
          transaction.requiresReference()
            ? FailureCode.ReversalWouldOverdraw
            : FailureCode.InsufficientFunds,
        );
      }

      const versionBefore = wallet.version;
      const movement = {
        entryId: this.ids.next(),
        transactionId: transaction.id,
        money: transaction.money,
        at: now,
      };
      const entry =
        direction === LedgerDirection.Credit ? wallet.credit(movement) : wallet.debit(movement);

      transaction.markProcessed({
        referenceTransactionId: reference?.id,
        observedBalance: wallet.balance,
        at: now,
      });

      await ctx.transactions.update(transaction);
      await ctx.ledger.insert(entry);

      if (!(await ctx.wallets.updateBalance(wallet, versionBefore))) {
        // O FOR UPDATE deveria ter impedido. Chegar aqui e bug de caminho.
        throw new InvariantViolationError(
          `saldo da carteira ${wallet.id} mudou sob o lock (version esperada ${versionBefore})`,
        );
      }

      const eventCtx = this.eventContext(command, now);
      await this.enqueue(ctx, [
        WagerTransactionProcessed.from(transaction, eventCtx),
        WalletBalanceChanged.from(wallet, entry, {
          ...eventCtx,
          eventId: this.ids.next(),
        }),
      ]);

      return {
        outcome: SubmitOutcome.Processed,
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    });
  }

  // ------------------------------------------------------------- auxiliares

  private eventContext(
    command: SubmitWagerTransactionCommand,
    occurredAt: Date,
  ): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.inbox?.messageId,
      occurredAt,
    };
  }

  private async enqueue(
    ctx: TransactionalContext,
    events: ReadonlyArray<Parameters<typeof OutboxMessage.enqueue>[0]>,
  ): Promise<void> {
    await ctx.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
  }

  /** Rejeicao que o schema impede de persistir: auditada por log e metrica. */
  private rejectWithoutRecord(failureCode: FailureCode): SubmitWagerTransactionResult {
    return {
      outcome: SubmitOutcome.Rejected,
      failureCode,
      idempotentReplay: false,
    };
  }

  private async rejectAndRecord(
    scope: {
      ctx: TransactionalContext;
      transaction: WagerTransaction;
      wallet: Wallet;
      now: Date;
      command: SubmitWagerTransactionCommand;
    },
    failureCode: FailureCode,
  ): Promise<SubmitWagerTransactionResult> {
    const { ctx, transaction, wallet, now, command } = scope;
    transaction.reject({ code: failureCode, observedBalance: wallet.balance, at: now });
    await ctx.transactions.update(transaction);
    await this.enqueue(ctx, [
      WagerTransactionRejected.from(transaction, this.eventContext(command, now)),
    ]);

    return {
      outcome: SubmitOutcome.Rejected,
      transactionId: transaction.id,
      status: transaction.status,
      failureCode,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async markPendingReference(scope: {
    ctx: TransactionalContext;
    transaction: WagerTransaction;
    now: Date;
    command: SubmitWagerTransactionCommand;
  }): Promise<SubmitWagerTransactionResult> {
    const { ctx, transaction, now, command } = scope;
    transaction.markPendingReference(now);
    await ctx.transactions.update(transaction);
    await this.enqueue(ctx, [
      WagerTransactionPendingReference.from(transaction, this.eventContext(command, now)),
    ]);

    return {
      outcome: SubmitOutcome.PendingReference,
      transactionId: transaction.id,
      status: transaction.status,
      idempotentReplay: false,
    };
  }

  /**
   * Resolve e valida a referencia. Referencia ausente **nao** e rejeicao: com
   * entrega at-least-once e sem ordenacao garantida, um ROLLBACK chegar antes
   * da BET e comportamento normal. Rejeitar ali deixaria o provedor achando que
   * reverteu enquanto nosso saldo diz que nao.
   */
  private async resolveReference(scope: {
    ctx: TransactionalContext;
    transaction: WagerTransaction;
  }): Promise<
    { reference: WagerTransaction; pending: false } | { pending: true } | { failureCode: FailureCode }
  > {
    const { ctx, transaction } = scope;
    const externalId = transaction.referenceExternalTransactionId;
    if (externalId === undefined) {
      throw new InvariantViolationError(
        `${transaction.kind} ${transaction.id} exige referencia mas chegou sem ela`,
      );
    }

    const reference = await ctx.transactions.findByProviderAndExternalId(
      transaction.providerId,
      externalId,
    );
    if (!reference) return { pending: true };

    const mesmoEscopo =
      reference.providerId === transaction.providerId &&
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.roundId === transaction.roundId &&
      reference.money.currency === transaction.money.currency;
    if (!mesmoEscopo) return { failureCode: FailureCode.ReferenceScopeMismatch };

    if (reference.status !== WagerTransactionStatus.Processed) {
      return { failureCode: FailureCode.ReferenceNotProcessed };
    }
    if (!reference.isReversibleBy(transaction.kind)) {
      return { failureCode: FailureCode.ReferenceKindNotReversible };
    }
    if (!reference.money.equals(transaction.money)) {
      // Reversao parcial esta fora de escopo: o valor tem que ser igual.
      return { failureCode: FailureCode.ReferenceAmountMismatch };
    }
    if (await ctx.transactions.findProcessedReversalOf(reference.id)) {
      return { failureCode: FailureCode.ReferenceAlreadyReversed };
    }

    return { reference, pending: false };
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
