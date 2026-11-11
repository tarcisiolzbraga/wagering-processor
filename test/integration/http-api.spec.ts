import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { openOrmWithFreshSchema } from "../support/database";
import { startTestApp, type TestApp } from "../support/http-app";

let app: TestApp;
let orm: MikroORM;

const uuid = (): string => crypto.randomUUID();

interface Resposta {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

async function pede(
  metodo: string,
  caminho: string,
  opcoes: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Resposta> {
  const resposta = await fetch(`${app.baseUrl}${caminho}`, {
    method: metodo,
    headers: {
      ...(opcoes.body === undefined ? {} : { "content-type": "application/json" }),
      ...opcoes.headers,
    },
    ...(opcoes.body === undefined ? {} : { body: JSON.stringify(opcoes.body) }),
  });

  const texto = await resposta.text();
  return {
    status: resposta.status,
    body: texto.length > 0 ? (JSON.parse(texto) as Record<string, unknown>) : {},
    headers: resposta.headers,
  };
}

async function abreCarteira(saldo = "1000.00"): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuid();
  const resposta = await pede("POST", "/wallets", {
    body: { playerId, initialBalance: { amount: saldo, currency: "BRL" } },
  });
  expect(resposta.status).toBe(201);
  return { walletId: resposta.body["id"] as string, playerId };
}

function corpoDeAposta(
  walletId: string,
  playerId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId: "provider-a",
    externalTransactionId: `external-${uuid()}`,
    playerId,
    walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...over,
  };
}

const submete = (corpo: Record<string, unknown>, chave: string): Promise<Resposta> =>
  pede("POST", "/wagering/transactions", { body: corpo, headers: { "Idempotency-Key": chave } });

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  await orm.close(true);
  app = await startTestApp();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("health", () => {
  it("liveness nao consulta dependencia externa", async () => {
    const resposta = await pede("GET", "/health/live");
    expect(resposta.status).toBe(200);
    expect(resposta.body["status"]).toBe("ok");
  });

  it("readiness reporta cada probe com latencia", async () => {
    const resposta = await pede("GET", "/health/ready");
    expect(resposta.status).toBe(200);
    const probes = resposta.body["probes"] as Array<{ name: string; ok: boolean }>;
    // `schema` entra aqui: banco alcancavel com migration pendente nao e
    // pronto para receber trafego.
    expect(probes.map((p) => p.name).sort()).toEqual(["postgres", "schema", "sqs"]);
    expect(probes.every((p) => p.ok)).toBe(true);
  });
});

