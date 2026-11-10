import { IsolationLevel, type EntityManager, type MikroORM } from "@mikro-orm/postgresql";

import type {
  TransactionalContext,
  UnitOfWork,
} from "../../application/ports/unit-of-work";
import { MikroInboxRepository, MikroOutboxRepository } from "./repositories/messaging.repository";
import { MikroWagerTransactionRepository } from "./repositories/wager-transaction.repository";
import { MikroWalletLedgerRepository } from "./repositories/wallet-ledger.repository";
import { MikroWalletRepository } from "./repositories/wallet.repository";

function contextFor(em: EntityManager): TransactionalContext {
  return {
    wallets: new MikroWalletRepository(em),
    transactions: new MikroWagerTransactionRepository(em),
    ledger: new MikroWalletLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
  };
}

/**
 * Todos os repositorios de um `run` compartilham o mesmo EntityManager, e
 * portanto a mesma transacao SQL. E isso que torna estrutural a exigencia de
 * atomicidade entre inbox, saldo, ledger e outbox: nao existe forma de uma
 * dessas escritas cair fora da transacao.
 *
 * Nenhum repositorio chama `flush()`: toda escrita e explicita (insert direto,
 * update com clausula propria). O Identity Map continua util para leitura
 * dentro da transacao, mas nao ha escrita implicita do Unit of Work que possa
 * reordenar statements ou gravar estado obsoleto.
 */
export class MikroUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return this.orm.em.transactional((em) => work(contextFor(em as EntityManager)));
  }

  /**
   * Leitura em REPEATABLE READ, nao em autocommit.
   *
   * Sem transacao, cada statement ve um snapshot diferente, e a reconciliacao
   * — que compara o saldo materializado com a soma do ledger em duas consultas
   * — acusaria divergencia falsa se uma aposta commitasse entre as duas. Um
   * alarme de inconsistencia financeira que nao existe e pior que nenhum
   * alarme: ensina a ignorar o alarme.
   */
  async read<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return this.orm.em.transactional((em) => work(contextFor(em as EntityManager)), {
      isolationLevel: IsolationLevel.REPEATABLE_READ,
    });
  }
}
