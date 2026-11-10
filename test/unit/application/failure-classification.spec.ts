import { describe, expect, it } from "bun:test";

import {
  FailureKind,
  classifyFailure,
} from "../../../src/application/shared/failure-classification";
import {
  DomainRuleViolationError,
  InvalidInputError,
  InvariantViolationError,
} from "../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../src/domain/shared/failure-code";

const comCodigo = (code: string): Error => Object.assign(new Error(code), { code });

describe("classifyFailure — erro de dominio", () => {
  it("regra de negocio e terminal", () => {
    expect(
      classifyFailure(new DomainRuleViolationError(FailureCode.InsufficientFunds, "sem saldo")),
    ).toBe(FailureKind.Business);
  });

  it("payload invalido e permanente: retry nao conserta JSON errado", () => {
    expect(classifyFailure(new InvalidInputError("escala errada"))).toBe(FailureKind.Permanent);
  });

  it("invariante violada e permanente", () => {
    expect(classifyFailure(new InvariantViolationError("bug"))).toBe(FailureKind.Permanent);
  });
});

describe("classifyFailure — SQLSTATE", () => {
  const transitorios = ["40001", "40P01", "55P03", "57P01", "08006", "08003", "53300"];
  for (const code of transitorios) {
    it(`${code} e transitorio`, () => {
      expect(classifyFailure(comCodigo(code))).toBe(FailureKind.Transient);
    });
  }

  const permanentes = ["23505", "22P02", "42703", "23514"];
  for (const code of permanentes) {
    it(`${code} e permanente`, () => {
      expect(classifyFailure(comCodigo(code))).toBe(FailureKind.Permanent);
    });
  }

  it("le o codigo do erro embrulhado pelo ORM", () => {
    const embrulhado = Object.assign(new Error("wrap"), { previous: comCodigo("40P01") });
    expect(classifyFailure(embrulhado)).toBe(FailureKind.Transient);
  });
});

describe("classifyFailure — erro de socket do Node", () => {
  // EPIPE tem 5 caracteres de [0-9A-Z] e passava pelo teste de SQLSTATE,
  // sendo classificado como permanente: um socket de banco caindo virava 500
  // com retryable: false, e DLQ em vez de retry no consumer.
  const socket = ["EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"];
  for (const code of socket) {
    it(`${code} e transitorio`, () => {
      expect(classifyFailure(comCodigo(code))).toBe(FailureKind.Transient);
    });
  }

  it("EPIPE nao e confundido com SQLSTATE", () => {
    expect(classifyFailure(comCodigo("EPIPE"))).not.toBe(FailureKind.Permanent);
  });
});

describe("classifyFailure — desconhecido", () => {
  it("cai em transitorio: o limite de tentativas da fila impede o loop", () => {
    expect(classifyFailure(new Error("sei la"))).toBe(FailureKind.Transient);
    expect(classifyFailure("string solta")).toBe(FailureKind.Transient);
  });
});
