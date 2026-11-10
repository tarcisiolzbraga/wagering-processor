import { describe, expect, it } from "bun:test";

import { InboxMessage } from "../../../../src/domain/messaging/inbox-message";
import { InvariantViolationError } from "../../../../src/domain/shared/domain-error";

const at = new Date("2026-11-10T10:00:00.000Z");
const receber = () =>
  InboxMessage.receive({
    messageId: "msg-123",
    consumerName: "wager-transactions",
    payloadHash: "hash-abc",
    receivedAt: at,
  });

describe("InboxMessage", () => {
  it("nasce nao processada", () => {
    const msg = receber();
    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();
  });

  it("marca como processada uma vez", () => {
    const msg = receber();
    const depois = new Date("2026-11-10T10:00:01.000Z");
    msg.markProcessed(depois);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toBe(depois);
  });

  it("marcar duas vezes e bug: a dedup falhou antes de chegar aqui", () => {
    const msg = receber();
    msg.markProcessed(at);
    expect(() => msg.markProcessed(at)).toThrow(InvariantViolationError);
  });

  for (const campo of ["messageId", "consumerName", "payloadHash"] as const) {
    it(`rejeita ${campo} vazio`, () => {
      expect(() =>
        InboxMessage.receive({
          messageId: "msg-123",
          consumerName: "c",
          payloadHash: "h",
          receivedAt: at,
          [campo]: "  ",
        }),
      ).toThrow(new RegExp(campo));
    });
  }

  it("rehydrate traz de volta o estado processado", () => {
    const msg = InboxMessage.rehydrate({
      messageId: "msg-123",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: at,
      processedAt: at,
    });
    expect(msg.isProcessed()).toBe(true);
  });
});
