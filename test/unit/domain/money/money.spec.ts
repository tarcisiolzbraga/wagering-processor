import { describe, expect, it } from "bun:test";

import { Money } from "../../../../src/domain/money/money";
import {
  DomainRuleViolationError,
  InvalidInputError,
} from "../../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../../src/domain/shared/failure-code";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money — construcao e normalizacao", () => {
  it("serializa sempre com escala 2", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("25").toJSON().amount).toBe("25.00");
    expect(brl("25.5").toJSON().amount).toBe("25.50");
    expect(brl("0").toJSON().amount).toBe("0.00");
  });

  it("aceita zeros a esquerda e o limite de 18 digitos inteiros", () => {
    expect(brl("025.00").toJSON().amount).toBe("25.00");
    expect(brl("000000000000000001.00").toJSON().amount).toBe("1.00");
    expect(brl("999999999999999999.99").toJSON().amount).toBe("999999999999999999.99");
  });

  it("zero(currency) nasce zerado", () => {
    const zero = Money.zero("BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });

  it("toString traz valor e moeda", () => {
    expect(brl("1234.5").toString()).toBe("1234.50 BRL");
  });
});

describe("Money — entradas rejeitadas", () => {
  const invalidos: ReadonlyArray<[string, unknown]> = [
    ["string vazia", ""],
    ["espaco a esquerda", " 25.00"],
    ["espaco a direita", "25.00 "],
    ["tres casas decimais", "25.123"],
    ["notacao cientifica minuscula", "1e3"],
    ["notacao cientifica maiuscula", "2E-3"],
    ["NaN textual", "NaN"],
    ["Infinity textual", "Infinity"],
    ["-Infinity textual", "-Infinity"],
    ["texto", "vinte e cinco"],
    ["ponto sem decimais", "25."],
    ["decimais sem inteiro", ".5"],
    ["separador de milhar", "1,000.00"],
    ["sinal de mais", "+25.00"],
    ["dois pontos", "2.5.0"],
    ["negativo", "-25.00"],
    ["negativo fracionario", "-0.01"],
    ["19 digitos inteiros", "1000000000000000000.00"],
    ["numero em vez de string", 25],
    ["null", null],
    ["undefined", undefined],
    ["objeto", { amount: "25.00" }],
  ];

  for (const [rotulo, amount] of invalidos) {
    it(`rejeita ${rotulo}`, () => {
      expect(() => Money.from({ amount: amount as string, currency: "BRL" })).toThrow(
        InvalidInputError,
      );
    });
  }

  it("a mensagem de erro de escala explica o motivo", () => {
    expect(() => brl("25.123")).toThrow(/3 casas decimais/);
  });

  it("a mensagem de erro de negativo aponta o contrato de entrada", () => {
    expect(() => brl("-1.00")).toThrow(/contrato de entrada/);
  });
});

describe("Money — moeda", () => {
  const moedasInvalidas: ReadonlyArray<[string, unknown]> = [
    ["minuscula", "brl"],
    ["duas letras", "BR"],
    ["quatro letras", "BRLL"],
    ["com digito", "BR1"],
    ["vazia", ""],
    ["numero", 986],
    ["null", null],
  ];

  for (const [rotulo, currency] of moedasInvalidas) {
    it(`rejeita moeda ${rotulo}`, () => {
      expect(() => Money.from({ amount: "1.00", currency: currency as string })).toThrow(
        InvalidInputError,
      );
    });
  }

  it("operacao entre moedas diferentes lanca erro de dominio", () => {
    const real = brl("10.00");
    const dolar = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => real.add(dolar)).toThrow(InvalidInputError);
    expect(() => real.subtract(dolar)).toThrow(InvalidInputError);
    expect(() => real.isLessThan(dolar)).toThrow(/moedas diferentes/);
  });

  it("equals e comparacao total: moedas diferentes sao diferentes, nao erro", () => {
    // Ordenar valores de moedas distintas nao tem significado, por isso
    // isLessThan lanca. Perguntar se sao iguais tem: a resposta e nao.
    const real = brl("10.00");
    const dolar = Money.from({ amount: "10.00", currency: "USD" });
    expect(real.equals(dolar)).toBe(false);
  });
});

