import { inboxMessageSchema } from "./inbox-message.entity";
import { outboxMessageSchema } from "./outbox-message.entity";
import { wagerTransactionSchema } from "./wager-transaction.entity";
import { walletLedgerEntrySchema } from "./wallet-ledger-entry.entity";
import { walletSchema } from "./wallet.entity";

/**
 * Lista explicita: a descoberta dinamica de arquivos esta desligada
 * (`discovery.disableDynamicFileAccess`), o que mantem o boot deterministico e
 * evita o ponto de atrito conhecido entre MikroORM e Bun. O custo e manter
 * esta lista a mao — uma linha por entidade.
 */
export const entitySchemas = [
  walletSchema,
  wagerTransactionSchema,
  walletLedgerEntrySchema,
  inboxMessageSchema,
  outboxMessageSchema,
];

export { InboxMessageEntity } from "./inbox-message.entity";
export { OutboxMessageEntity } from "./outbox-message.entity";
export { WagerTransactionEntity } from "./wager-transaction.entity";
export { WalletEntity } from "./wallet.entity";
export { WalletLedgerEntryEntity } from "./wallet-ledger-entry.entity";
