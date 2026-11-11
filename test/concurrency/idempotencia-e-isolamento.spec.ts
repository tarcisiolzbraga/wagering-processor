import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { SubmitOutcome } from "../../src/application/wagering/submit-wager-transaction";
import { corrida, falhasDeProcesso } from "./support/corrida";
import { aposta, Mundo } from "./support/mundo";

const SUBMETE = "test/concurrency/workers/submete.ts";

let mundo: Mundo;

beforeAll(async () => {
  mundo = await Mundo.abre();
});

afterAll(async () => {
  await mundo.fecha();
});

describe("mesma aposta em paralelo", () => {
  it("50 submissoes identicas produzem um unico debito", async () => {
    const carteira = await mundo.carteira("1000.00");
    // A mesma idempotency key nas 50 tentativas: 5 processos x 10 em paralelo.
    const comando = aposta(carteira, { money: { amount: "25.00", currency: "BRL" } });
    const tarefas = Array.from({ length: 5 }, () => ({ comandos: [comando], vezes: 10 }));

    const { desfechos, spawnados } = await corrida(SUBMETE, tarefas);

    expect(falhasDeProcesso(spawnados)).toEqual([]);
    expect(desfechos).toHaveLength(50);
    expect(desfechos.filter((d) => d.outcome === "THREW")).toEqual([]);
    expect(new Set(desfechos.map((d) => d.pid)).size).toBe(5);

    // Exatamente uma aplicacao; as outras 49 sao replay do mesmo resultado.
    const aplicadas = desfechos.filter((d) => d.idempotentReplay === false);
    expect(aplicadas).toHaveLength(1);
    expect(aplicadas[0]!.outcome).toBe(SubmitOutcome.Processed);

    const replays = desfechos.filter((d) => d.idempotentReplay === true);
    expect(replays).toHaveLength(49);
    // Replay devolve o resultado original, nao um novo.
    expect(new Set(replays.map((d) => d.transactionId))).toEqual(
      new Set([aplicadas[0]!.transactionId]),
    );
    expect(replays.every((d) => d.outcome === SubmitOutcome.Processed)).toBe(true);

    expect(await mundo.saldo(carteira.walletId)).toBe("975.00");
    const debitos = (await mundo.lancamentos(carteira.walletId)).filter(
      (l) => l.direction === "DEBIT",
    );
    expect(debitos).toHaveLength(1);
    // Versao sobe uma vez: a abertura creditou sem mover versao, e o debito moveu.
    expect(await mundo.versao(carteira.walletId)).toBe(2);
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 120_000);

  it("retry nao duplica quando o primeiro ainda nao commitou", async () => {
    // Duas submissoes da mesma key saindo ao mesmo tempo: a perdedora bloqueia
    // no indice unico ate o commit da vencedora e **entao** le o resultado.
    // Sem o insert-first, as duas leriam "nao existe" e debitariam.
    const carteira = await mundo.carteira("100.00");
    const comando = aposta(carteira, { money: { amount: "60.00", currency: "BRL" } });

    const { desfechos } = await corrida(SUBMETE, [
      { comandos: [comando] },
      { comandos: [comando] },
    ]);

    expect(desfechos.filter((d) => d.idempotentReplay === false)).toHaveLength(1);
    expect(desfechos.filter((d) => d.idempotentReplay === true)).toHaveLength(1);
    expect(await mundo.saldo(carteira.walletId)).toBe("40.00");
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 60_000);
});

describe("carteiras distintas nao se bloqueiam", () => {
  it("quatro processos em quatro carteiras: todas as apostas passam", async () => {
    const carteiras = await Promise.all([
      mundo.carteira("100.00"),
      mundo.carteira("100.00"),
      mundo.carteira("100.00"),
      mundo.carteira("100.00"),
    ]);

    const tarefas = carteiras.map((carteira) => ({
      comandos: [aposta(carteira, { money: { amount: "30.00", currency: "BRL" } })],
    }));

    const { desfechos, spawnados } = await corrida(SUBMETE, tarefas);

    expect(falhasDeProcesso(spawnados)).toEqual([]);
    // Nenhuma recusa: a unidade de concorrencia e a carteira, nao o sistema.
    // Um lock global compartilhado faria isto passar igual, mas o teste
    // seguinte — carteiras distintas sem contencao — e o que o enunciado veda.
    expect(desfechos.filter((d) => d.outcome === SubmitOutcome.Processed)).toHaveLength(4);
    expect(desfechos.filter((d) => d.outcome === "THREW")).toEqual([]);

    for (const carteira of carteiras) {
      expect(await mundo.saldo(carteira.walletId)).toBe("70.00");
      await mundo.confereInvarianteFinal(carteira.walletId);
    }
  }, 120_000);

  it("uma carteira em disputa nao atrasa o que acontece nas outras", async () => {
    // Duas carteiras quentes com 3 apostas cada, tudo ao mesmo tempo: o
    // resultado de cada carteira depende so da propria disputa.
    const [quenteA, quenteB] = await Promise.all([
      mundo.carteira("100.00"),
      mundo.carteira("100.00"),
    ]);

    const tarefas = [quenteA!, quenteB!].flatMap((carteira) =>
      Array.from({ length: 3 }, () => ({
        comandos: [aposta(carteira, { money: { amount: "40.00", currency: "BRL" } })],
      })),
    );

    const { desfechos } = await corrida(SUBMETE, tarefas);

    for (const carteira of [quenteA!, quenteB!]) {
      const daCarteira = desfechos.filter((d) => d.walletId === carteira.walletId);
      expect(daCarteira.filter((d) => d.outcome === SubmitOutcome.Processed)).toHaveLength(2);
      expect(daCarteira.filter((d) => d.outcome === SubmitOutcome.Rejected)).toHaveLength(1);
      expect(await mundo.saldo(carteira.walletId)).toBe("20.00");
      await mundo.confereInvarianteFinal(carteira.walletId);
    }
  }, 120_000);
});
