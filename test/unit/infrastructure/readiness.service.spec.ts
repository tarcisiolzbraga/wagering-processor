import { describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";

import { ReadinessService } from "../../../src/infrastructure/http/health/readiness.service";
import { loadEnv } from "../../../src/config/env";

interface Dobles {
  readonly pendentes?: string[];
  readonly bancoFora?: boolean;
  readonly filaFora?: boolean;
}

/**
 * Dobles mínimos: o que está sendo medido aqui é a decisão de prontidão, não
 * o driver. Postgres e SQS reais têm a sua própria bateria nos testes de
 * integração.
 */
function servico({ pendentes = [], bancoFora = false, filaFora = false }: Dobles): ReadinessService {
  const orm = {
    em: {
      getConnection: () => ({
        execute: async () => {
          if (bancoFora) throw new Error("conexao recusada");
          return [{ "?column?": 1 }];
        },
      }),
    },
    getMigrator: () => ({
      getPendingMigrations: async () => pendentes.map((name) => ({ name })),
    }),
  } as unknown as MikroORM;

  const sqs = {
    send: async () => {
      if (filaFora) throw new Error("fila inalcancavel");
      return {};
    },
  } as unknown as SQSClient;

  return new ReadinessService(orm, sqs, loadEnv());
}

const probe = (resultado: { probes: readonly { name: string; ok: boolean; error?: string }[] }, nome: string) =>
  resultado.probes.find((p) => p.name === nome);

describe("ReadinessService", () => {
  it("pronto quando banco, schema e fila respondem", async () => {
    const resultado = await servico({}).check();

    expect(resultado.ok).toBe(true);
    expect(resultado.probes.map((p) => p.name).sort()).toEqual(["postgres", "schema", "sqs"]);
  });

  it("banco alcancavel com migrations pendentes NAO e pronto", async () => {
    // Com `select 1` sozinho, uma instancia apontada para um banco sem schema
    // respondia 200 e so falhava na primeira operacao de negocio, com 500. O
    // balanceador precisa saber antes de mandar a primeira aposta.
    const resultado = await servico({ pendentes: ["Migration20261110160000"] }).check();

    expect(resultado.ok).toBe(false);
    expect(probe(resultado, "postgres")?.ok).toBe(true);
    expect(probe(resultado, "schema")?.ok).toBe(false);
    // O motivo nomeia o que falta: "nao pronto" sem causa manda o operador
    // procurar no escuro.
    expect(probe(resultado, "schema")?.error).toContain("Migration20261110160000");
  });

  it("banco fora derruba as duas probes de banco, e a fila segue sua sorte", async () => {
    const resultado = await servico({ bancoFora: true }).check();

    expect(resultado.ok).toBe(false);
    expect(probe(resultado, "postgres")?.ok).toBe(false);
    expect(probe(resultado, "sqs")?.ok).toBe(true);
  });

  it("fila fora tambem impede trafego", async () => {
    const resultado = await servico({ filaFora: true }).check();

    expect(resultado.ok).toBe(false);
    expect(probe(resultado, "sqs")?.ok).toBe(false);
    expect(probe(resultado, "postgres")?.ok).toBe(true);
  });

  it("cada probe reporta a propria latencia", async () => {
    const resultado = await servico({}).check();

    for (const p of resultado.probes) {
      expect(p.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });
});
