import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { esvaziaFilas, publicaOperacao } from "../support/sqs";
import { corrida, falhasDeProcesso } from "./support/corrida";
import { drenaEventos } from "./support/eventos";
import { Mundo } from "./support/mundo";

const CONSOME = "test/concurrency/workers/consome.ts";
const PUBLICA = "test/concurrency/workers/publica.ts";

/** O que os filhos de fila e outbox reportam. */
interface Evento {
  readonly pid: number;
  readonly evento?: string;
  readonly outcome?: string;
  readonly transactionId?: string;
  readonly processadas?: number;
  readonly publicados?: number;
}

let mundo: Mundo;

beforeAll(async () => {
  mundo = await Mundo.abre();
  // Mensagem de rodada anterior aponta para carteira que o reset do schema
  // acabou de apagar: sem limpar, o consumer falharia por motivo alheio.
  await esvaziaFilas();
  await drenaEventos();
});

afterAll(async () => {
  await mundo.fecha();
});

describe("worker morto depois do commit e antes do ack", () => {
  it("o efeito nao duplica quando a mensagem e reentregue", async () => {
    const carteira = await mundo.carteira("100.00");
    await publicaOperacao({
      messageId: `msg-${crypto.randomUUID()}`,
      walletId: carteira.walletId,
      playerId: carteira.playerId,
      amount: "25.00",
    });

    // SIGKILL logo depois do commit: nenhum handler de cleanup roda, nada e
    // acked, a visibilidade nao e devolvida.
    const primeiro = await corrida<Evento>(CONSOME, [{ mataDepoisDoCommit: true, ate: 1 }]);

    expect(primeiro.desfechos.map((d) => d.evento)).toContain("commitado");
    expect(primeiro.spawnados[0]!.signal).toBe("SIGKILL");
    // O dinheiro ja mudou: o commit aconteceu antes da morte.
    expect(await mundo.saldo(carteira.walletId)).toBe("75.00");
    expect(await mundo.contaInbox()).toBe(1);

    // A mensagem volta quando o visibility timeout expira (10s na fila de
    // teste). Um consumidor novo a recebe e a inbox barra o efeito.
    const segundo = await corrida<Evento>(CONSOME, [{ ate: 1, limiteMs: 25_000 }]);

    expect(falhasDeProcesso(segundo.spawnados)).toEqual([]);
    expect(segundo.desfechos.some((d) => (d.processadas ?? 0) >= 1)).toBe(true);
    // Mesmo saldo, mesmo lancamento unico: a reentrega nao debitou de novo.
    expect(await mundo.saldo(carteira.walletId)).toBe("75.00");
    const debitos = (await mundo.lancamentos(carteira.walletId)).filter(
      (l) => l.direction === "DEBIT",
    );
    expect(debitos).toHaveLength(1);
    expect(await mundo.contaInbox()).toBe(1);
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 90_000);
});

describe("reinicio com consistencia final", () => {
  it("quatro mensagens, consumidor morto no meio, estado final correto", async () => {
    const carteira = await mundo.carteira("100.00");
    const inboxAntes = await mundo.contaInbox();

    // Mesmo MessageGroupId (a carteira), entao a ordem e estrita.
    for (let i = 0; i < 4; i += 1) {
      await publicaOperacao({
        messageId: `msg-${crypto.randomUUID()}`,
        walletId: carteira.walletId,
        playerId: carteira.playerId,
        amount: "10.00",
      });
    }

    // Morre depois do primeiro commit, sem ack.
    const morto = await corrida<Evento>(CONSOME, [{ mataDepoisDoCommit: true, ate: 1 }]);
    expect(morto.spawnados[0]!.signal).toBe("SIGKILL");
    expect(await mundo.saldo(carteira.walletId)).toBe("90.00");

    // Reinicia e drena: 3 novas + a reentrega da que ja foi aplicada.
    const reiniciado = await corrida<Evento>(CONSOME, [{ ate: 4, limiteMs: 40_000 }]);
    expect(falhasDeProcesso(reiniciado.spawnados)).toEqual([]);

    // Quatro mensagens, quatro efeitos — nunca cinco.
    expect(await mundo.saldo(carteira.walletId)).toBe("60.00");
    const debitos = (await mundo.lancamentos(carteira.walletId)).filter(
      (l) => l.direction === "DEBIT",
    );
    expect(debitos).toHaveLength(4);
    expect(await mundo.contaInbox()).toBe(inboxAntes + 4);
    expect((await mundo.contaPorStatus(carteira.walletId))["PROCESSED"]).toBe(5);
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 120_000);
});

describe("dois publishers na mesma outbox", () => {
  it("cada evento sai uma unica vez", async () => {
    // As aberturas de carteira enfileiram dois eventos cada.
    await Promise.all([
      mundo.carteira("100.00"),
      mundo.carteira("200.00"),
      mundo.carteira("300.00"),
      mundo.carteira("400.00"),
    ]);
    await drenaEventos();

    const antes = await mundo.outbox();
    expect(antes.pendentes).toBeGreaterThanOrEqual(8);

    // Dois processos competindo pelas mesmas linhas, largando juntos.
    const { desfechos, spawnados } = await corrida<Evento>(PUBLICA, [
      { ciclos: 4 },
      { ciclos: 4 },
    ]);

    expect(falhasDeProcesso(spawnados)).toEqual([]);
    const total = desfechos.reduce((soma, d) => soma + (d.publicados ?? 0), 0);
    // A soma dos dois publishers e exatamente o que havia pendente: se os dois
    // tivessem reivindicado a mesma linha, passaria disso.
    expect(total).toBe(antes.pendentes);
    expect(new Set(desfechos.map((d) => d.pid)).size).toBe(2);

    const depois = await mundo.outbox();
    expect(depois.pendentes).toBe(0);
    expect(depois.abandonados).toBe(0);
    expect(depois.publicados).toBe(antes.publicados + antes.pendentes);

    // Na fila: um evento por linha, sem eventId repetido. A contagem esperada
    // entra no dreno: um `receive` vazio nao prova fila vazia.
    const eventos = await drenaEventos({ esperando: antes.pendentes });
    expect(eventos).toHaveLength(antes.pendentes);
    expect(new Set(eventos.map((e) => e.eventId)).size).toBe(antes.pendentes);
  }, 120_000);
});
