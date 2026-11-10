import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { loadEnv } from "../../src/config/env";
import { openOrmWithFreshSchema } from "../support/database";

/**
 * Cada teste aqui **tenta violar** uma garantia e exige que o PostgreSQL
 * recuse. Constraint de aplicacao e ergonomia; constraint de banco e garantia,
 * e garantia nao verificada nao e garantia.
 *
 * Nao ha limpeza entre testes de proposito: o ledger e append-only, entao
 * DELETE e TRUNCATE sao justamente o que o schema recusa. Cada caso usa ids
 * novos. Para recomecar do zero: `bun run db fresh`.
 */
let orm: MikroORM;

const uuid = (): string => crypto.randomUUID();

async function run(query: string, params: unknown[] = []): Promise<unknown> {
  return orm.em.getConnection().execute(query, params);
}

function insertOf(table: string, row: Record<string, unknown>): [string, unknown[]] {
  const cols = Object.keys(row);
  const slots = cols.map(() => "?"); // MikroORM passa por knex: placeholder e ?
  return [`insert into ${table} (${cols.join(", ")}) values (${slots.join(", ")})`, Object.values(row)];
}

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const [query, params] = insertOf(table, row);
  await run(query, params);
}

/** Exige que a escrita falhe e que a mensagem nomeie a garantia esperada. */
async function recusa(expected: string, action: () => Promise<unknown>): Promise<void> {
  let erro: unknown;
  try {
    await action();
  } catch (capturado: unknown) {
    erro = capturado;
  }
  if (erro === undefined) {
    throw new Error(`o banco aceitou uma escrita que deveria violar ${expected}`);
  }
  expect(String(erro)).toContain(expected);
}

const recusaInsert = (expected: string, table: string, row: Record<string, unknown>) =>
  recusa(expected, () => insert(table, row));

// ---------------------------------------------------------------- fixtures

function walletRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(),
    player_id: uuid(),
    currency: "BRL",
    balance_amount: "100.00",
    version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

let walletId: string;
let playerId: string;

function txRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(),
    provider_id: "provider-a",
    external_transaction_id: `external-${uuid()}`,
    idempotency_key: `provider-a:${uuid()}`,
    payload_hash: "hash-abc",
    wallet_id: walletId,
    player_id: playerId,
    round_id: "round-1",
    game_id: "fortune-chimp",
    kind: "BET",
    source: "API",
    money_amount: "25.00",
    money_currency: "BRL",
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: "PENDING",
    failure_code: null,
    observed_balance_amount: null,
    reference_attempts: 0,
    pending_reference_since: null,
    created_at: new Date(),
    processed_at: null,
    ...over,
  };
}

function entryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(),
    wallet_id: walletId,
    transaction_id: uuid(),
    direction: "DEBIT",
    money_amount: "25.00",
    money_currency: "BRL",
    balance_before_amount: "100.00",
    balance_after_amount: "75.00",
    created_at: new Date(),
    ...over,
  };
}

/** Cria uma transacao valida para servir de alvo de lancamento ou referencia. */
async function transacaoProcessada(over: Record<string, unknown> = {}): Promise<string> {
  const row = txRow({
    status: "PROCESSED",
    processed_at: new Date(),
    observed_balance_amount: "100.00",
    ...over,
  });
  await insert("wager_transactions", row);
  return row["id"] as string;
}

beforeAll(async () => {
  orm = await openOrmWithFreshSchema();
  const wallet = walletRow();
  await insert("wallets", wallet);
  walletId = wallet["id"] as string;
  playerId = wallet["player_id"] as string;
});

afterAll(async () => {
  if (orm) await orm.close(true);
});

describe("migration", () => {
  it("esta aplicada e registrada", async () => {
    const rows = (await run(
      "select name from mikro_orm_migrations order by id desc limit 1",
    )) as Array<{ name: string }>;
    expect(rows[0]?.name).toContain("Migration2026");
  });
});

