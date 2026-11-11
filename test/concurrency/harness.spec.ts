import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { corrida, falhasDeProcesso } from "./support/corrida";
import { aposta, Mundo } from "./support/mundo";
import { rodaEmParalelo } from "./support/processos";

const QUEBRA = "test/concurrency/workers/quebra-no-boot.ts";
const SUBMETE = "test/concurrency/workers/submete.ts";

let mundo: Mundo;

// O schema e recriado aqui tambem: sem isso, este arquivo dependeria de outro
// ter rodado antes para as migrations existirem, e falharia por motivo alheio.
beforeAll(async () => {
  mundo = await Mundo.abre();
});

afterAll(async () => {
  await mundo.fecha();
});

describe("o harness falha rapido e com diagnostico", () => {
  it("filho que morre no boot nao pendura a corrida", async () => {
    const inicio = Date.now();

    const erro = await corrida(QUEBRA, [{}, {}], { prazoDaBarreiraMs: 1_500 }).then(
      () => undefined,
      (e: unknown) => e,
    );

    // Falhar com o motivo e o requisito: sem isso, um filho que morre na
    // inicializacao travava o arquivo ate o timeout do runner dizendo apenas
    // "timeout", e o segundo filho ficava orfao segurando conexao do Postgres.
    expect(erro).toBeInstanceOf(Error);
    expect(String(erro)).toContain("barreira");
    expect(String(erro)).toContain("falhei na inicializacao de proposito");
    expect(Date.now() - inicio).toBeLessThan(15_000);
  }, 30_000);

  it("falhasDeProcesso acusa saida com erro, nao so ausencia de resultado", async () => {
    const execucao = rodaEmParalelo(QUEBRA, [{}]);
    const spawnados = await execucao.resultado;

    expect(falhasDeProcesso(spawnados)).toHaveLength(1);
    expect(falhasDeProcesso(spawnados)[0]).toContain("exit=1");
  }, 30_000);

  it("a barreira so libera depois de todos anunciarem", async () => {
    const carteira = await mundo.carteira("100.00");
    const tarefas = [0, 1].map(() => ({
      comandos: [aposta(carteira, { money: { amount: "1.00", currency: "BRL" } })],
    }));

    const { desfechos, spawnados } = await corrida(SUBMETE, tarefas);

    expect(falhasDeProcesso(spawnados)).toEqual([]);
    expect(desfechos).toHaveLength(2);
    expect(new Set(desfechos.map((d) => d.pid)).size).toBe(2);
  }, 60_000);
});
