import { describe, expect, it } from "bun:test";

import { FailureCode } from "../../../src/domain/shared/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionSource as Source,
} from "../../../src/domain/wagering/wager-transaction-kind";
import { NestLoggerBridge } from "../../../src/infrastructure/observability/nest-logger";
import { PinoLogger } from "../../../src/infrastructure/observability/pino-logger";
import { PrometheusMetrics } from "../../../src/infrastructure/observability/prometheus-metrics";

/** Coletor de linhas, para ler o que o logger escreveu. */
function coletor(): { linhas: string[]; destino: { write(chunk: string): void } } {
  const linhas: string[] = [];
  return { linhas, destino: { write: (chunk: string) => void linhas.push(chunk) } };
}

/** Sem metricas de processo: elas poluiriam a leitura das series do dominio. */
const semProcesso = (role = "api"): PrometheusMetrics => new PrometheusMetrics(role, false);

describe("PinoLogger — campos de correlacao", () => {
  it("escreve JSON com nivel, mensagem e os campos fixos", async () => {
    const { linhas, destino } = coletor();
    const logger = PinoLogger.create("info", { role: "api", pid: 1 }, destino);

    logger.info("transacao aplicada", {
      correlationId: "corr-1",
      transactionId: "tx-1",
      walletId: "wallet-1",
      providerId: "provider-a",
      messageId: "msg-1",
    });

    const registro = JSON.parse(linhas[0]!) as Record<string, unknown>;
    expect(registro["level"]).toBe("info");
    expect(registro["msg"]).toBe("transacao aplicada");
    expect(registro["role"]).toBe("api");
    // Os cinco campos que o enunciado exige para seguir uma operacao.
    for (const campo of ["correlationId", "transactionId", "walletId", "providerId", "messageId"]) {
      expect(registro[campo]).toBeDefined();
    }
  });

  it("child herda os campos fixos", async () => {
    const { linhas, destino } = coletor();
    const logger = PinoLogger.create("info", { role: "consumer" }, destino);

    logger.child({ messageId: "msg-9" }).warn("recusada");

    const registro = JSON.parse(linhas[0]!) as Record<string, unknown>;
    expect(registro["role"]).toBe("consumer");
    expect(registro["messageId"]).toBe("msg-9");
  });

  it("respeita o nivel minimo", async () => {
    const { linhas, destino } = coletor();
    const logger = PinoLogger.create("warn", {}, destino);

    logger.debug("invisivel");
    logger.info("invisivel");
    logger.warn("visivel");

    expect(linhas).toHaveLength(1);
    expect((JSON.parse(linhas[0]!) as { msg: string }).msg).toBe("visivel");
  });
});