describe("wallets", () => {
  it("recusa segunda wallet para o mesmo player e moeda", async () => {
    const primeira = walletRow();
    await insert("wallets", primeira);
    await recusaInsert("wallets_player_currency_unique", "wallets", {
      ...walletRow(),
      player_id: primeira["player_id"],
      currency: "BRL",
    });
  });

  it("aceita a mesma pessoa em outra moeda", async () => {
    const brl = walletRow();
    await insert("wallets", brl);
    await insert("wallets", { ...walletRow(), player_id: brl["player_id"], currency: "USD" });
  });

  it("recusa saldo negativo", async () => {
    await recusaInsert("wallets_balance_non_negative", "wallets", walletRow({
      balance_amount: "-0.01",
    }));
  });

  it("RECUSA escala de 3 casas em vez de arredondar", async () => {
    // numeric(20,2) teria gravado 11.00 em silencio. Arredondar dinheiro sem
    // avisar e inventar valor, por isso a coluna e numeric puro com CHECK.
    await recusaInsert("wallets_balance_scale", "wallets", walletRow({
      balance_amount: "10.999",
    }));
  });

  it("recusa valor acima da capacidade de 18 digitos inteiros", async () => {
    await recusaInsert("wallets_balance_capacity", "wallets", walletRow({
      balance_amount: "1000000000000000000.00",
    }));
  });

  it("recusa moeda fora do formato ISO-4217", async () => {
    await recusaInsert("wallets_currency_shape", "wallets", walletRow({ currency: "brl" }));
  });

  it("recusa version abaixo de 1", async () => {
    await recusaInsert("wallets_version_positive", "wallets", walletRow({ version: 0 }));
  });
});

describe("wager_transactions — idempotencia", () => {
  it("recusa idempotency key repetida", async () => {
    const primeira = txRow();
    await insert("wager_transactions", primeira);
    await recusaInsert(
      "wager_transactions_idempotency_key_unique",
      "wager_transactions",
      txRow({ idempotency_key: primeira["idempotency_key"] }),
    );
  });

  it("recusa o mesmo par (provider, external id)", async () => {
    const primeira = txRow();
    await insert("wager_transactions", primeira);
    await recusaInsert(
      "wager_transactions_provider_external_unique",
      "wager_transactions",
      txRow({
        provider_id: primeira["provider_id"],
        external_transaction_id: primeira["external_transaction_id"],
      }),
    );
  });
});

describe("wager_transactions — regras de kind", () => {
  it("recusa OPENING submetido pela API", async () => {
    await recusaInsert("wager_transactions_opening_is_internal", "wager_transactions", txRow({
      kind: "OPENING",
      source: "API",
    }));
  });

  it("recusa OPENING submetido pela fila", async () => {
    await recusaInsert("wager_transactions_opening_is_internal", "wager_transactions", txRow({
      kind: "OPENING",
      source: "QUEUE",
    }));
  });

  it("aceita OPENING interno", async () => {
    await insert("wager_transactions", txRow({ kind: "OPENING", source: "INTERNAL" }));
  });

  for (const kind of ["REFUND", "ROLLBACK"]) {
    it(`recusa ${kind} sem referencia`, async () => {
      await recusaInsert("wager_transactions_reference_required", "wager_transactions", txRow({
        kind,
        reference_external_transaction_id: null,
      }));
    });
  }

  for (const kind of ["BET", "LOSS", "OPENING"]) {
    it(`recusa ${kind} carregando referencia`, async () => {
      await recusaInsert("wager_transactions_reference_forbidden", "wager_transactions", txRow({
        kind,
        source: kind === "OPENING" ? "INTERNAL" : "API",
        reference_external_transaction_id: "external-qualquer",
      }));
    });
  }

  it("recusa transacao que referencia a si mesma", async () => {
    const id = uuid();
    await recusaInsert("wager_transactions_no_self_reference", "wager_transactions", txRow({
      id,
      kind: "REFUND",
      reference_external_transaction_id: "external-qualquer",
      reference_transaction_id: id,
    }));
  });
});

