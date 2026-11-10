import type { MoneyProps } from "../money/money";
import { InvariantViolationError } from "../shared/domain-error";
import type { FailureCode } from "../shared/failure-code";
import type { LedgerDirection } from "../wallet/ledger-direction";
import type { Wallet } from "../wallet/wallet";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import type { WagerTransactionKind } from "../wagering/wager-transaction-kind";
import type { WagerTransaction } from "../wagering/wager-transaction";
import { IntegrationEvent, type EventContext } from "./integration-event";

/** Identidade da operacao, repetida em todos os eventos de transacao. */
interface TransactionIdentity {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
}

function identityOf(tx: WagerTransaction): TransactionIdentity {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends TransactionIdentity {
  readonly referenceTransactionId?: string | undefined;
  readonly affectedBalance: boolean;
  readonly processedAt: string;
}

/** Qualquer transacao aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...identityOf(tx),
        referenceTransactionId: tx.referenceTransactionId,
        affectedBalance: tx.affectsBalance(),
        processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionIdentity {
  readonly failureCode: FailureCode;
  readonly rejectedAt: string;
}

/** Transacao recusada por regra de negocio. Terminal e auditavel. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  get partitionKey(): string {
    return this.data.walletId;
  }

  /**
   * O codigo e lido da propria transacao, nao recebido por parametro: receber
   * permitiria publicar um codigo diferente do que foi persistido, e o provedor
   * decide o que fazer justamente a partir dele.
   */
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const failureCode = tx.failureCode;
    if (failureCode === undefined) {
      throw new InvariantViolationError(
        `transacao ${tx.id} nao tem failureCode — nao foi rejeitada`,
      );
    }
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...identityOf(tx),
        failureCode,
        rejectedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionIdentity {
  readonly referenceExternalTransactionId: string;
  readonly pendingSince: string;
}

/** Referencia ausente: a operacao fica aguardando e o provedor precisa saber. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...identityOf(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? "",
        pendingSince: (tx.pendingReferenceSince ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

/** Publicado **somente** quando o saldo muda — nunca para LOSS. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