describe("PinoLogger — redacao", () => {
  const sensiveis = [
    ["money", { money: { amount: "25.00", currency: "BRL" } }],
    ["balance", { balance: { amount: "975.00", currency: "BRL" } }],
    ["amount", { amount: "25.00" }],
    ["payload", { payload: { tudo: "aqui" } }],
    ["initialBalance", { initialBalance: { amount: "1000.00", currency: "BRL" } }],
  ] as const;

  for (const [campo, campos] of sensiveis) {
    it(`redige ${campo}`, async () => {
      const { linhas, destino } = coletor();
      PinoLogger.create("info", {}, destino).info("operacao", campos);

      const bruto = linhas[0]!;
      expect(bruto).toContain("[redigido]");
      expect(bruto).not.toContain("25.00");
      expect(bruto).not.toContain("975.00");
      expect(bruto).not.toContain("1000.00");
    });
  }

  it("redige valor monetario aninhado um nivel", async () => {
    const { linhas, destino } = coletor();
    PinoLogger.create("info", {}, destino).info("operacao", {
      detalhe: { amount: "999.99", walletId: "wallet-1" },
    });

    expect(linhas[0]!).not.toContain("999.99");
    // O que nao e financeiro continua legivel.
    expect(linhas[0]!).toContain("wallet-1");
  });

  it("redige todos os campos monetarios tambem aninhados", async () => {
    // A lista aninhada tem que cobrir a mesma coisa que a de primeiro nivel:
    // um campo coberto na raiz e exposto um nivel abaixo e pior que nenhuma
    // redacao, porque a afirmacao de que o log nao tem dinheiro deixa de valer
    // sem ninguem notar.
    const { linhas, destino } = coletor();
    PinoLogger.create("info", {}, destino).info("operacao", {
      wallet: {
        money: { amount: "1.11", currency: "BRL" },
        balance: { amount: "2.22", currency: "BRL" },
        balanceBefore: { amount: "3.33", currency: "BRL" },
        balanceAfter: { amount: "4.44", currency: "BRL" },
        initialBalance: { amount: "5.55", currency: "BRL" },
        observedBalance: { amount: "6.66", currency: "BRL" },
        difference: { amount: "7.77", currency: "BRL" },
        amount: "8.88",
        payload: { tudo: "9.99" },
      },
    });

    const bruto = linhas[0]!;
    for (const valor of ["1.11", "2.22", "3.33", "4.44", "5.55", "6.66", "7.77", "8.88", "9.99"]) {
      expect(bruto).not.toContain(valor);
    }
  });
});

describe("Metrics — transacoes e latencia", () => {
  it("conta por desfecho, tipo, origem e codigo de falha", async () => {
    const metrics = semProcesso();
    metrics.transactionObserved({
      outcome: "PROCESSED",
      kind: Kind.Bet,
      source: Source.Api,
      durationMs: 42,
    });
    metrics.transactionObserved({
      outcome: "REJECTED",
      kind: Kind.Bet,
      source: Source.Queue,
      failureCode: FailureCode.InsufficientFunds,
      durationMs: 7,
    });

    const texto = await metrics.render();
    expect(texto).toContain(
      'wager_transactions_total{outcome="PROCESSED",kind="BET",source="API",failure_code="none",role="api"} 1',
    );
    expect(texto).toContain('failure_code="INSUFFICIENT_FUNDS"');
    expect(texto).toContain("wager_transaction_duration_seconds");
  });

  it("latencia vai para o histograma em segundos", async () => {
    const metrics = semProcesso();
    metrics.transactionObserved({
      outcome: "PROCESSED",
      kind: Kind.Win,
      source: Source.Api,
      durationMs: 250,
    });

    const texto = await metrics.render();
    expect(texto).toMatch(/wager_transaction_duration_seconds_sum\{[^}]*\} 0\.25/);
  });

  it("codigo de falha ausente vira label explicito", async () => {
    // Serie com conjunto de labels variavel e mais dificil de agregar.
    const metrics = semProcesso();
    metrics.transactionObserved({
      outcome: "PROCESSED",
      kind: Kind.Loss,
      source: Source.Api,
      durationMs: 1,
    });
    expect(await metrics.render()).toContain('failure_code="none"');
  });
});