describe("wager_transactions — valor e identificadores", () => {
  it("recusa valor zero", async () => {
    await recusaInsert("wager_transactions_money_positive", "wager_transactions", txRow({
      money_amount: "0.00",
    }));
  });

  it("recusa valor negativo", async () => {
    await recusaInsert("wager_transactions_money_positive", "wager_transactions", txRow({
      money_amount: "-25.00",
    }));
  });

  it("recusa escala de 3 casas", async () => {
    await recusaInsert("wager_transactions_money_scale", "wager_transactions", txRow({
      money_amount: "25.123",
    }));
  });

  it("recusa identificador com espaco em volta", async () => {
    // "tx-9" e "tx-9 " seriam duas linhas sob UNIQUE (idempotency_key):
    // debito duplicado sem concorrencia nenhuma envolvida.
    await recusaInsert("wager_transactions_identifiers_trimmed", "wager_transactions", txRow({
      idempotency_key: "provider-a:tx-9 ",
    }));
  });

  it("recusa identificador vazio", async () => {
    await recusaInsert("wager_transactions_identifiers_trimmed", "wager_transactions", txRow({
      provider_id: "",
    }));
  });
});

describe("wager_transactions — coerencia de estado", () => {
  it("recusa PROCESSED sem processed_at", async () => {
    await recusaInsert(
      "wager_transactions_processed_at_matches_status",
      "wager_transactions",
      txRow({ status: "PROCESSED", processed_at: null }),
    );
  });

  it("recusa PENDING com processed_at", async () => {
    await recusaInsert(
      "wager_transactions_processed_at_matches_status",
      "wager_transactions",
      txRow({ status: "PENDING", processed_at: new Date() }),
    );
  });

  it("recusa REJECTED sem failure_code", async () => {
    await recusaInsert(
      "wager_transactions_failure_code_matches_status",
      "wager_transactions",
      txRow({ status: "REJECTED", processed_at: new Date(), failure_code: null }),
    );
  });

  it("recusa PENDING com failure_code", async () => {
    await recusaInsert(
      "wager_transactions_failure_code_matches_status",
      "wager_transactions",
      txRow({ status: "PENDING", failure_code: "INSUFFICIENT_FUNDS" }),
    );
  });

  it("recusa PENDING_REFERENCE sem a ancora do TTL", async () => {
    await recusaInsert(
      "wager_transactions_pending_since_present",
      "wager_transactions",
      txRow({
        kind: "REFUND",
        reference_external_transaction_id: "external-qualquer",
        status: "PENDING_REFERENCE",
        pending_reference_since: null,
      }),
    );
  });

  it("aceita PENDING_REFERENCE com a ancora", async () => {
    await insert("wager_transactions", txRow({
      kind: "REFUND",
      reference_external_transaction_id: "external-qualquer",
      status: "PENDING_REFERENCE",
      pending_reference_since: new Date(),
    }));
  });
});

