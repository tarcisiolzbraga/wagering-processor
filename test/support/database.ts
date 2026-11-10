import { MikroORM } from "@mikro-orm/postgresql";

import { loadEnv } from "../../src/config/env";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";

/**
 * Abre o ORM com o schema recriado do zero.
 *
 * Nao e higiene opcional: ledger e transacoes sao append-only no banco, entao
 * nao existe DELETE para limpar entre execucoes. Sem reset por arquivo, as
 * filas globais acumulam entre rodadas — `findAwaitingReference` e `claimDue`
 * passam a devolver linhas de rodadas anteriores, e a assercao falha por
 * motivo alheio ao que o teste mede. Sem recuperacao possivel, porque nem o
 * TRUNCATE e permitido.
 */
export async function openOrmWithFreshSchema(): Promise<MikroORM> {
  const orm = await MikroORM.init(buildOrmConfig(loadEnv()));
  const conn = orm.em.getConnection();
  await conn.execute("drop schema public cascade");
  await conn.execute("create schema public");
  await orm.getMigrator().up();
  return orm;
}
