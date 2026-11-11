import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { openOrmWithFreshSchema } from "../support/database";
import { startTestApp, type TestApp } from "../support/http-app";

const ISSUER = "http://localhost:8080/realms/jungle";

let app: TestApp;
let orm: MikroORM;
let tokenA: string;
let tokenB: string;

const uuid = (): string => crypto.randomUUID();

/**
 * Pega um token de verdade no Keycloak do Compose, por client credentials.
 *
 * Sem mock de IdP: o que precisa valer é que o guard aceita o token que o
 * Keycloak realmente emite — com `aud` em lista, `azp` e a claim `providerId`
 * vinda do mapper do realm. Um duplo de JWKS passaria mesmo se o formato real
 * fosse outro.
 */
async function tokenDe(clientId: string, secret: string): Promise<string> {
  const resposta = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    }),
  });

  if (!resposta.ok) {
    throw new Error(`Keycloak recusou ${clientId}: ${resposta.status} ${await resposta.text()}`);
  }
  return ((await resposta.json()) as { access_token: string }).access_token;
}

interface Resposta {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function pede(
  metodo: string,
  caminho: string,
  opcoes: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<Resposta> {
  const resposta = await fetch(`${app.baseUrl}${caminho}`, {
    method: metodo,
    headers: {
      ...(opcoes.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opcoes.token === undefined ? {} : { authorization: `Bearer ${opcoes.token}` }),
      ...opcoes.headers,
    },
    ...(opcoes.body === undefined ? {} : { body: JSON.stringify(opcoes.body) }),
  });

  const texto = await resposta.text();
  return {
    status: resposta.status,
    body: texto.length > 0 ? (JSON.parse(texto) as Record<string, unknown>) : {},
  };
}

function corpoDeAposta(
  walletId: string,
  playerId: string,
  providerId: string,
): Record<string, unknown> {
  return {
    providerId,
    externalTransactionId: `external-${uuid()}`,
    playerId,
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
  };
}

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  // Autenticação ligada só aqui: o resto da suíte exercita a API sem token,
  // porque autenticação não é o que ela mede.
  app = await startTestApp("full", { AUTH_ENABLED: "true", KEYCLOAK_ISSUER_URL: ISSUER });
  tokenA = await tokenDe("provider-a", "provider-a-secret");
  tokenB = await tokenDe("provider-b", "provider-b-secret");
});

afterAll(async () => {
  await app.close();
  await orm.close(true);
});

async function carteira(token: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuid();
  const resposta = await pede("POST", "/wallets", {
    token,
    body: { playerId, initialBalance: { amount: "100.00", currency: "BRL" } },
  });
  expect(resposta.status).toBe(201);
  return { walletId: resposta.body["id"] as string, playerId };
}

describe("sem token", () => {
  it("endpoint de negócio responde 401", async () => {
    const resposta = await pede("GET", `/wallets/${uuid()}`);
    expect(resposta.status).toBe(401);
    expect(resposta.body["error"]).toBe("MISSING_TOKEN");
  });

  it("header malformado também é 401", async () => {
    for (const header of ["", "Bearer", "Basic abc", "Bearer   ", "token-solto"]) {
      const resposta = await pede("GET", `/wallets/${uuid()}`, {
        headers: { authorization: header },
      });
      expect(resposta.status).toBe(401);
    }
  });

  it("token inválido não revela por que foi recusado", async () => {
    const resposta = await pede("GET", `/wallets/${uuid()}`, { token: "a.b.c" });

    expect(resposta.status).toBe(401);
    expect(resposta.body["error"]).toBe("INVALID_TOKEN");
    // Dizer "assinatura inválida" contra "audience errada" daria ao atacante
    // um oráculo para descobrir o que falta no token forjado dele.
    expect(JSON.stringify(resposta.body)).not.toContain("signature");
    expect(JSON.stringify(resposta.body)).not.toContain("audience");
  });

  it("health e métricas continuam abertos", async () => {
    // O guard é aplicado por controller: health e /metrics simplesmente não o
    // recebem, então não há allowlist de caminhos para envelhecer.
    expect((await pede("GET", "/health/live")).status).toBe(200);
    expect((await pede("GET", "/health/ready")).status).toBe(200);
    expect((await fetch(`${app.baseUrl}/metrics`)).status).toBe(200);
  });
});

describe("com token do Keycloak", () => {
  it("aceita o token que o Keycloak emite de verdade", async () => {
    const { walletId } = await carteira(tokenA);
    const resposta = await pede("GET", `/wallets/${walletId}`, { token: tokenA });
    expect(resposta.status).toBe(200);
  });

  it("aceita esquema bearer em minúscula", async () => {
    // RFC 7235: o esquema é case-insensitive.
    const resposta = await pede("GET", `/wallets/${uuid()}`, {
      headers: { authorization: `bearer ${tokenA}` },
    });
    expect(resposta.status).toBe(404);
  });

  it("submete transação com o próprio providerId", async () => {
    const { walletId, playerId } = await carteira(tokenA);
    const corpo = corpoDeAposta(walletId, playerId, "provider-a");

    const resposta = await pede("POST", "/wagering/transactions", {
      token: tokenA,
      body: corpo,
      headers: { "idempotency-key": `provider-a:${String(corpo["externalTransactionId"])}` },
    });

    expect(resposta.status).toBe(200);
    expect(resposta.body["status"]).toBe("PROCESSED");
  });
});

