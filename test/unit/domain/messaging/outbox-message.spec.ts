import { describe, expect, it } from "bun:test";

import { WalletBalanceChanged } from "../../../../src/domain/events/wager-transaction-events";
import {
  backoffDelayMs,
  OutboxMessage,
} from "../../../../src/domain/messaging/outbox-message";
import { Money } from "../../../../src/domain/money/money";
import { InvariantViolationError } from "../../../../src/domain/shared/domain-error";
import { Wallet } from "../../../../src/domain/wallet/wallet";
import { defaultOutboxOptions } from "../../../../src/application/wagering/publish-outbox";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-10T10:00:00.000Z");

function eventoDeExemplo(): WalletBalanceChanged {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl("100.00"),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    now: at,
  }).wallet;
  const entry = wallet.debit({
    entryId: "entry-1",
    transactionId: "tx-1",
    money: brl("25.00"),
    at,
  });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: "event-1",
    correlationId: "corr-1",
    occurredAt: at,
  });
}

describe("OutboxMessage — enfileiramento", () => {
  it("o id da linha e o eventId do evento", () => {
    const outbox = OutboxMessage.enqueue(eventoDeExemplo());
    expect(outbox.id).toBe("event-1");
    expect(outbox.aggregateId).toBe("wallet-1");
    expect(outbox.eventType).toBe("WalletBalanceChanged");
  });

  it("guarda a partitionKey para o MessageGroupId do FIFO", () => {
    expect(OutboxMessage.enqueue(eventoDeExemplo()).partitionKey).toBe("wallet-1");
  });

  it("nasce pendente, sem tentativas e vencida de imediato", () => {
    const outbox = OutboxMessage.enqueue(eventoDeExemplo());
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(at)).toBe(true);
    expect(outbox.nextAttemptAt).toBeUndefined();
    expect(outbox.publishedAt).toBeUndefined();
  });

  it("guarda o envelope serializado, nao o objeto de evento", () => {
    const outbox = OutboxMessage.enqueue(eventoDeExemplo());
    const payload = outbox.payload as Record<string, unknown>;
    expect(payload["eventType"]).toBe("WalletBalanceChanged");
    expect(typeof payload["occurredAt"]).toBe("string");
    expect(JSON.parse(JSON.stringify(outbox.payload))).toEqual(outbox.payload);
  });
});

describe("OutboxMessage — publicacao", () => {
  it("publicar encerra a pendencia", () => {
    const outbox = OutboxMessage.enqueue(eventoDeExemplo());
    const depois = new Date("2026-11-10T10:00:05.000Z");
    outbox.markPublished(depois);

    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(depois)).toBe(false);
    expect(outbox.publishedAt).toBe(depois);
  });

  it("publicar duas vezes e bug: a reivindicacao por SKIP LOCKED falhou", () => {
    const outbox = OutboxMessage.enqueue(eventoDeExemplo());
    outbox.markPublished(at);
    expect(() => outbox.markPublished(at)).toThrow(InvariantViolationError);
  });

  it("nao agenda retry de linha ja publicada", () => {
    const outbox = OutboxMessage.enqueue(eventoDeExemplo());
    outbox.markPublished(at);
    expect(() => outbox.scheduleRetry(at)).toThrow(/ja publicada/);
  });
});

describe("OutboxMessage — backoff", () => {
  it("cresce exponencialmente e satura em 5 minutos", () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
    expect(backoffDelayMs(9)).toBe(256_000);
    expect(backoffDelayMs(10)).toBe(300_000);
    expect(backoffDelayMs(50)).toBe(300_000);
  });

  it("scheduleRetry incrementa tentativa e adia conforme o backoff", () => {
    const outbox = OutboxMessage.enqueue(eventoDeExemplo());

    outbox.scheduleRetry(at);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(at.getTime() + 1_000);
    expect(outbox.isDue(at)).toBe(false);
    expect(outbox.isDue(new Date(at.getTime() + 1_000))).toBe(true);

    outbox.scheduleRetry(at);
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt?.getTime()).toBe(at.getTime() + 2_000);
  });

  it("rehydrate restaura tentativas e agendamento", () => {
    const outbox = OutboxMessage.rehydrate({
      id: "event-9",
      aggregateId: "wallet-9",
      eventType: "WalletBalanceChanged",
      partitionKey: "wallet-9",
      payload: { eventType: "WalletBalanceChanged" },
      occurredAt: at,
      attempts: 4,
      nextAttemptAt: new Date(at.getTime() + 8_000),
    });
    expect(outbox.attempts).toBe(4);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(at)).toBe(false);
  });
});

describe("horizonte de retentativa da outbox", () => {
  it("as tentativas cobrem mais de meia hora e alcancam o teto do backoff", () => {
    // Dois limites que precisam ser coerentes. Com teto de 5 min, 10
    // tentativas cobririam 8,5 min e a maior espera usada seria de 256s: o
    // teto nunca entraria em jogo e seria decoracao, e o horizonte real seria
    // um terco do que o comentario prometia.
    const { maxAttempts } = defaultOutboxOptions("teste");
    let total = 0;
    let alcancouOTeto = false;

    for (let tentativa = 1; tentativa < maxAttempts; tentativa += 1) {
      const atraso = backoffDelayMs(tentativa);
      total += atraso;
      if (atraso === 5 * 60 * 1000) alcancouOTeto = true;
    }

    expect(alcancouOTeto).toBe(true);
    expect(total).toBeGreaterThan(30 * 60 * 1000);
  });
});
