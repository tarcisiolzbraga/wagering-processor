import type {
  InboxRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletLedgerRepository,
  WalletRepository,
} from "./repositories";

/**
 * Repositorios ligados a **uma** transacao SQL. Receber o contexto em vez de
 * injetar repositorios soltos torna estrutural a exigencia do enunciado: inbox,
 * alteracao de saldo, ledger e outbox participam da mesma transacao, ou tudo e
 * confirmado junto, ou nada e.
 */
export interface TransactionalContext {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: WalletLedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;

  /** Leitura fora de transacao, para consultas que nao escrevem nada. */
  read<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