describe("wager_transactions — reversao unica por tipo", () => {
  it("recusa dois REFUND processados da mesma referencia", async () => {
    const bet = await transacaoProcessada();
    const comum = {
      kind: "REFUND",
      reference_external_transaction_id: "external-da-bet",
      reference_transaction_id: bet,
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance_amount: "100.00",
    };
    await insert("wager_transactions", txRow(comum));
    await recusaInsert(
      "wager_transactions_single_reversal",
      "wager_transactions",
      txRow(comum),
    );
  });

  it("recusa REFUND e ROLLBACK da mesma referencia, mesmo sendo tipos diferentes", async () => {
    // A letra do enunciado proibe reverter duas vezes "pelo mesmo tipo", o que
    // permitiria REFUND + ROLLBACK da mesma BET. Mas aí uma aposta de 25,00
    // renderia +50,00 de credito, violando a invariante global de nao
    // duplicar credito — que esta acima da regra especifica.
    const bet = await transacaoProcessada();
    const comum = {
      reference_external_transaction_id: "external-da-bet",
      reference_transaction_id: bet,
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance_amount: "100.00",
    };
    await insert("wager_transactions", txRow({ ...comum, kind: "REFUND" }));
    await recusaInsert(
      "wager_transactions_single_reversal",
      "wager_transactions",
      txRow({ ...comum, kind: "ROLLBACK" }),
    );
  });

  it("a cadeia legitima continua possivel: ROLLBACK do REFUND, nao da BET", async () => {
    const bet = await transacaoProcessada();
    const refund = txRow({
      kind: "REFUND",
      reference_external_transaction_id: "external-da-bet",
      reference_transaction_id: bet,
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance_amount: "100.00",
    });
    await insert("wager_transactions", refund);

    // Aponta para o REFUND, entao e outra chave no indice parcial.
    await insert("wager_transactions", txRow({
      kind: "ROLLBACK",
      reference_external_transaction_id: refund["external_transaction_id"],
      reference_transaction_id: refund["id"],
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance_amount: "100.00",
    }));
  });

  it("recusa reversao PROCESSED sem a referencia interna resolvida", async () => {
    // Em PostgreSQL dois NULL sao distintos num indice unico: sem esta
    // constraint, duas reversoes com reference_transaction_id nulo passariam
    // as duas pelo indice de reversao unica. Credito duplicado, sem erro.
    await recusaInsert(
      "wager_transactions_processed_reversal_is_resolved",
      "wager_transactions",
      txRow({
        kind: "REFUND",
        reference_external_transaction_id: "external-da-bet",
        reference_transaction_id: null,
        status: "PROCESSED",
        processed_at: new Date(),
        observed_balance_amount: "100.00",
      }),
    );
  });

  it("uma tentativa REJECTED nao consome a reversao", async () => {
    // O indice e parcial em status = 'PROCESSED': rejeicao nao bloqueia uma
    // tentativa legitima posterior.
    const bet = await transacaoProcessada();
    const comum = {
      kind: "REFUND",
      reference_external_transaction_id: "external-da-bet",
      reference_transaction_id: bet,
    };
    await insert("wager_transactions", txRow({
      ...comum,
      status: "REJECTED",
      processed_at: new Date(),
      failure_code: "REVERSAL_WOULD_OVERDRAW",
    }));
    await insert("wager_transactions", txRow({
      ...comum,
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance_amount: "100.00",
    }));
  });
});

describe("wallet_ledger_entries — aritmetica", () => {
  it("recusa aritmetica que nao fecha", async () => {
    const tx = await transacaoProcessada();
    await recusaInsert("wallet_ledger_entries_arithmetic", "wallet_ledger_entries", entryRow({
      transaction_id: tx,
      balance_after_amount: "80.00",
    }));
  });

  it("recusa direction invertida em relacao a aritmetica", async () => {
    const tx = await transacaoProcessada();
    await recusaInsert("wallet_ledger_entries_arithmetic", "wallet_ledger_entries", entryRow({
      transaction_id: tx,
      direction: "CREDIT",
      balance_after_amount: "75.00",
    }));
  });

  it("aceita credito com aritmetica coerente", async () => {
    const tx = await transacaoProcessada();
    await insert("wallet_ledger_entries", entryRow({
      transaction_id: tx,
      direction: "CREDIT",
      balance_before_amount: "100.00",
      balance_after_amount: "125.00",
    }));
  });

  it("recusa valor zero — o sinal e a direction", async () => {
    const tx = await transacaoProcessada();
    await recusaInsert("wallet_ledger_entries_amount_positive", "wallet_ledger_entries", entryRow({
      transaction_id: tx,
      money_amount: "0.00",
      balance_after_amount: "100.00",
    }));
  });

  it("recusa saldo final negativo", async () => {
    const tx = await transacaoProcessada();
    await recusaInsert(
      "wallet_ledger_entries_balances_non_negative",
      "wallet_ledger_entries",
      entryRow({
        transaction_id: tx,
        money_amount: "150.00",
        balance_before_amount: "100.00",
        balance_after_amount: "-50.00",
      }),
    );
  });

  it("recusa escala de 3 casas", async () => {
    const tx = await transacaoProcessada();
    await recusaInsert("wallet_ledger_entries_scale", "wallet_ledger_entries", entryRow({
      transaction_id: tx,
      money_amount: "25.123",
      balance_after_amount: "74.877",
    }));
  });

  it("recusa dois lancamentos da mesma transacao na mesma wallet", async () => {
    const tx = await transacaoProcessada();
    await insert("wallet_ledger_entries", entryRow({ transaction_id: tx }));
    await recusaInsert(
      "wallet_ledger_entries_one_per_wallet_tx",
      "wallet_ledger_entries",
      entryRow({ transaction_id: tx }),
    );
  });
});