describe("correlationId", () => {
  it("ecoa o id enviado pelo cliente", async () => {
    const resposta = await pede("GET", "/health/live", {
      headers: { "x-correlation-id": "meu-id-123" },
    });
    expect(resposta.headers.get("x-correlation-id")).toBe("meu-id-123");
  });

  it("gera um quando o cliente nao manda", async () => {
    const resposta = await pede("GET", "/health/live");
    expect(resposta.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("POST /wallets", () => {
  it("201 com OPENING e lancamento", async () => {
    const playerId = uuid();
    const resposta = await pede("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } },
    });

    expect(resposta.status).toBe(201);
    expect(resposta.body["balance"]).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(resposta.body["version"]).toBe(1);

    const extrato = await pede("GET", `/wallets/${resposta.body["id"] as string}/ledger`);
    expect((extrato.body["entries"] as unknown[]).length).toBe(1);
  });

  it("409 na segunda carteira do mesmo player e moeda", async () => {
    const playerId = uuid();
    await pede("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "10.00", currency: "BRL" } },
    });
    const segunda = await pede("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "99.00", currency: "BRL" } },
    });

    expect(segunda.status).toBe(409);
    expect(segunda.body["error"]).toBe("WALLET_ALREADY_EXISTS");
    // Devolve a carteira existente, nao a que foi pedida.
    expect(segunda.body["balance"]).toEqual({ amount: "10.00", currency: "BRL" });
  });

  it("400 quando o valor viola a regra de escala", async () => {
    const resposta = await pede("POST", "/wallets", {
      body: { playerId: uuid(), initialBalance: { amount: "10.999", currency: "BRL" } },
    });
    expect(resposta.status).toBe(400);
    expect(resposta.body["error"]).toBe("INVALID_PAYLOAD");
    expect(resposta.body["retryable"]).toBe(false);
  });
});

describe("POST /wagering/transactions — mapa de status", () => {
  it("200 quando aplica", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    const resposta = await submete(corpoDeAposta(walletId, playerId), "provider-a:ok");

    expect(resposta.status).toBe(200);
    expect(resposta.body["status"]).toBe("PROCESSED");
    expect(resposta.body["balance"]).toEqual({ amount: "75.00", currency: "BRL" });
    expect(resposta.body["idempotentReplay"]).toBe(false);
  });

  it("200 com idempotentReplay no reenvio identico", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    const corpo = corpoDeAposta(walletId, playerId);
    const chave = `provider-a:${uuid()}`;

    const primeira = await submete(corpo, chave);
    const replay = await submete(corpo, chave);

    expect(replay.status).toBe(200);
    expect(replay.body["idempotentReplay"]).toBe(true);
    expect(replay.body["transactionId"]).toBe(primeira.body["transactionId"]);
    expect(replay.body["balance"]).toEqual(primeira.body["balance"]);
  });

  it("422 com failureCode na rejeicao de negocio", async () => {
    const { walletId, playerId } = await abreCarteira("10.00");
    const resposta = await submete(
      corpoDeAposta(walletId, playerId, { money: { amount: "500.00", currency: "BRL" } }),
      `provider-a:${uuid()}`,
    );

    // Bem formada e compreendida: foi o dominio que disse nao. Nao e 400.
    expect(resposta.status).toBe(422);
    expect(resposta.body["failureCode"]).toBe("INSUFFICIENT_FUNDS");
    expect(resposta.body["status"]).toBe("REJECTED");
    expect(resposta.body["balance"]).toEqual({ amount: "10.00", currency: "BRL" });
  });

  it("202 quando a referencia ainda nao chegou", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    const resposta = await submete(
      corpoDeAposta(walletId, playerId, {
        kind: "ROLLBACK",
        referenceExternalTransactionId: `ausente-${uuid()}`,
      }),
      `provider-a:${uuid()}`,
    );

    expect(resposta.status).toBe(202);
    expect(resposta.body["status"]).toBe("PENDING_REFERENCE");
  });

  it("409 na mesma key com payload diferente", async () => {
    const { walletId, playerId } = await abreCarteira("1000.00");
    const corpo = corpoDeAposta(walletId, playerId);
    const chave = `provider-a:${uuid()}`;

    await submete(corpo, chave);
    const conflito = await submete(
      { ...corpo, money: { amount: "999.00", currency: "BRL" } },
      chave,
    );

    expect(conflito.status).toBe(409);
    expect(conflito.body["error"]).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(conflito.body["idempotentReplay"]).toBe(false);
  });

  it("409 na mesma operacao reapresentada com outra key", async () => {
    const { walletId, playerId } = await abreCarteira("1000.00");
    const corpo = corpoDeAposta(walletId, playerId);

    await submete(corpo, `provider-a:${uuid()}`);
    const duplicada = await submete(corpo, `provider-a:outra-${uuid()}`);

    expect(duplicada.status).toBe(409);
    expect(duplicada.body["error"]).toBe("DUPLICATE_EXTERNAL_TRANSACTION");
  });

  it("422 em OPENING submetido pela API", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    const resposta = await submete(
      corpoDeAposta(walletId, playerId, { kind: "OPENING" }),
      `provider-a:${uuid()}`,
    );
    expect(resposta.status).toBe(422);
    expect(resposta.body["failureCode"]).toBe("INTERNAL_KIND_NOT_SUBMITTABLE");
  });

  it("422 em REFUND sem referencia", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    const resposta = await submete(
      corpoDeAposta(walletId, playerId, { kind: "REFUND" }),
      `provider-a:${uuid()}`,
    );
    expect(resposta.status).toBe(422);
    expect(resposta.body["failureCode"]).toBe("MISSING_REFERENCE");
  });
});

