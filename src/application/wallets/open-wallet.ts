import { WagerTransactionProcessed, WalletBalanceChanged } from "../../domain/events/wager-transaction-events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import {
  WagerTransactionKind,
  WagerTransactionSource,
} from "../../domain/wagering/wager-transaction-kind";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { UnitOfWork } from "../ports/unit-of-work";
import { assertUuid } from "../shared/assert-uuid";

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
}

export enum OpenWalletOutcome {
  Opened = "OPENED",
  AlreadyExists = "ALREADY_EXISTS",
}

export interface OpenWalletResult {
  readonly outcome: OpenWalletOutcome;
  readonly walletId: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

/**
 * Abre a carteira e, quando ha saldo inicial, grava a transacao interna
 * `OPENING` com o lancamento `CREDIT` correspondente **na mesma transacao SQL**.
 *
 * `Wallet.open` devolve o lancamento junto, entao nao existe caminho que crie
 * carteira com saldo sem lancamento: a invariante nao depende deste use case
 * lembrar de creditar.
 */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async run(command: OpenWalletCommand): Promise<OpenWalletResult> {
    // Validado e normalizado aqui, nao no controller: qualquer canal que abra
    // carteira passa por este use case. Sem isso, um playerId malformado
    // chegava na coluna `uuid` e virava 500 em vez de 400.
    const playerId = assertUuid("playerId", command.playerId);

    const now = this.clock.now();
    const initialBalance = Money.from(command.initialBalance);
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      now,
    });

    return this.uow.run(async (ctx) => {
      if (!(await ctx.wallets.insertIfAbsent(wallet))) {
        const existente = await ctx.wallets.findByPlayerAndCurrency(
          playerId,
          initialBalance.currency,
        );
        if (!existente) {
          throw new Error(
            `conflito de carteira para ${playerId}/${initialBalance.currency} sem linha correspondente`,
          );
        }
        return {
          outcome: OpenWalletOutcome.AlreadyExists,
          walletId: existente.id,
          playerId: existente.playerId,
          balance: existente.balance.toJSON(),
          version: existente.version,
        };
      }

      if (openingEntry) {
        const abertura = WagerTransaction.create({
          id: openingTransactionId,
          providerId: "internal",
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `internal:opening:${walletId}`,
          payloadHash: `opening:${walletId}`,
          walletId,
          playerId,
          roundId: `opening:${walletId}`,
          gameId: "opening",
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
          source: WagerTransactionSource.Internal,
          createdAt: now,
        });
        abertura.markProcessed({ observedBalance: wallet.balance, at: now });

        await ctx.transactions.insertIfAbsent(abertura);
        await ctx.ledger.insert(openingEntry);

        const eventCtx = {
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          occurredAt: now,
        };
        await ctx.outbox.enqueue([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(abertura, eventCtx)),
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingEntry, {
              ...eventCtx,
              eventId: this.ids.next(),
            }),
          ),
        ]);
      }

      return {
        outcome: OpenWalletOutcome.Opened,
        walletId: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
