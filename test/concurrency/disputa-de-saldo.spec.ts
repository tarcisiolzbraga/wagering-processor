import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { FailureCode } from "../../src/domain/shared/failure-code";
import {
  SubmitOutcome,
  type SubmitWagerTransactionCommand,
} from "../../src/application/wagering/submit-wager-transaction";
import { corrida as dispara, falhasDeProcesso } from "./support/corrida";
import { aposta, Mundo } from "./support/mundo";

const SUBMETE = "test/concurrency/workers/submete.ts";

let mundo: Mundo;

/** Um processo por comando, todos largando juntos. */
function disparaComandos(comandos: SubmitWagerTransactionCommand[]) {
  return dispara(
    SUBMETE,
    comandos.map((comando) => ({ comandos: [comando] })),
  );
}

beforeAll(async () => {
  mundo = await Mundo.abre();
});

afterAll(async () => {
  await mundo.fecha();
});

describe("o cenario obrigatorio, com processos de verdade", () => {
  it("saldo 100, duas apostas de 80 simultaneas: uma passa, uma e recusada", async () => {
    const carteira = await mundo.carteira("100.00");
    const comandos = [
      aposta(carteira, { money: { amount: "80.00", currency: "BRL" } }),
      aposta(carteira, { money: { amount: "80.00", currency: "BRL" } }),
    ];

    const { desfechos, spawnados } = await disparaComandos(comandos);

    expect(falhasDeProcesso(spawnados)).toEqual([]);
    expect(desfechos).toHaveLength(2);

    const processadas = desfechos.filter((d) => d.outcome === SubmitOutcome.Processed);
    const recusadas = desfechos.filter((d) => d.outcome === SubmitOutcome.Rejected);
    expect(processadas).toHaveLength(1);
    expect(recusadas).toHaveLength(1);
    expect(recusadas[0]!.failureCode).toBe(FailureCode.InsufficientFunds);
    // Processos diferentes de verdade: se fossem o mesmo, nao haveria corrida.
    expect(new Set(desfechos.map((d) => d.pid)).size).toBe(2);

    expect(await mundo.saldo(carteira.walletId)).toBe("20.00");

    // Exatamente um debito, e o saldo fecha com o ledger.
    const lancamentos = await mundo.lancamentos(carteira.walletId);
    const debitos = lancamentos.filter((l) => l.direction === "DEBIT");
    expect(debitos).toHaveLength(1);
    expect(debitos[0]!.amount).toBe("80.00");
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 60_000);

  it("tres processos disputando a mesma carteira: so o saldo disponivel sai", async () => {
    // Saldo para duas das tres apostas de 40: a terceira tem que ser recusada.
    const carteira = await mundo.carteira("100.00");
    const comandos = [0, 1, 2].map(() =>
      aposta(carteira, { money: { amount: "40.00", currency: "BRL" } }),
    );

    const { desfechos, spawnados } = await disparaComandos(comandos);

    expect(falhasDeProcesso(spawnados)).toEqual([]);
    expect(desfechos.filter((d) => d.outcome === SubmitOutcome.Processed)).toHaveLength(2);
    const recusadas = desfechos.filter((d) => d.outcome === SubmitOutcome.Rejected);
    expect(recusadas).toHaveLength(1);
    expect(recusadas[0]!.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(new Set(desfechos.map((d) => d.pid)).size).toBe(3);

    expect(await mundo.saldo(carteira.walletId)).toBe("20.00");
    // Versao sobe uma vez por movimento de saldo, nao uma por requisicao.
    expect(await mundo.versao(carteira.walletId)).toBe(3);
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 60_000);

  it("nenhum processo recebe erro cru de concorrencia", async () => {
    // Deadlock ou falha de serializacao vazando para o provedor e falha do
    // desenho: o perdedor tem que receber REJECTED com failureCode, nao 500.
    const carteira = await mundo.carteira("50.00");
    const comandos = [0, 1, 2, 3].map(() =>
      aposta(carteira, { money: { amount: "50.00", currency: "BRL" } }),
    );

    const { desfechos, spawnados } = await disparaComandos(comandos);

    // Sem estas duas, o teste passaria com dois processos mortos antes de
    // reportar: "nenhum erro cru" seria verdade por ausencia de resultado.
    expect(falhasDeProcesso(spawnados)).toEqual([]);
    expect(desfechos).toHaveLength(4);
    expect(new Set(desfechos.map((d) => d.pid)).size).toBe(4);

    expect(desfechos.filter((d) => d.outcome === "THREW")).toEqual([]);
    expect(desfechos.filter((d) => d.outcome === SubmitOutcome.Processed)).toHaveLength(1);
    expect(await mundo.saldo(carteira.walletId)).toBe("0.00");
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 60_000);
});