describe("POST /wagering/transactions — payload invalido da 400", () => {
  const casos: ReadonlyArray<[string, Record<string, unknown> | undefined, string | undefined]> = [
    ["sem Idempotency-Key", {}, undefined],
    ["kind desconhecido", { kind: "TRANSFER" }, "k"],
    ["campo desconhecido no corpo", { extra: 1 }, "k"],
    ["valor com 3 casas", { money: { amount: "25.123", currency: "BRL" } }, "k"],
    ["moeda minuscula", { money: { amount: "25.00", currency: "brl" } }, "k"],
    ["walletId nao-UUID", { walletId: "wallet-42" }, "k"],
    ["playerId nao-UUID", { playerId: "player-42" }, "k"],
    ["roundId vazio", { roundId: "" }, "k"],
  ];

  for (const [rotulo, over, chave] of casos) {
    it(`400 — ${rotulo}`, async () => {
      const { walletId, playerId } = await abreCarteira("100.00");
      const corpo = corpoDeAposta(walletId, playerId, over ?? {});
      const resposta =
        chave === undefined
          ? await pede("POST", "/wagering/transactions", { body: corpo })
          : await submete(corpo, `provider-a:${uuid()}`);

      expect(resposta.status).toBe(400);
      expect(resposta.body["error"]).toBe("INVALID_PAYLOAD");
      expect(resposta.body["retryable"]).toBe(false);
    });
  }
});

