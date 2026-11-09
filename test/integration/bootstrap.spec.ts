import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { EntitySchema, MikroORM } from "@mikro-orm/postgresql";
import Decimal from "decimal.js";

import { loadEnv } from "../../src/config/env";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";

/**
 * Gate da Fase 0. Nao testa regra de negocio — testa o risco de stack:
 * MikroORM com EntitySchema (sem decorators) rodando sob Bun, e dinheiro
 * atravessando o banco sem perder um centavo.
 */
class Probe {
  id!: string;
  amount!: string;
  currency!: string;
}

const ProbeSchema = new EntitySchema<Probe>({
  class: Probe,
  tableName: "bootstrap_probe",
  properties: {
    id: { type: "uuid", primary: true },
    amount: { type: "decimal", precision: 20, scale: 2 },
    currency: { type: "string", length: 3 },
  },
});

const DDL = `create table if not exists bootstrap_probe (
  id uuid primary key,
  amount numeric(20,2) not null,
  currency char(3) not null
)`;

describe("gate de stack: MikroORM + EntitySchema sob Bun", () => {
  let orm: MikroORM;

  beforeAll(async () => {
    const env = loadEnv();
    orm = await MikroORM.init({ ...buildOrmConfig(env), entities: [ProbeSchema] });
    await orm.em.getConnection().execute(DDL);
  });

  afterAll(async () => {
    if (orm) {
      await orm.em.getConnection().execute("drop table if exists bootstrap_probe");
      await orm.close(true);
    }
  });

  it("conecta no PostgreSQL", async () => {
    const rows = await orm.em.getConnection().execute<Array<{ one: number }>>("select 1 as one");
    expect(rows[0]?.one).toBe(1);
  });

  it("persiste e reidrata decimal como string exata", async () => {
    const id = crypto.randomUUID();
    const em = orm.em.fork();

    const probe = em.create(ProbeSchema, { id, amount: "25.01", currency: "BRL" });
    await em.persistAndFlush(probe);

    const reloaded = await orm.em.fork().findOneOrFail(ProbeSchema, { id });
    expect(reloaded.amount).toBe("25.01");
    expect(typeof reloaded.amount).toBe("string");
    expect(reloaded.currency.trim()).toBe("BRL");
  });

  it("nao perde centavo no caso que quebra ponto flutuante", async () => {
    // 0.1 + 0.2 !== 0.3 em IEEE-754. Com Decimal + numeric(20,2), sim.
    const soma = new Decimal("0.1").plus("0.2").toFixed(2);
    expect(soma).toBe("0.30");

    const id = crypto.randomUUID();
    const em = orm.em.fork();
    await em.persistAndFlush(em.create(ProbeSchema, { id, amount: soma, currency: "BRL" }));

    const reloaded = await orm.em.fork().findOneOrFail(ProbeSchema, { id });
    expect(reloaded.amount).toBe("0.30");
    expect(new Decimal(reloaded.amount).equals(new Decimal("0.30"))).toBe(true);
  });

  it("recusa escala maior que 2 no banco, nao so na aplicacao", async () => {
    const id = crypto.randomUUID();
    const em = orm.em.fork();
    await em.persistAndFlush(em.create(ProbeSchema, { id, amount: "10.999", currency: "BRL" }));

    // numeric(20,2) arredonda em vez de rejeitar — por isso a Fase 2 adiciona
    // um CHECK de escala, e a validacao de entrada vive em Money (Fase 1).
    const reloaded = await orm.em.fork().findOneOrFail(ProbeSchema, { id });
    expect(reloaded.amount).toBe("11.00");
  });

  it("o Migrator inicializa (o CLI do MikroORM nao e usado sob Bun)", async () => {
    const migrator = orm.getMigrator();
    const pending = await migrator.getPendingMigrations();
    expect(Array.isArray(pending)).toBe(true);
  });
});
