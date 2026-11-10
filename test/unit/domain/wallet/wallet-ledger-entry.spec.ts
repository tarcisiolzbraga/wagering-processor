import { describe, expect, it } from "bun:test";

import { Money } from "../../../../src/domain/money/money";
import { InvariantViolationError } from "../../../../src/domain/shared/domain-error";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction";
import { WalletLedgerEntry } from "../../../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

const base = {
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  createdAt: new Date("2026-11-10T10:00:00.000Z"),
};

describe("WalletLedgerEntry", () => {
  it("cria debito com aritmetica fechada", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl("25.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("75.00"),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  it("cria credito com aritmetica fechada", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl("25.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("125.00"),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it("rejeita aritmetica que nao fecha", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("25.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("80.00"),
      }),
    ).toThrow(InvariantViolationError);
  });

  it("rejeita direction invertida em relacao a aritmetica", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl("25.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("75.00"),
      }),
    ).toThrow(/nao fecha/);
  });

  it("rejeita saldo final negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("150.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("100.00").subtract(brl("150.00")),
      }),
    ).toThrow(/saldo negativo/);
  });

  it("rejeita valor zero — o sinal e a direction, nunca o valor", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: Money.zero("BRL"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("100.00"),
      }),
    ).toThrow(/nao positivo/);
  });

  it("rejeita valor negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl("25.00").negate(),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("75.00"),
      }),
    ).toThrow(/nao positivo/);
  });

  it("rejeita mistura de moedas", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: "25.00", currency: "USD" }),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("75.00"),
      }),
    ).toThrow(/mistura moedas/);
  });

  it("nao expoe nenhum setter nem metodo de transicao", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl("25.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("75.00"),
    });
    const metodos = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(metodos.filter((m) => /^(set|mark|apply|update|reject|fail)/.test(m))).toEqual([]);
  });

  it("rehydrate nao revalida — carrega historico mesmo se a regra mudar", () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl("25.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("999.00"),
    });
    expect(entry.isBalanced()).toBe(false);
  });
});