describe("wallet_ledger_entries — append-only", () => {
  it("recusa UPDATE", async () => {
    const tx = await transacaoProcessada();
    const entry = entryRow({ transaction_id: tx });
    await insert("wallet_ledger_entries", entry);

    await recusa("append-only", () =>
      run("update wallet_ledger_entries set money_amount = '1.00' where id = ?", [entry["id"]]),
    );
  });

  it("recusa DELETE", async () => {
    const tx = await transacaoProcessada();
    const entry = entryRow({ transaction_id: tx });
    await insert("wallet_ledger_entries", entry);

    await recusa("append-only", () =>
      run("delete from wallet_ledger_entries where id = ?", [entry["id"]]),
    );
  });

  it("recusa TRUNCATE — o trigger de linha nao cobriria isso", async () => {
    await recusa("append-only", () => run("truncate wallet_ledger_entries"));
  });

  it("o trigger vale para o owner da tabela, nao so para roles restritos", async () => {
    const quem = (await run("select current_user as usuario")) as Array<{ usuario: string }>;
    expect(quem[0]?.usuario).toBe(loadEnv().POSTGRES_USER);
    const tx = await transacaoProcessada();
    const entry = entryRow({ transaction_id: tx });
    await insert("wallet_ledger_entries", entry);
    await recusa("append-only", () =>
      run("delete from wallet_ledger_entries where id = ?", [entry["id"]]),
    );
  });
});

describe("wager_transactions — moeda amarrada a carteira", () => {
  it("recusa transacao em moeda diferente da moeda da carteira", async () => {
    await recusaInsert("wager_transactions_wallet_fkey", "wager_transactions", txRow({
      money_currency: "USD",
    }));
  });
});

describe("wager_transactions — saldo observado", () => {
  it("recusa NaN", async () => {
    // scale('NaN') e NULL, entao a checagem de escala sozinha o aceitava. Em
    // numeric, NaN e maior que qualquer numero, e o limite de capacidade pega.
    await recusaInsert(
      "wager_transactions_observed_balance_sane",
      "wager_transactions",
      txRow({ observed_balance_amount: "NaN" }),
    );
  });

  it("recusa saldo observado negativo", async () => {
    await recusaInsert(
      "wager_transactions_observed_balance_sane",
      "wager_transactions",
      txRow({ observed_balance_amount: "-1.00" }),
    );
  });

  it("exige saldo observado em PROCESSED — e o que o replay devolve", async () => {
    await recusaInsert(
      "wager_transactions_processed_has_observed_balance",
      "wager_transactions",
      txRow({ status: "PROCESSED", processed_at: new Date(), observed_balance_amount: null }),
    );
  });

  it("nao exige em REJECTED: a recusa pode acontecer antes de ler a carteira", async () => {
    await insert("wager_transactions", txRow({
      status: "REJECTED",
      processed_at: new Date(),
      failure_code: "WALLET_NOT_FOUND",
      observed_balance_amount: null,
    }));
  });
});

