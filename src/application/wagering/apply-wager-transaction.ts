import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/wager-transaction-events";
import type { EventContext } from "../../domain/events/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { MoneyProps } from "../../domain/money/money";
import { InvariantViolationError } from "../../domain/shared/domain-error";
import { FailureCode } from "../../domain/shared/failure-code";
import { LedgerDirection } from "../../domain/wallet/ledger-direction";
import type { Wallet } from "../../domain/wallet/wallet";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { IdGenerator } from "../ports/id-generator";
import type { Metrics } from "../ports/metrics";
import type { TransactionalContext } from "../ports/unit-of-work";

export enum ApplyOutcomeKind {
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  /** A referencia nao existe (ainda). Quem chamou decide o que fazer. */
  ReferenceMissing = "REFERENCE_MISSING",
}

export interface ApplyOutcome {
  readonly kind: ApplyOutcomeKind;
  readonly failureCode?: FailureCode | undefined;
  readonly balance: MoneyProps;
}

export interface ApplyParams {
  readonly ctx: TransactionalContext;
  readonly transaction: WagerTransaction;
  /** Ja travada com FOR UPDATE pelo chamador. */
  readonly wallet: Wallet;
  readonly now: Date;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
}

/**
 * Aplica uma transacao **ja persistida**, com a carteira **ja travada**.
 *
 * Extraido do `SubmitWagerTransaction` porque o worker de referencia ausente
 * precisa exatamente deste trecho: resolver a referencia, decidir, movimentar o
 * saldo, lancar no ledger e gravar os eventos. Duas copias dessa logica
 * divergiriam na primeira correcao aplicada num caminho e esquecida no outro —
 * e e a logica que move dinheiro.
 *
 * `REFERENCE_MISSING` **nao persiste nada**: o que fazer com a espera e decisao
 * de quem chamou. Na primeira submissao vira `PENDING_REFERENCE`; no
 * reprocessamento, conta tentativa e eventualmente rejeita.
 */
export class WagerTransactionApplier {
  constructor(
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async apply(params: ApplyParams): Promise<ApplyOutcome> {
    const { ctx, transaction, wallet, now } = params;

    if (wallet.playerId !== transaction.playerId) {
      return this.rejeita(params, FailureCode.PlayerMismatch);
    }

    let reference: WagerTransaction | undefined;
    if (transaction.requiresReference()) {
      const resolucao = await this.resolveReference(ctx, transaction);
      if ("failureCode" in resolucao) {
        return this.rejeita(params, resolucao.failureCode);
      }
      if (resolucao.pending) {
        return { kind: ApplyOutcomeKind.ReferenceMissing, balance: wallet.balance.toJSON() };
      }
      reference = resolucao.reference;
    }

    // LOSS registra o resultado da rodada sem mover saldo.
    if (!transaction.affectsBalance()) {
      transaction.markProcessed({ observedBalance: wallet.balance, at: now });
      await ctx.transactions.update(transaction);
      await this.enfileira(ctx, [
        WagerTransactionProcessed.from(transaction, this.eventContext(params)),
      ]);
      return { kind: ApplyOutcomeKind.Processed, balance: wallet.balance.toJSON() };
    }

    const direction = transaction.ledgerDirectionFor(reference);

    if (direction === LedgerDirection.Debit && !wallet.hasSufficientBalance(transaction.money)) {
      // Codigos distintos de proposito: aposta sem saldo e operacao normal,
      // reversao que nao cabe significa estado inconsistente com o provedor.
      return this.rejeita(
        params,
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
      // O FOR UPDATE deveria ter impedido. Chegar aqui e bug de caminho, e a
      // metrica separa isso de contencao real: `version_mismatch` e **bug**,
      // `deadlock` e carga.
      this.metrics.lockConflictDetected("version_mismatch");
      throw new InvariantViolationError(
        `saldo da carteira ${wallet.id} mudou sob o lock (version esperada ${versionBefore})`,
      );
    }

    const eventCtx = this.eventContext(params);
    await this.enfileira(ctx, [
      WagerTransactionProcessed.from(transaction, eventCtx),
      WalletBalanceChanged.from(wallet, entry, { ...eventCtx, eventId: this.ids.next() }),
    ]);

    return { kind: ApplyOutcomeKind.Processed, balance: wallet.balance.toJSON() };
  }

  /**
   * Rejeita com o codigo informado, gravando e publicando o evento.
   *
   * Publico porque o worker de referencia ausente precisa rejeitar por conta
   * propria quando o TTL expira — e a construcao do evento tem que ficar num
   * lugar so.
   */
  async reject(params: ApplyParams, failureCode: FailureCode): Promise<ApplyOutcome> {
    return this.rejeita(params, failureCode);
  }

  private async rejeita(params: ApplyParams, failureCode: FailureCode): Promise<ApplyOutcome> {
    const { ctx, transaction, wallet, now } = params;
    transaction.reject({ code: failureCode, observedBalance: wallet.balance, at: now });
    await ctx.transactions.update(transaction);
    await this.enfileira(ctx, [
      WagerTransactionRejected.from(transaction, this.eventContext(params)),
    ]);

    return {
      kind: ApplyOutcomeKind.Rejected,
      failureCode,
      balance: wallet.balance.toJSON(),
    };
  }

  /**
   * Resolve e valida a referencia. Referencia ausente **nao** e rejeicao: com
   * entrega at-least-once e sem ordenacao garantida, um ROLLBACK chegar antes
   * da BET e comportamento normal. Rejeitar ali deixaria o provedor achando que
   * reverteu enquanto nosso saldo diz que nao.
   */
  private async resolveReference(
    ctx: TransactionalContext,
    transaction: WagerTransaction,
  ): Promise<
    | { reference: WagerTransaction; pending: false }
    | { pending: true }
    | { failureCode: FailureCode }
  > {
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
    // Consultado sob o lock da carteira: duas reversoes da mesma referencia
    // tocam a mesma carteira, entao o FOR UPDATE ja as serializa.
    if (await ctx.transactions.findProcessedReversalOf(reference.id)) {
      return { failureCode: FailureCode.ReferenceAlreadyReversed };
    }

    return { reference, pending: false };
  }

  private eventContext(params: ApplyParams): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: params.now,
    };
  }

  private async enfileira(
    ctx: TransactionalContext,
    events: ReadonlyArray<Parameters<typeof OutboxMessage.enqueue>[0]>,
  ): Promise<void> {
    await ctx.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
  }
}
