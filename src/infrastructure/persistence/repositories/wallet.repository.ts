import { LockMode, type EntityManager } from "@mikro-orm/postgresql";

import type { WalletRepository } from "../../../application/ports/repositories";
import type { Wallet } from "../../../domain/wallet/wallet";
import { walletSchema, WalletEntity } from "../entities/wallet.entity";
import { WalletMapper } from "../mappers/wallet.mapper";

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * `LockMode.PESSIMISTIC_WRITE` gera `SELECT ... FOR UPDATE`. Bloqueia em vez
   * de abortar, o que da latencia previsivel em vez de retry, e deixa a decisao
   * de negocio no dominio com o estado garantidamente estavel ate o commit.
   */
  async findByIdForUpdate(walletId: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(
      walletSchema,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return entity ? WalletMapper.toDomain(entity) : undefined;
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(walletSchema, { id: walletId });
    return entity ? WalletMapper.toDomain(entity) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(walletSchema, { playerId, currency });
    return entity ? WalletMapper.toDomain(entity) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    const entity = WalletMapper.toEntity(wallet, new WalletEntity());
    await this.em.insert(walletSchema, entity);
  }

  /**
   * Segunda camada de defesa. O `FOR UPDATE` **previne** a corrida; este
   * `WHERE version = ?` **detecta** um caminho de codigo que esqueceu o lock,
   * devolvendo false em vez de sobrescrever saldo.
   */
  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<boolean> {
    const balance = wallet.balance.toJSON();
    const result = await this.em
      .createQueryBuilder(walletSchema)
      .update({
        balanceAmount: balance.amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      })
      .where({ id: wallet.id, version: expectedVersion })
      .execute("run");

    return result.affectedRows === 1;
  }
}