describe("wager_transactions — imutabilidade", () => {
  it("recusa alterar coluna de identidade", async () => {
    const id = await transacaoProcessada();
    await recusa("imutaveis", () =>
      run("update wager_transactions set money_amount = '999.00' where id = ?", [id]),
    );
    await recusa("imutaveis", () =>
      run("update wager_transactions set idempotency_key = 'outra' where id = ?", [id]),
    );
  });

  it("recusa sair de estado terminal", async () => {
    const id = await transacaoProcessada();
    await recusa("nao muda mais", () =>
      run("update wager_transactions set status = 'PENDING' where id = ?", [id]),
    );
  });

  it("aceita avancar de PENDING para terminal", async () => {
    const row = txRow();
    await insert("wager_transactions", row);
    await run(
      `update wager_transactions
          set status = 'PROCESSED', processed_at = now(), observed_balance_amount = '75.00'
        where id = ?`,
      [row["id"]],
    );
    const depois = (await run("select status from wager_transactions where id = ?", [
      row["id"],
    ])) as Array<{ status: string }>;
    expect(depois[0]?.status).toBe("PROCESSED");
  });

  it("recusa DELETE e TRUNCATE", async () => {
    const id = await transacaoProcessada();
    await recusa("append-only", () =>
      run("delete from wager_transactions where id = ?", [id]),
    );
    await recusa("append-only", () => run("truncate wager_transactions cascade"));
  });
});

describe("wallet_ledger_entries — amarracao com a transacao", () => {
  it("recusa lancamento em carteira diferente da carteira da transacao", async () => {
    const outra = walletRow();
    await insert("wallets", outra);
    const tx = await transacaoProcessada();

    await recusaInsert(
      "wallet_ledger_entries_transaction_fkey",
      "wallet_ledger_entries",
      entryRow({ transaction_id: tx, wallet_id: outra["id"] }),
    );
  });

  it("recusa lancamento em moeda diferente da moeda da carteira", async () => {
    // O FK composto (wallet_id, money_currency) -> wallets (id, currency) pega
    // antes do FK da transacao: nao existe lancamento em moeda que a carteira
    // nao tem.
    const tx = await transacaoProcessada();
    await recusaInsert(
      "wallet_ledger_entries_wallet_fkey",
      "wallet_ledger_entries",
      entryRow({ transaction_id: tx, money_currency: "USD" }),
    );
  });

  it("recusa lancamento de LOSS", async () => {
    const tx = await transacaoProcessada({ kind: "LOSS" });
    await recusa("LOSS nao gera lancamento", () =>
      insert("wallet_ledger_entries", entryRow({ transaction_id: tx })),
    );
  });

  it("recusa lancamento de transacao nao processada", async () => {
    const row = txRow();
    await insert("wager_transactions", row);
    await recusa("exige transacao PROCESSED", () =>
      insert("wallet_ledger_entries", entryRow({ transaction_id: row["id"] })),
    );
  });

  it("recusa lancamento com valor diferente do valor da transacao", async () => {
    const tx = await transacaoProcessada({ money_amount: "25.00" });
    await recusa("difere do valor da transacao", () =>
      insert("wallet_ledger_entries", entryRow({
        transaction_id: tx,
        money_amount: "10.00",
        balance_after_amount: "90.00",
      })),
    );
  });

  it("recusa lancamento de transacao inexistente", async () => {
    await recusa("wallet_ledger_entries_transaction_fkey", () =>
      insert("wallet_ledger_entries", entryRow({ transaction_id: uuid() })),
    );
  });
});

describe("inbox_messages", () => {
  it("a deduplicacao e a propria chave primaria", async () => {
    const row = {
      consumer_name: "wager-transactions",
      message_id: `msg-${uuid()}`,
      payload_hash: "hash-abc",
      received_at: new Date(),
      processed_at: null,
    };
    await insert("inbox_messages", row);
    await recusaInsert("inbox_messages_pkey", "inbox_messages", row);
  });

  it("o mesmo messageId em outro consumer e permitido", async () => {
    const messageId = `msg-${uuid()}`;
    for (const consumer of ["wager-transactions", "auditoria"]) {
      await insert("inbox_messages", {
        consumer_name: consumer,
        message_id: messageId,
        payload_hash: "hash-abc",
        received_at: new Date(),
        processed_at: null,
      });
    }
  });
});

