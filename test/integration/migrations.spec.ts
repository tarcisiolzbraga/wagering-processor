import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { openOrmWithFreshSchema } from "../support/database";

let orm: MikroORM;

/**
 * O que o schema tem agora, do ponto de vista de um `pg_dump` resumido.
 *
 * Compara tabela, coluna, tipo enum, função e trigger. Uma reversão que deixa
 * um tipo ou um trigger para trás não é reversão: a próxima aplicação falha
 * com "already exists", e quem descobre é quem está tentando voltar uma versão
 * em produção.
 */
async function retratoDoSchema(): Promise<{
  tabelas: string[];
  colunas: string[];
  enums: string[];
  funcoes: string[];
  triggers: string[];
}> {
  const conn = orm.em.getConnection();
  const lista = async (sql: string): Promise<string[]> =>
    ((await conn.execute(sql)) as Array<{ nome: string }>).map((l) => l.nome).sort();

  return {
    tabelas: await lista(
      "select tablename as nome from pg_tables where schemaname = 'public'",
    ),
    colunas: await lista(
      `select table_name || '.' || column_name || ':' || data_type as nome
         from information_schema.columns where table_schema = 'public'`,
    ),
    enums: await lista(
      `select t.typname as nome from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typtype = 'e'`,
    ),
    funcoes: await lista(
      `select p.proname as nome from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    ),
    triggers: await lista(
      "select tgname as nome from pg_trigger where not tgisinternal",
    ),
  };
}

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
});

afterAll(async () => {
  // Deixa o banco aplicado para os arquivos seguintes, independente do que
  // este teste tenha feito no meio.
  await orm.getMigrator().up();
  await orm.close(true);
});

describe("migrations", () => {
  it("estao aplicadas e registradas", async () => {
    const aplicadas = await orm.getMigrator().getExecutedMigrations();

    expect(aplicadas.length).toBeGreaterThanOrEqual(3);
    expect(aplicadas.every((m) => m.name.startsWith("Migration2026"))).toBe(true);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
  });

  it("revertem todas sem deixar objeto para tras", async () => {
    const migrator = orm.getMigrator();
    await migrator.up();

    await migrator.down({ to: 0 });

    const vazio = await retratoDoSchema();
    // Só a tabela de controle do próprio migrator sobrevive: ela não é nossa.
    expect(vazio.tabelas).toEqual(["mikro_orm_migrations"]);
    expect(vazio.enums).toEqual([]);
    expect(vazio.funcoes).toEqual([]);
    expect(vazio.triggers).toEqual([]);
    expect(await migrator.getExecutedMigrations()).toHaveLength(0);
  });

  it("reaplicam e devolvem o schema identico ao de antes", async () => {
    const migrator = orm.getMigrator();
    // Cada teste parte do schema aplicado: o anterior deixou o banco vazio, e
    // depender da ordem faria este medir outra coisa.
    await migrator.up();
    const antes = await retratoDoSchema();

    await migrator.down({ to: 0 });
    await migrator.up();

    // Igualdade estrutural, não "subiu sem erro": uma migration cujo `down`
    // esquece uma coluna sobe de novo com o schema diferente, e a diferença
    // só aparece muito depois, numa consulta que some com uma coluna.
    expect(await retratoDoSchema()).toEqual(antes);
  });

  it("o ciclo completo pode ser repetido", async () => {
    const migrator = orm.getMigrator();
    await migrator.up();

    for (let volta = 0; volta < 2; volta += 1) {
      await migrator.down({ to: 0 });
      await migrator.up();
    }

    expect(await migrator.getPendingMigrations()).toHaveLength(0);
    const retrato = await retratoDoSchema();
    expect(retrato.tabelas).toContain("wallets");
    expect(retrato.tabelas).toContain("wallet_ledger_entries");
    expect(retrato.triggers.length).toBeGreaterThan(0);
  });
});
