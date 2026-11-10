import { describe, expect, it } from "bun:test";

import { Money } from "../../../../src/domain/money/money";
import {
  DomainRuleViolationError,
  InvalidInputError,
  InvariantViolationError,
} from "../../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../../src/domain/shared/failure-code";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction";
import { Wallet } from "../../../../src/domain/wallet/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-10T10:00:00.000Z");

const abertura = (saldo = "100.00") =>
  Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(saldo),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    now: at,
  });

const abrir = (saldo = "100.00") => abertura(saldo).wallet;

const mov = (n: number) => ({ entryId: `entry-${n}`, transactionId: `tx-${n}`, at });

describe("Wallet — abertura", () => {
  it("nasce com version 1, o saldo inicial e o lancamento de abertura", () => {
    const { wallet, openingEntry } = abertura("1000.00");

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.currency).toBe("BRL");

    // A abertura E a criacao, nao uma movimentacao posterior: version fica em 1.
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe("1000.00");
    expect(openingEntry?.isBalanced()).toBe(true);
    expect(openingEntry?.transactionId).toBe("tx-opening");
  });

  it("nao existe saldo sem lancamento: a abertura reconstroi pelo ledger", () => {
    const { wallet, openingEntry } = abertura("1000.00");
    const reconstruido = Money.zero("BRL").add(openingEntry!.money);
    expect(reconstruido.equals(wallet.balance)).toBe(true);
  });

  it("abre zerada e nao gera lancamento nenhum", () => {
    const { wallet, openingEntry } = abertura("0");
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it("abertura com saldo exige os ids do lancamento", () => {
    expect(() =>
      Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl("10.00") }),
    ).toThrow(/exige openingTransactionId/);
  });

  it("abertura zerada nao exige ids de lancamento", () => {
    expect(() =>
      Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: Money.zero("BRL") }),
    ).not.toThrow();
  });

  it("recusa abrir com saldo negativo", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: brl("10.00").negate(),
      }),
    ).toThrow(InvalidInputError);
  });

  const identificadoresRuins = [
    { id: "" },
    { id: "   " },
    { id: " wallet-1 " },
    { playerId: "" },
    { playerId: "player-1 " },
  ];

  for (const over of identificadoresRuins) {
    it(`recusa identificador ${JSON.stringify(over)}`, () => {
      expect(() =>
        Wallet.open({
          id: "wallet-1",
          playerId: "player-1",
          initialBalance: Money.zero("BRL"),
          ...over,
        }),
      ).toThrow(InvalidInputError);
    });
  }
});

describe("Wallet — saldo e ledger andam juntos", () => {
  it("debito reduz saldo, incrementa version e devolve lancamento coerente", () => {
    const wallet = abrir("100.00");
    const entry = wallet.debit({ ...mov(1), money: brl("25.00") });

    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("75.00");
    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletId).toBe(wallet.id);
  });

  it("credito aumenta saldo e incrementa version", () => {
    const wallet = abrir("100.00");
    const entry = wallet.credit({ ...mov(1), money: brl("50.00") });

    expect(wallet.balance.toJSON().amount).toBe("150.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  it("version incrementa uma vez por movimentacao, e so por movimentacao", () => {
    const wallet = abrir("100.00");
    expect(wallet.version).toBe(1);
    wallet.debit({ ...mov(1), money: brl("10.00") });
    expect(wallet.version).toBe(2);
    wallet.credit({ ...mov(2), money: brl("10.00") });
    expect(wallet.version).toBe(3);
    // Consultar nao move nada.
    wallet.hasSufficientBalance(brl("1.00"));
    expect(wallet.version).toBe(3);
  });

  it("o lancamento devolvido reconstroi o saldo final", () => {
    const wallet = abrir("100.00");
    const e1 = wallet.debit({ ...mov(1), money: brl("30.00") });
    const e2 = wallet.credit({ ...mov(2), money: brl("5.00") });

    const reconstruido = [e1, e2].reduce(
      (saldo, e) =>
        e.direction === LedgerDirection.Credit ? saldo.add(e.money) : saldo.subtract(e.money),
      brl("100.00"),
    );
    expect(reconstruido.equals(wallet.balance)).toBe(true);
  });
});

describe("Wallet — saldo nunca negativo", () => {
  it("permite debitar exatamente o saldo inteiro", () => {
    const wallet = abrir("100.00");
    wallet.debit({ ...mov(1), money: brl("100.00") });
    expect(wallet.balance.isZero()).toBe(true);
  });

  it("hasSufficientBalance e exato na fronteira", () => {
    const wallet = abrir("100.00");
    expect(wallet.hasSufficientBalance(brl("100.00"))).toBe(true);
    expect(wallet.hasSufficientBalance(brl("100.01"))).toBe(false);
  });

  it("debitar alem do saldo e bug de programacao, nao caminho de negocio", () => {
    const wallet = abrir("100.00");
    expect(() => wallet.debit({ ...mov(1), money: brl("100.01") })).toThrow(
      InvariantViolationError,
    );
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  it("cenario obrigatorio da secao 8, no nivel do dominio", () => {
    // Saldo 100, duas apostas de 80. A primeira passa; a segunda nao cabe.
    const wallet = abrir("100.00");
    expect(wallet.hasSufficientBalance(brl("80.00"))).toBe(true);
    wallet.debit({ ...mov(1), money: brl("80.00") });

    expect(wallet.hasSufficientBalance(brl("80.00"))).toBe(false);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });
});

describe("Wallet — conflito de moeda", () => {
  it("rejeita operacao em moeda diferente da wallet, com FailureCode", () => {
    const wallet = abrir("100.00");
    const dolar = Money.from({ amount: "10.00", currency: "USD" });

    for (const operacao of [
      () => wallet.debit({ ...mov(1), money: dolar }),
      () => wallet.credit({ ...mov(1), money: dolar }),
      () => wallet.hasSufficientBalance(dolar),
    ]) {
      try {
        operacao();
        throw new Error("deveria ter lancado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(DomainRuleViolationError);
        expect((erro as DomainRuleViolationError).failureCode).toBe(FailureCode.CurrencyMismatch);
      }
    }
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet — movimentacao invalida", () => {
  it("rejeita valor zero", () => {
    const wallet = abrir("100.00");
    expect(() => wallet.debit({ ...mov(1), money: Money.zero("BRL") })).toThrow(
      /nao positivo/,
    );
    expect(() => wallet.credit({ ...mov(1), money: Money.zero("BRL") })).toThrow(
      /nao positivo/,
    );
  });

  it("rejeita valor negativo", () => {
    const wallet = abrir("100.00");
    expect(() => wallet.credit({ ...mov(1), money: brl("10.00").negate() })).toThrow(
      /nao positivo/,
    );
  });
});

describe("Wallet — rehydrate", () => {
  it("reconstroi estado persistido sem revalidar", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: "player-9",
      currency: "BRL",
      balance: brl("42.00"),
      version: 17,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(17);
    expect(wallet.balance.toJSON().amount).toBe("42.00");
  });

  it("continua aplicando invariantes depois de reidratada", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: "player-9",
      currency: "BRL",
      balance: brl("10.00"),
      version: 3,
      createdAt: at,
      updatedAt: at,
    });
    expect(() => wallet.debit({ ...mov(1), money: brl("10.01") })).toThrow(
      InvariantViolationError,
    );
  });
});