describe("Money — imutabilidade", () => {
  it("add nao altera nenhum dos operandos", () => {
    const a = brl("10.00");
    const b = brl("5.00");
    const soma = a.add(b);

    expect(a.toJSON().amount).toBe("10.00");
    expect(b.toJSON().amount).toBe("5.00");
    expect(soma.toJSON().amount).toBe("15.00");
    expect(soma).not.toBe(a);
  });

  it("negate devolve nova instancia", () => {
    const a = brl("10.00");
    expect(a.negate().toJSON().amount).toBe("-10.00");
    expect(a.toJSON().amount).toBe("10.00");
  });
});

describe("Money — aritmetica exata", () => {
  it("0.10 + 0.20 da exatamente 0.30", () => {
    // O caso que quebra IEEE-754 e a razao de dinheiro nunca ser number.
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
  });

  it("nao acumula erro em muitas somas de centavo", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i += 1) total = total.add(brl("0.01"));
    expect(total.toJSON().amount).toBe("10.00");
  });

  it("preserva exatidao no limite de 18 digitos inteiros", () => {
    const grande = brl("999999999999999999.98");
    expect(grande.add(brl("0.01")).toJSON().amount).toBe("999999999999999999.99");
  });

  it("subtract abaixo de zero produz valor negativo — e assim que saldo insuficiente aparece", () => {
    const resultado = brl("20.00").subtract(brl("80.00"));
    expect(resultado.isNegative()).toBe(true);
    expect(resultado.toJSON().amount).toBe("-60.00");
  });
});

describe("Money — predicados", () => {
  it("isZero, isPositive e isNegative sao mutuamente consistentes", () => {
    const zero = Money.zero("BRL");
    const positivo = brl("0.01");
    const negativo = brl("0.01").negate();

    expect([zero.isZero(), zero.isPositive(), zero.isNegative()]).toEqual([true, false, false]);
    expect([positivo.isZero(), positivo.isPositive(), positivo.isNegative()]).toEqual([
      false,
      true,
      false,
    ]);
    expect([negativo.isZero(), negativo.isPositive(), negativo.isNegative()]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("zero negado continua nao sendo negativo", () => {
    expect(Money.zero("BRL").negate().isNegative()).toBe(false);
    expect(Money.zero("BRL").negate().isZero()).toBe(true);
  });

  it("isLessThan compara valor", () => {
    expect(brl("10.00").isLessThan(brl("10.01"))).toBe(true);
    expect(brl("10.00").isLessThan(brl("10.00"))).toBe(false);
    expect(brl("10.01").isLessThan(brl("10.00"))).toBe(false);
  });

  it("equals compara valor e moeda, nao representacao", () => {
    expect(brl("25").equals(brl("25.00"))).toBe(true);
    expect(brl("25.10").equals(brl("25.1"))).toBe(true);
    expect(brl("25.00").equals(brl("25.01"))).toBe(false);
  });
});

describe("Money — teto de 18 digitos inteiros", () => {
  it("rejeita soma que estoura a capacidade da coluna", () => {
    // Sem isso o valor passaria por todo o dominio e morreria no INSERT com
    // 22003, o que seria lido como falha transitoria e viraria loop de retry.
    const teto = brl("999999999999999999.99");
    try {
      teto.add(brl("0.01"));
      throw new Error("deveria ter lancado");
    } catch (erro) {
      expect(erro).toBeInstanceOf(DomainRuleViolationError);
      expect((erro as DomainRuleViolationError).failureCode).toBe(FailureCode.AmountOverflow);
    }
  });

  it("rejeita tambem o estouro para o lado negativo", () => {
    const piso = brl("999999999999999999.99").negate();
    expect(() => piso.subtract(brl("0.01"))).toThrow(DomainRuleViolationError);
  });

  it("o valor exatamente no teto continua valido", () => {
    expect(brl("999999999999999999.98").add(brl("0.01")).toJSON().amount).toBe(
      "999999999999999999.99",
    );
  });
});