describe("outbox_messages", () => {
  const outboxRow = (over: Record<string, unknown> = {}) => ({
    id: uuid(),
    aggregate_id: walletId,
    event_type: "WalletBalanceChanged",
    partition_key: walletId,
    payload: JSON.stringify({ eventType: "WalletBalanceChanged" }),
    occurred_at: new Date(),
    attempts: 0,
    next_attempt_at: null,
    published_at: null,
    ...over,
  });

  it("aceita linha pendente", async () => {
    await insert("outbox_messages", outboxRow());
  });

  it("recusa attempts negativo", async () => {
    await recusaInsert("outbox_messages_attempts_non_negative", "outbox_messages", outboxRow({
      attempts: -1,
    }));
  });

  it("recusa partition key vazia — sem ela nao ha MessageGroupId", async () => {
    await recusaInsert("outbox_messages_identifiers_trimmed", "outbox_messages", outboxRow({
      partition_key: "",
    }));
  });

  it("o indice de pendentes existe e e parcial", async () => {
    // Nao se afere isso por plano de execucao: com tabela pequena ou sem
    // estatisticas o planner escolhe Seq Scan e o teste viraria flaky — o que
    // ele mediria seria a ausencia de ANALYZE, nao o schema.
    const linhas = (await run(
      "select indexdef from pg_indexes where indexname = 'outbox_messages_claimable'",
    )) as Array<{ indexdef: string }>;
    expect(linhas).toHaveLength(1);
    // Parcial nas duas condicoes: publicada e abandonada saem da fila.
    expect(linhas[0]?.indexdef).toContain("published_at IS NULL");
    expect(linhas[0]?.indexdef).toContain("abandoned_at IS NULL");
    expect(linhas[0]?.indexdef).toContain("next_attempt_at");
  });
});

describe("invariante final", () => {
  it("o saldo da wallet reconstroi somando o ledger", async () => {
    const wallet = walletRow({ balance_amount: "0.00" });
    await insert("wallets", wallet);
    const id = wallet["id"] as string;

    const abertura = txRow({
      wallet_id: id,
      player_id: wallet["player_id"],
      kind: "OPENING",
      source: "INTERNAL",
      money_amount: "1000.00",
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance_amount: "1000.00",
    });
    await insert("wager_transactions", abertura);
    await insert("wallet_ledger_entries", {
      id: uuid(),
      wallet_id: id,
      transaction_id: abertura["id"],
      direction: "CREDIT",
      money_amount: "1000.00",
      money_currency: "BRL",
      balance_before_amount: "0.00",
      balance_after_amount: "1000.00",
      created_at: new Date(),
    });

    const aposta = txRow({
      wallet_id: id,
      player_id: wallet["player_id"],
      money_amount: "250.50",
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance_amount: "749.50",
    });
    await insert("wager_transactions", aposta);
    await insert("wallet_ledger_entries", {
      id: uuid(),
      wallet_id: id,
      transaction_id: aposta["id"],
      direction: "DEBIT",
      money_amount: "250.50",
      money_currency: "BRL",
      balance_before_amount: "1000.00",
      balance_after_amount: "749.50",
      created_at: new Date(),
    });

    await run("update wallets set balance_amount = '749.50', version = 3 where id = ?", [id]);

    const linhas = (await run(
      `select w.balance_amount::text as materializado,
              coalesce(sum(case e.direction
                when 'CREDIT' then e.money_amount else -e.money_amount end), 0)::text
                as reconstruido
         from wallets w
         left join wallet_ledger_entries e on e.wallet_id = w.id
        where w.id = ?
        group by w.balance_amount`,
      [id],
    )) as Array<{ materializado: string; reconstruido: string }>;

    expect(linhas[0]?.materializado).toBe("749.50");
    expect(linhas[0]?.reconstruido).toBe("749.50");
  });
});
