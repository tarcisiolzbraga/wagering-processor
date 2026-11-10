import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import type { Wallet } from "../../domain/wallet/wallet";

export interface WalletRepository {
  /**
   * Trava a linha da wallet com `SELECT ... FOR UPDATE` e devolve o agregado.
   *
   * E a unica secao critica do caminho financeiro. O lock cai exatamente sobre
   * a unidade de concorrencia declarada — uma linha, uma wallet — entao
   * carteiras diferentes nunca se bloqueiam.
   */
  findByIdForUpdate(walletId: string): Promise<Wallet | undefined>;

  findById(walletId: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;

  insert(wallet: Wallet): Promise<void>;

  /**
   * `UPDATE ... WHERE id = ? AND version = ?`. Devolve false quando nenhuma
   * linha casou, o que significa que outro caminho alterou o saldo sem o lock
   * — deteccao, nao prevencao: a prevencao e o FOR UPDATE.
   */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<boolean>;
}

export interface LedgerPage {
  readonly entries: readonly WalletLedgerEntry[];
  /** Cursor opaco para a proxima pagina; undefined quando acabou. */
  readonly nextCursor: string | undefined;
}

export interface WalletLedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;

  /**
   * Paginacao por cursor estavel `(created_at, id)`, nunca OFFSET.
   * `limit` tem que ser >= 1: um limite zero devolveria pagina vazia sem
   * cursor, indistinguivel de "o extrato acabou".
   */
  page(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;

  /** Soma do ledger — o lado independente da reconciliacao. */
  reconstructBalance(walletId: string, currency: string): Promise<Money>;

  countEntries(walletId: string): Promise<number>;
}

/**
 * Resultado do insert-first. Nao e booleano porque existem **duas** garantias
 * de unicidade e elas significam coisas diferentes para o provedor:
 *
 * - a idempotency key repetida pode ser replay legitimo (mesmo payload) ou
 *   conflito (payload diferente) — quem decide e a comparacao do payloadHash;
 * - o mesmo (provider, external id) com outra idempotency key e sempre bug do
 *   provedor: a mesma operacao reapresentada com identidade diferente.
 *
 * Colapsar as duas num booleano faria a segunda estourar como erro de
 * infraestrutura, e o consumer a leria como falha transitoria: retry infinito
 * de algo que nunca vai dar certo.
 */
export enum InsertTransactionOutcome {
  Inserted = "INSERTED",
  IdempotencyKeyExists = "IDEMPOTENCY_KEY_EXISTS",
  ExternalTransactionExists = "EXTERNAL_TRANSACTION_EXISTS",
}

export interface WagerTransactionRepository {
  /**
   * Insere a transacao em PENDING. O proprio insert e o teste de existencia,
   * sem a janela de corrida que um SELECT antes teria.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<InsertTransactionOutcome>;

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;

  update(transaction: WagerTransaction): Promise<void>;

  /** Fila do worker de referencia ausente, mais antigas primeiro. */
  findAwaitingReference(limit: number): Promise<readonly WagerTransaction[]>;
}

export interface InboxRepository {
  /** Devolve false quando (consumerName, messageId) ja existe. */
  receiveIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  /** Grava na mesma transacao SQL do dinheiro. Nao publica nada. */
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;

  /**
   * Reivindica um lote com `FOR UPDATE SKIP LOCKED`: publishers concorrentes
   * pegam lotes disjuntos sem se bloquear.
   */
  claimDue(limit: number, now: Date): Promise<readonly OutboxMessage[]>;

  markPublished(message: OutboxMessage): Promise<void>;
  scheduleRetry(message: OutboxMessage): Promise<void>;

  pendingCount(): Promise<number>;
  /** Idade da pendencia mais antiga em ms — a metrica de outbox lag. */
  oldestPendingAgeMs(now: Date): Promise<number>;
}
