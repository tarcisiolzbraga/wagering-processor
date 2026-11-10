import { describe, expect, it } from "bun:test";

import {
  canonicalizeForTest,
  computePayloadHash,
  type HashableWagerPayload,
} from "../../../src/application/wagering/payload-hash";
import { InvalidInputError } from "../../../src/domain/shared/domain-error";
import { WagerTransactionKind as Kind } from "../../../src/domain/wagering/wager-transaction-kind";

const base: HashableWagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: Kind.Bet,
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalizacao", () => {
  it("ordena chaves, nao usa espaco e omite campo ausente", () => {
    expect(canonicalizeForTest({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
  });

  it("e recursiva", () => {
    expect(canonicalizeForTest({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("preserva ordem de array, que e significativa", () => {
    expect(canonicalizeForTest({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("distingue null de ausente", () => {
    expect(canonicalizeForTest({ a: null })).toBe('{"a":null}');
    expect(canonicalizeForTest({ a: undefined })).toBe("{}");
  });
});

describe("computePayloadHash — estabilidade", () => {
  it("o hash do payload de referencia nao muda", () => {
    // Golden: fixa o algoritmo. Se este valor mudar, a mudanca foi deliberada
    // e quebra a deteccao de replay de todo provedor em voo.
    expect(computePayloadHash(base)).toBe(
      "629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344",
    );
  });

  it("ordem das chaves no objeto de entrada nao afeta o hash", () => {
    const invertido: HashableWagerPayload = {
      money: { currency: "BRL", amount: "25.00" },
      kind: Kind.Bet,
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    };
    expect(computePayloadHash(invertido)).toBe(computePayloadHash(base));
  });

  it("formatacao do valor nao cria conflito: 25, 25.0 e 25.00 sao o mesmo dinheiro", () => {
    const esperado = computePayloadHash(base);
    for (const amount of ["25", "25.0", "25.00"]) {
      expect(computePayloadHash({ ...base, money: { amount, currency: "BRL" } })).toBe(esperado);
    }
  });

  it("referencia ausente e referencia undefined dao o mesmo hash", () => {
    expect(
      computePayloadHash({ ...base, referenceExternalTransactionId: undefined }),
    ).toBe(computePayloadHash(base));
  });

  it("valor monetario invalido e recusado em vez de hasheado", () => {
    expect(() =>
      computePayloadHash({ ...base, money: { amount: "25.123", currency: "BRL" } }),
    ).toThrow(InvalidInputError);
  });
});

describe("computePayloadHash — sensibilidade", () => {
  const variacoes: ReadonlyArray<[string, Partial<HashableWagerPayload>]> = [
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: crypto.randomUUID() }],
    ["walletId", { walletId: crypto.randomUUID() }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "outro-jogo" }],
    ["kind", { kind: Kind.Win }],
    ["valor", { money: { amount: "25.01", currency: "BRL" } }],
    ["moeda", { money: { amount: "25.00", currency: "USD" } }],
    ["referencia", { referenceExternalTransactionId: "transaction-100" }],
  ];

  const esperado = computePayloadHash(base);

  for (const [campo, mudanca] of variacoes) {
    it(`muda quando ${campo} muda`, () => {
      expect(computePayloadHash({ ...base, ...mudanca })).not.toBe(esperado);
    });
  }

  it("mesma key com payload diferente e detectavel — e o que separa replay de conflito", () => {
    const original = computePayloadHash(base);
    const adulterado = computePayloadHash({
      ...base,
      money: { amount: "2500.00", currency: "BRL" },
    });
    expect(adulterado).not.toBe(original);
  });
});