describe("consultas", () => {
  it("GET /wallets/:id", async () => {
    const { walletId } = await abreCarteira("100.00");
    const resposta = await pede("GET", `/wallets/${walletId}`);
    expect(resposta.status).toBe(200);
    expect(resposta.body["id"]).toBe(walletId);
  });

  it("404 em carteira inexistente e 400 em id malformado", async () => {
    expect((await pede("GET", `/wallets/${uuid()}`)).status).toBe(404);
    expect((await pede("GET", "/wallets/abc")).status).toBe(400);
  });

  it("GET /wallets/:id/ledger pagina com cursor opaco", async () => {
    const { walletId, playerId } = await abreCarteira("1000.00");
    for (let i = 0; i < 3; i += 1) {
      await submete(
        corpoDeAposta(walletId, playerId, { money: { amount: "10.00", currency: "BRL" } }),
        `provider-a:${uuid()}`,
      );
    }

    const primeira = await pede("GET", `/wallets/${walletId}/ledger?limit=2`);
    expect(primeira.status).toBe(200);
    expect((primeira.body["entries"] as unknown[]).length).toBe(2);
    const cursor = primeira.body["nextCursor"] as string;
    expect(cursor).toBeTypeOf("string");
    expect(cursor).not.toContain(walletId);

    const segunda = await pede(
      "GET",
      `/wallets/${walletId}/ledger?limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    const idsPrimeira = (primeira.body["entries"] as Array<{ id: string }>).map((e) => e.id);
    const idsSegunda = (segunda.body["entries"] as Array<{ id: string }>).map((e) => e.id);
    expect(idsPrimeira.some((id) => idsSegunda.includes(id))).toBe(false);
  });

  it("400 em limite de pagina fora da faixa", async () => {
    const { walletId } = await abreCarteira("100.00");
    for (const limite of ["0", "-1", "500", "abc"]) {
      const resposta = await pede("GET", `/wallets/${walletId}/ledger?limit=${limite}`);
      expect(resposta.status).toBe(400);
    }
  });

  it("GET por id interno e por (provider, external id)", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    const externalId = `external-${uuid()}`;
    const aplicada = await submete(
      corpoDeAposta(walletId, playerId, { externalTransactionId: externalId }),
      `provider-a:${uuid()}`,
    );
    const transactionId = aplicada.body["transactionId"] as string;

    const porId = await pede("GET", `/wagering/transactions/${transactionId}`);
    expect(porId.status).toBe(200);
    expect(porId.body["status"]).toBe("PROCESSED");

    const porExterno = await pede(
      "GET",
      `/providers/provider-a/wagering/transactions/${externalId}`,
    );
    expect(porExterno.status).toBe(200);
    expect(porExterno.body["id"]).toBe(transactionId);
  });

  it("404 em transacao inexistente", async () => {
    expect((await pede("GET", `/wagering/transactions/${uuid()}`)).status).toBe(404);
    expect(
      (await pede("GET", "/providers/provider-a/wagering/transactions/nao-existe")).status,
    ).toBe(404);
  });
});

describe("normalizacao de UUID", () => {
  it("playerId em maiusculas nao vira PLAYER_MISMATCH", async () => {
    // O PostgreSQL grava `uuid` em minusculas. Sem normalizar na fronteira, a
    // comparacao contra o valor lido falhava, gravava uma linha REJECTED, e aí
    // o UNIQUE de (provider, external id) fazia a reapresentacao corrigida
    // devolver 409 para sempre — aposta legitima perdida de forma definitiva.
    const { walletId, playerId } = await abreCarteira("100.00");
    const resposta = await submete(
      corpoDeAposta(walletId, playerId.toUpperCase()),
      `provider-a:${uuid()}`,
    );

    expect(resposta.status).toBe(200);
    expect(resposta.body["status"]).toBe("PROCESSED");
    expect(resposta.body["balance"]).toEqual({ amount: "75.00", currency: "BRL" });
  });

  it("walletId em maiusculas tambem resolve a carteira", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    const resposta = await submete(
      corpoDeAposta(walletId.toUpperCase(), playerId),
      `provider-a:${uuid()}`,
    );
    expect(resposta.status).toBe(200);
  });

  it("a mesma operacao em caixa diferente e replay, nao conflito", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    const externalId = `external-${uuid()}`;
    const chave = `provider-a:${externalId}`;

    await submete(corpoDeAposta(walletId, playerId, { externalTransactionId: externalId }), chave);
    const replay = await submete(
      corpoDeAposta(walletId.toUpperCase(), playerId.toUpperCase(), {
        externalTransactionId: externalId,
      }),
      chave,
    );

    expect(replay.status).toBe(200);
    expect(replay.body["idempotentReplay"]).toBe(true);
  });

  it("POST /wallets devolve o playerId como foi gravado", async () => {
    const playerId = uuid().toUpperCase();
    const resposta = await pede("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "10.00", currency: "BRL" } },
    });
    expect(resposta.status).toBe(201);
    expect(resposta.body["playerId"]).toBe(playerId.toLowerCase());
  });

  it("POST /wallets com playerId malformado da 400, nao 500", async () => {
    const resposta = await pede("POST", "/wallets", {
      body: { playerId: "player-42", initialBalance: { amount: "10.00", currency: "BRL" } },
    });
    expect(resposta.status).toBe(400);
    expect(resposta.body["error"]).toBe("INVALID_PAYLOAD");
  });
});

describe("cursor adulterado", () => {
  it("da 400, nao 500", async () => {
    const { walletId } = await abreCarteira("100.00");

    const adulterados = [
      "nao-e-base64",
      Buffer.from(JSON.stringify({ t: "2026-11-11T00:00:00.000Z", i: "nao-uuid" })).toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ t: "data-invalida", i: uuid() })).toString("base64url"),
      Buffer.from(JSON.stringify({ outra: "forma" })).toString("base64url"),
    ];

    for (const cursor of adulterados) {
      const resposta = await pede(
        "GET",
        `/wallets/${walletId}/ledger?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(resposta.status).toBe(400);
      expect(resposta.body["error"]).toBe("INVALID_PAYLOAD");
    }
  });
});

describe("POST /wallets/:id/reconciliation", () => {
  it("200, nao 201: nao cria recurso nenhum", async () => {
    const { walletId, playerId } = await abreCarteira("100.00");
    await submete(corpoDeAposta(walletId, playerId), `provider-a:${uuid()}`);

    const resposta = await pede("POST", `/wallets/${walletId}/reconciliation`);
    expect(resposta.status).toBe(200);
    expect(resposta.body).toEqual({
      walletId,
      storedBalance: { amount: "75.00", currency: "BRL" },
      calculatedBalance: { amount: "75.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it("404 em carteira inexistente", async () => {
    expect((await pede("POST", `/wallets/${uuid()}/reconciliation`)).status).toBe(404);
  });
});

describe("os endpoints de health ficam abertos", () => {
  it("nao exigem header nenhum", async () => {
    for (const caminho of ["/health/live", "/health/ready"]) {
      expect((await pede("GET", caminho)).status).toBe(200);
    }
  });
});