describe("Metrics — as demais series exigidas", () => {
  it("duplicatas, retries, DLQ, conflitos de lock e atraso da outbox", async () => {
    const metrics = semProcesso("outbox");

    metrics.duplicateDetected("idempotency_replay");
    metrics.duplicateDetected("inbox_message");
    metrics.retryScheduled("queue_message");
    metrics.retryScheduled("outbox_event");
    metrics.retryScheduled("reference_resolution");
    metrics.deadLetterSent("invalid_envelope");
    metrics.lockConflictDetected("deadlock");
    metrics.lockConflictDetected("version_mismatch");
    metrics.outboxLagObserved(90_000);
    metrics.reconciliationDivergenceDetected();

    const texto = await metrics.render();
    expect(texto).toContain('wager_duplicates_total{kind="idempotency_replay",role="outbox"} 1');
    expect(texto).toContain('wager_duplicates_total{kind="inbox_message",role="outbox"} 1');
    expect(texto).toContain('wager_retries_total{subject="queue_message",role="outbox"} 1');
    expect(texto).toContain('wager_retries_total{subject="outbox_event",role="outbox"} 1');
    expect(texto).toContain('wager_retries_total{subject="reference_resolution",role="outbox"} 1');
    expect(texto).toContain('wager_dead_letter_total{reason="invalid_envelope",role="outbox"} 1');
    expect(texto).toContain('wager_lock_conflicts_total{reason="deadlock",role="outbox"} 1');
    // Separados de proposito: version_mismatch e bug, deadlock e carga.
    expect(texto).toContain('wager_lock_conflicts_total{reason="version_mismatch",role="outbox"} 1');
    expect(texto).toContain("wager_outbox_lag_seconds{role=\"outbox\"} 90");
    expect(texto).toContain('wager_reconciliation_divergences_total{role="outbox"} 1');
  });

  it("o atraso da outbox so existe depois da primeira observacao", async () => {
    const metrics = semProcesso();

    // Registrar no construtor faria todo papel exportar um zero constante, e
    // um alerta em `avg`/`min` sobre publisher parado leria ~0 por causa deles.
    expect(await metrics.render()).not.toContain("wager_outbox_lag_seconds");

    metrics.outboxLagObserved(3_000);
    expect(await metrics.render()).toContain('wager_outbox_lag_seconds{role="api"} 3');
  });

  it("DLQ por limite de entregas tem motivo proprio", async () => {
    const metrics = semProcesso("consumer");
    metrics.deadLetterSent("delivery_limit");

    // Sem esse motivo, a unica mensagem que o sistema **sabe** que vai para a
    // DLQ — a que esgotou as entregas — seria a unica fora da metrica.
    expect(await metrics.render()).toContain(
      'wager_dead_letter_total{reason="delivery_limit",role="consumer"} 1',
    );
  });

  it("o atraso da outbox e um gauge: substitui, nao acumula", async () => {
    const metrics = semProcesso();
    metrics.outboxLagObserved(60_000);
    metrics.outboxLagObserved(5_000);
    expect(await metrics.render()).toContain('wager_outbox_lag_seconds{role="api"} 5');
  });

  it("o label de role separa as instancias na agregacao", async () => {
    const texto = await semProcesso("consumer").render();
    expect(texto).toContain('role="consumer"');
  });
});

describe("NestLoggerBridge", () => {
  it("passa o log do proprio Nest pelo pino, em JSON", async () => {
    const { linhas, destino } = coletor();
    const ponte = new NestLoggerBridge(PinoLogger.create("debug", { role: "api" }, destino));

    ponte.log("Mapped {/wallets, POST} route", "RouterExplorer");
    ponte.warn("algo", "NestApplication");
    ponte.error("falhou", "ExceptionsHandler");
    ponte.debug("detalhe", "InstanceLoader");
    ponte.verbose("detalhe", "InstanceLoader");

    const registros = linhas.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(registros.map((r) => r["level"])).toEqual([
      "info",
      "warn",
      "error",
      "debug",
      // `verbose` do Nest nao tem nivel proprio no pino: cai em debug.
      "debug",
    ]);
    expect(registros[0]!["msg"]).toBe("Mapped {/wallets, POST} route");
    // O contexto do Nest vira campo nomeado, para poder filtrar por ele.
    expect(registros[0]!["nest"]).toBe("RouterExplorer");
    expect(registros[0]!["role"]).toBe("api");
  });

  it("aceita mensagem que nao e string", async () => {
    const { linhas, destino } = coletor();
    new NestLoggerBridge(PinoLogger.create("info", {}, destino)).log({ a: 1 });

    expect((JSON.parse(linhas[0]!) as { msg: string }).msg).toBe('{"a":1}');
  });
});
