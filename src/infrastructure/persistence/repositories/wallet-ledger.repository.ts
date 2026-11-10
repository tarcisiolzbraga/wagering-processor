import type { EntityManager } from "@mikro-orm/postgresql";

import type {
  LedgerPage,
  WalletLedgerRepository,
} from "../../../application/ports/repositories";
import { Money } from "../../../domain/money/money";
import { InvalidInputError } from "../../../domain/shared/domain-error";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import {
  walletLedgerEntrySchema,
  WalletLedgerEntryEntity,
} from "../entities/wallet-ledger-entry.entity";
import { WalletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper";
import { decodeCursor, encodeCursor } from "./ledger-cursor";

/**
 * Soma do ledger pode ser negativa se houver inconsistencia, e nesse caso o
 * endpoint de reconciliacao precisa **reportar** a divergencia, nao estourar.
 * `Money.from` recusa negativo em contrato de entrada, entao o sinal e aplicado
 * pelo dominio.
 */
function signedMoney(amount: string, currency: string): Money {
  if (amount.startsWith("-")) {
    return Money.zero(currency).subtract(Money.from({ amount: amount.slice(1), currency }));
  }
  return Money.from({ amount, currency });
}

const MAX_PAGE_SIZE = 200;

export class MikroWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    const entity = WalletLedgerEntryMapper.toEntity(entry, new WalletLedgerEntryEntity());
    await this.em.insert(walletLedgerEntrySchema, entity);
  }

  async page(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    // Limite zero devolveria pagina vazia sem cursor, indistinguivel de
    // "o extrato acabou". O teto evita que um cliente peca o historico inteiro
    // numa tacada.
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new InvalidInputError(
        `limite de pagina invalido: ${limit} (esperado inteiro entre 1 e ${MAX_PAGE_SIZE})`,
      );
    }

    const qb = this.em
      .createQueryBuilder(walletLedgerEntrySchema)
      .select("*")
      .where({ walletId });

    if (cursor !== undefined) {
      const { createdAt, id } = decodeCursor(cursor);
      // Comparacao de tupla: casa exatamente com o indice
      // (wallet_id, created_at desc, id desc).
      qb.andWhere("(created_at, id) < (?, ?)", [createdAt, id]);
    }

    // limit + 1 para descobrir se existe proxima pagina sem um count extra.
    const rows = await qb
      .orderBy({ createdAt: "desc", id: "desc" })
      .limit(limit + 1)
      .getResult();

    const pagina = rows.slice(0, limit);
    const ultima = pagina.at(-1);
    const nextCursor =
      rows.length > limit && ultima !== undefined
        ? encodeCursor({ createdAt: ultima.createdAt, id: ultima.id })
        : undefined;

    return {
      entries: pagina.map((row) => WalletLedgerEntryMapper.toDomain(row)),
      nextCursor,
    };
  }

  async reconstructBalance(walletId: string, currency: string): Promise<Money> {
    const rows = await this.em.getConnection().execute<Array<{ total: string }>>(
      `select coalesce(sum(case direction
                when 'CREDIT' then money_amount
                else -money_amount
              end), 0)::text as total
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
      "all",
      this.em.getTransactionContext(),
    );
    return signedMoney(rows[0]?.total ?? "0", currency);
  }

  async countEntries(walletId: string): Promise<number> {
    return this.em.count(walletLedgerEntrySchema, { walletId });
  }
}
