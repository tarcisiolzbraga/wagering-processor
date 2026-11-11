import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { openOrmWithFreshSchema } from "../support/database";
import { startTestApp, type TestApp } from "../support/http-app";

let app: TestApp;
let orm: MikroORM;

const uuid = (): string => crypto.randomUUID();

async function raspa(): Promise<{ status: number; contentType: string; texto: string }> {
  const resposta = await fetch(`${app.baseUrl}/metrics`);
  return {
    status: resposta.status,
    contentType: resposta.headers.get("content-type") ?? "",
    texto: await resposta.text(),
  };
}

/** Le o valor de uma serie contando as labels pedidas, somando as demais. */
function valorDe(texto: string, serie: string, labels: Record<string, string>): number {
  const esperadas = Object.entries(labels);
  let soma = 0;

  for (const linha of texto.split("\n")) {
    if (!linha.startsWith(`${serie}{`)) continue;
    if (!esperadas.every(([chave, valor]) => linha.includes(`${chave}="${valor}"`))) continue;
    soma += Number(linha.slice(linha.lastIndexOf(" ") + 1));
  }

  return soma;
}

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await orm.close(true);
});

describe("GET /metrics", () => {
  it("responde no formato de texto do Prometheus, sem cache", async () => {
    const { status, contentType, texto } = await raspa();

    expect(status).toBe(200);
    expect(contentType).toContain("text/plain");
    expect(contentType).toContain("version=0.0.4");
    expect(texto).toContain("# HELP wager_transactions_total");
    expect(texto).toContain("# TYPE wager_transactions_total counter");
  });

  it("expoe as sete series exigidas e as metricas de processo", async () => {
    const { texto } = await raspa();

    for (const serie of [
      "wager_transactions_total",
      "wager_duplicates_total",
      "wager_retries_total",
      "wager_dead_letter_total",
      "wager_lock_conflicts_total",
      "wager_reconciliation_divergences_total",
      "wager_transaction_duration_seconds",
      "process_resident_memory_bytes",
    ]) {
      expect(texto).toContain(serie);
    }
  });

  it("nao exporta o atraso da outbox no papel que nao publica", async () => {
    // Gauge registrado nasce em zero. Se a API exportasse a serie, um alerta
    // em `avg` ou `min` sobre o sinal de publisher parado leria ~0 por causa
    // dos processos que nunca publicam. Serie que nao se aplica nao existe.
    expect((await raspa()).texto).not.toContain("wager_outbox_lag_seconds");
  });

  it("nao vaza valor monetario em label nem em valor de serie", async () => {
    const playerId = uuid();
    const abertura = await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "1337.71", currency: "BRL" },
      }),
    });
    const walletId = ((await abertura.json()) as { id: string }).id;

    await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `k-${uuid()}` },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: `external-${uuid()}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "411.19", currency: "BRL" },
      }),
    });

    const { texto } = await raspa();
    // Agregado nao e extrato: nenhum valor da operacao aparece na raspagem.
    expect(texto).not.toContain("1337.71");
    expect(texto).not.toContain("411.19");
    expect(texto).not.toContain(walletId);
    expect(texto).not.toContain(playerId);
  });

  it("transacao aceita incrementa o contador do desfecho", async () => {
    const playerId = uuid();
    const abertura = await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }),
    });
    const walletId = ((await abertura.json()) as { id: string }).id;

    const antes = valorDe((await raspa()).texto, "wager_transactions_total", {
      outcome: "PROCESSED",
      kind: "BET",
      source: "API",
    });

    const corpo = {
      providerId: "provider-a",
      externalTransactionId: `external-${uuid()}`,
      playerId,
      walletId,
      roundId: "round-2",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "30.00", currency: "BRL" },
    };
    const chave = `k-${uuid()}`;
    const pede = (): Promise<Response> =>
      fetch(`${app.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": chave },
        body: JSON.stringify(corpo),
      });

    const primeira = await pede();
    expect(primeira.status).toBe(200);
    expect(((await primeira.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(false);

    const texto = (await raspa()).texto;
    expect(
      valorDe(texto, "wager_transactions_total", {
        outcome: "PROCESSED",
        kind: "BET",
        source: "API",
      }),
    ).toBe(antes + 1);
    // Latencia observada no mesmo caminho: o histograma precisa ter amostra.
    expect(valorDe(texto, "wager_transaction_duration_seconds_count", { source: "API" })).toBeGreaterThan(0);

    // O replay conta como duplicata, nunca como uma segunda transacao: a
    // serie precisa fechar com o ledger.
    const replay = await pede();
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    const depois = (await raspa()).texto;
    expect(
      valorDe(depois, "wager_transactions_total", {
        outcome: "PROCESSED",
        kind: "BET",
        source: "API",
      }),
    ).toBe(antes + 1);
    expect(valorDe(depois, "wager_duplicates_total", { kind: "idempotency_replay" })).toBeGreaterThan(0);
  });

  it("abertura de carteira com saldo conta como transacao interna", async () => {
    const antes = valorDe((await raspa()).texto, "wager_transactions_total", {
      kind: "OPENING",
      source: "INTERNAL",
    });

    await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: uuid(),
        initialBalance: { amount: "40.00", currency: "BRL" },
      }),
    });

    // O OPENING tem lancamento no ledger. Fora da serie, o contador nao
    // fecharia com o livro — a propriedade que faz a metrica valer algo.
    expect(
      valorDe((await raspa()).texto, "wager_transactions_total", {
        kind: "OPENING",
        source: "INTERNAL",
        outcome: "PROCESSED",
      }),
    ).toBe(antes + 1);
  });

  it("carteira sem saldo inicial nao conta transacao", async () => {
    const antes = valorDe((await raspa()).texto, "wager_transactions_total", { kind: "OPENING" });

    await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: uuid(),
        initialBalance: { amount: "0.00", currency: "BRL" },
      }),
    });

    // Sem saldo inicial nao ha lancamento, entao nao ha transacao a contar.
    expect(
      valorDe((await raspa()).texto, "wager_transactions_total", { kind: "OPENING" }),
    ).toBe(antes);
  });

  it("payload invalido nao conta como erro do sistema", async () => {
    const antesErro = valorDe((await raspa()).texto, "wager_transactions_total", {
      outcome: "ERROR",
    });

    const resposta = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `k-${uuid()}` },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: `external-${uuid()}`,
        playerId: uuid(),
        walletId: uuid(),
        roundId: "round-9",
        gameId: "fortune-chimp",
        kind: "BET",
        // Tres casas decimais: arredondar dinheiro em silencio e inventar valor.
        money: { amount: "25.123", currency: "BRL" },
      }),
    });
    expect(resposta.status).toBe(400);

    const texto = (await raspa()).texto;
    // Erro do cliente contado como ERROR deixaria um provedor com payload
    // errado indistinguivel de um Postgres fora do ar.
    expect(valorDe(texto, "wager_transactions_total", { outcome: "ERROR" })).toBe(antesErro);
    expect(valorDe(texto, "wager_transactions_total", { outcome: "INVALID" })).toBeGreaterThan(0);
    // E o valor submetido nao vaza pela mensagem de erro.
    expect(texto).not.toContain("25.123");
  });

  it("rejeicao de negocio conta com o failureCode como label", async () => {
    const playerId = uuid();
    const abertura = await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: "10.00", currency: "BRL" } }),
    });
    const walletId = ((await abertura.json()) as { id: string }).id;

    const resposta = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `k-${uuid()}` },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: `external-${uuid()}`,
        playerId,
        walletId,
        roundId: "round-3",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(resposta.status).toBe(422);

    expect(
      valorDe((await raspa()).texto, "wager_transactions_total", {
        outcome: "REJECTED",
        failure_code: "INSUFFICIENT_FUNDS",
      }),
    ).toBeGreaterThan(0);
  });
});

describe("superficie HTTP do worker", () => {
  let worker: TestApp;

  beforeAll(async () => {
    worker = await startTestApp("observability-only");
  });

  afterAll(async () => {
    await worker.close();
  });

  it("serve metrica e liveness", async () => {
    expect((await fetch(`${worker.baseUrl}/metrics`)).status).toBe(200);
    expect((await fetch(`${worker.baseUrl}/health/live`)).status).toBe(200);
  });

  it("nao serve endpoint de negocio", async () => {
    // Um POST /wagering/transactions atendido pelo publisher aceitaria
    // trafego num processo que nao esta no load balancer.
    const resposta = await fetch(`${worker.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k-1" },
      body: JSON.stringify({}),
    });
    expect(resposta.status).toBe(404);
    expect((await fetch(`${worker.baseUrl}/wallets/${uuid()}`)).status).toBe(404);
  });
});