describe("o provedor do token manda sobre o do payload", () => {
  it("submeter como outro provedor é 403", async () => {
    const { walletId, playerId } = await carteira(tokenA);
    const corpo = corpoDeAposta(walletId, playerId, "provider-a");

    // provider-b tem token válido e tenta submeter dizendo-se provider-a:
    // debitaria a carteira de um jogador que não é cliente dele.
    const resposta = await pede("POST", "/wagering/transactions", {
      token: tokenB,
      body: corpo,
      headers: { "idempotency-key": `provider-a:${String(corpo["externalTransactionId"])}` },
    });

    expect(resposta.status).toBe(403);
    expect(resposta.body["error"]).toBe("PROVIDER_MISMATCH");
  });

  it("a transação recusada por 403 não existe", async () => {
    const { walletId, playerId } = await carteira(tokenA);
    const corpo = corpoDeAposta(walletId, playerId, "provider-a");
    const externalId = String(corpo["externalTransactionId"]);

    await pede("POST", "/wagering/transactions", {
      token: tokenB,
      body: corpo,
      headers: { "idempotency-key": `provider-a:${externalId}` },
    });

    // Nada foi gravado: o confronto acontece antes do use case.
    const consulta = await pede(
      "GET",
      `/providers/provider-a/wagering/transactions/${externalId}`,
      { token: tokenA },
    );
    expect(consulta.status).toBe(404);
    const saldo = await pede("GET", `/wallets/${walletId}`, { token: tokenA });
    expect((saldo.body["balance"] as { amount: string }).amount).toBe("100.00");
  });

  it("não dá para ocupar a chave de idempotência de outro provedor", async () => {
    const { walletId, playerId } = await carteira(tokenB);
    const corpo = corpoDeAposta(walletId, playerId, "provider-b");

    // provider-b submete uma aposta legítima **dele**, mas com a chave do
    // espaço de provider-a. A unicidade de idempotency_key é global: se isso
    // passasse, a transação real de provider-a com a mesma chave colidiria e
    // receberia 409 para sempre.
    const resposta = await pede("POST", "/wagering/transactions", {
      token: tokenB,
      body: corpo,
      headers: { "idempotency-key": "provider-a:TX-DISPUTADA" },
    });

    expect(resposta.status).toBe(403);
    expect(resposta.body["error"]).toBe("IDEMPOTENCY_KEY_NOT_OWNED");

    // E a chave continua livre para o dono dela.
    const doDono = await carteira(tokenA);
    const legitima = await pede("POST", "/wagering/transactions", {
      token: tokenA,
      body: corpoDeAposta(doDono.walletId, doDono.playerId, "provider-a"),
      headers: { "idempotency-key": "provider-a:TX-DISPUTADA" },
    });
    expect(legitima.status).toBe(200);
    expect(legitima.body["status"]).toBe("PROCESSED");
  });

  it("aceita chave fora da convenção desde que seja do próprio espaço", async () => {
    const { walletId, playerId } = await carteira(tokenA);
    const corpo = corpoDeAposta(walletId, playerId, "provider-a");

    // O enunciado define um default, não um formato obrigatório: o que vale é
    // a chave pertencer ao espaço do chamador.
    const resposta = await pede("POST", "/wagering/transactions", {
      token: tokenA,
      body: corpo,
      headers: { "idempotency-key": `provider-a:qualquer-coisa-${uuid()}` },
    });
    expect(resposta.status).toBe(200);
  });

  it("consultar transação de outro provedor responde 404, não 403", async () => {
    const { walletId, playerId } = await carteira(tokenA);
    const corpo = corpoDeAposta(walletId, playerId, "provider-a");
    const externalId = String(corpo["externalTransactionId"]);

    const criada = await pede("POST", "/wagering/transactions", {
      token: tokenA,
      body: corpo,
      headers: { "idempotency-key": `provider-a:${externalId}` },
    });
    const transactionId = criada.body["transactionId"] as string;

    // 403 confirmaria que a transação existe, e um provedor poderia varrer
    // ids para medir o volume do concorrente.
    const porProvider = await pede(
      "GET",
      `/providers/provider-a/wagering/transactions/${externalId}`,
      { token: tokenB },
    );
    expect(porProvider.status).toBe(404);

    const porId = await pede("GET", `/wagering/transactions/${transactionId}`, { token: tokenB });
    expect(porId.status).toBe(404);

    // Para o dono, as duas respondem.
    expect(
      (await pede("GET", `/providers/provider-a/wagering/transactions/${externalId}`, {
        token: tokenA,
      })).status,
    ).toBe(200);
    expect(
      (await pede("GET", `/wagering/transactions/${transactionId}`, { token: tokenA })).status,
    ).toBe(200);
  });
});
