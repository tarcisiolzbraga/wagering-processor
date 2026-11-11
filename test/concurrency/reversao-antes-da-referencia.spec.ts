import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { FailureCode } from "../../src/domain/shared/failure-code";
import { SubmitOutcome } from "../../src/application/wagering/submit-wager-transaction";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction-kind";
import { corrida, falhasDeProcesso } from "./support/corrida";
import { aposta, Mundo } from "./support/mundo";

const SUBMETE = "test/concurrency/workers/submete.ts";
const REFERENCIA = "test/concurrency/workers/referencia.ts";

interface Ciclo {
  readonly pid: number;
  readonly resolvidas: number;
  readonly recusadas: number;
  readonly adiadas: number;
}

let mundo: Mundo;

beforeAll(async () => {
  mundo = await Mundo.abre();
});

afterAll(async () => {
  await mundo.fecha();
});

describe("reversao chegando junto com a referencia", () => {
  it("rollback e a bet ao mesmo tempo: o saldo volta ao inicial", async () => {
    const carteira = await mundo.carteira("100.00");
    const betExternalId = `bet-${crypto.randomUUID()}`;
    // Mesma rodada nos dois: a referencia precisa pertencer ao mesmo provider,
    // player, carteira, moeda **e rodada**.
    const roundId = `round-${crypto.randomUUID()}`;

    // Os dois processos largam juntos: qual chega primeiro e indeterminado, e
    // o resultado final nao pode depender disso.
    const { desfechos, spawnados } = await corrida(SUBMETE, [
      { comandos: [aposta(carteira, {
          externalTransactionId: betExternalId,
          roundId,
          money: { amount: "40.00", currency: "BRL" },
        })] },
      { comandos: [aposta(carteira, {
          kind: Kind.Rollback,
          referenceExternalTransactionId: betExternalId,
          roundId,
          money: { amount: "40.00", currency: "BRL" },
        })] },
    ]);

    expect(falhasDeProcesso(spawnados)).toEqual([]);
    expect(desfechos.filter((d) => d.outcome === "THREW")).toEqual([]);

    const reversao = desfechos.find((d) => d.transactionId !== undefined && d.status !== "PROCESSED");

    if (reversao !== undefined) {
      // O rollback chegou antes: ficou pendente de referencia, e o worker
      // resolve depois. A espera e real, entao o agendamento e antecipado.
      expect(reversao.outcome).toBe(SubmitOutcome.PendingReference);
      await mundo.venceAgendamentos();
      const ciclo = await corrida<Ciclo>(REFERENCIA, [{ ciclos: 2 }]);
      expect(ciclo.desfechos.reduce((s, c) => s + c.resolvidas, 0)).toBeGreaterThanOrEqual(1);
      expect(await mundo.contaPorStatus(carteira.walletId)).not.toHaveProperty(
        "PENDING_REFERENCE",
      );
    }

    // Qualquer que tenha sido a ordem: debito e credito, saldo de volta.
    expect(await mundo.saldo(carteira.walletId)).toBe("100.00");
    const lancamentos = await mundo.lancamentos(carteira.walletId);
    expect(lancamentos.filter((l) => l.direction === "DEBIT")).toHaveLength(1);
    // O credito da abertura mais o da reversao.
    expect(lancamentos.filter((l) => l.direction === "CREDIT")).toHaveLength(2);
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 120_000);

  it("duas reversoes da mesma bet em paralelo: so uma credita", async () => {
    const carteira = await mundo.carteira("100.00");
    const betExternalId = `bet-${crypto.randomUUID()}`;
    const roundId = `round-${crypto.randomUUID()}`;

    const bet = await corrida(SUBMETE, [
      { comandos: [aposta(carteira, {
          externalTransactionId: betExternalId,
          roundId,
          money: { amount: "30.00", currency: "BRL" },
        })] },
    ]);
    expect(bet.desfechos[0]!.outcome).toBe(SubmitOutcome.Processed);
    expect(await mundo.saldo(carteira.walletId)).toBe("70.00");

    // Um REFUND e um ROLLBACK da mesma BET, largando juntos. O indice unico
    // parcial no banco e que decide: uma referencia nao e revertida duas vezes.
    const { desfechos } = await corrida(SUBMETE, [
      { comandos: [aposta(carteira, {
          kind: Kind.Refund,
          referenceExternalTransactionId: betExternalId,
          roundId,
          money: { amount: "30.00", currency: "BRL" },
        })] },
      { comandos: [aposta(carteira, {
          kind: Kind.Rollback,
          referenceExternalTransactionId: betExternalId,
          roundId,
          money: { amount: "30.00", currency: "BRL" },
        })] },
    ]);

    expect(desfechos.filter((d) => d.outcome === "THREW")).toEqual([]);
    const aplicadas = desfechos.filter((d) => d.outcome === SubmitOutcome.Processed);
    const recusadas = desfechos.filter((d) => d.outcome === SubmitOutcome.Rejected);
    expect(aplicadas).toHaveLength(1);
    expect(recusadas).toHaveLength(1);
    expect(recusadas[0]!.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    // Credita uma vez: 70 + 30. Reverter duas vezes daria 130 numa carteira
    // que so teve 100.
    expect(await mundo.saldo(carteira.walletId)).toBe("100.00");
    const creditos = (await mundo.lancamentos(carteira.walletId)).filter(
      (l) => l.direction === "CREDIT",
    );
    // Abertura + a unica reversao aplicada.
    expect(creditos).toHaveLength(2);
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 120_000);
});

describe("replicas do worker de referencia", () => {
  it("duas replicas no mesmo ciclo nao queimam duas tentativas", async () => {
    const carteira = await mundo.carteira("100.00");
    const ausente = `ausente-${crypto.randomUUID()}`;

    const pendente = await corrida(SUBMETE, [
      { comandos: [aposta(carteira, {
          kind: Kind.Refund,
          referenceExternalTransactionId: ausente,
          money: { amount: "10.00", currency: "BRL" },
        })] },
    ]);
    expect(pendente.desfechos[0]!.outcome).toBe(SubmitOutcome.PendingReference);
    const transactionId = pendente.desfechos[0]!.transactionId!;

    // A submissao ja conta a primeira tentativa, entao a afirmacao e sobre o
    // **delta** do ciclo, nao sobre o valor absoluto.
    const antes = await mundo.tentativasDeReferencia(transactionId);
    await mundo.venceAgendamentos();

    // Duas replicas largando juntas sobre a mesma linha devida.
    const { desfechos, spawnados } = await corrida<Ciclo>(REFERENCIA, [{}, {}]);

    expect(falhasDeProcesso(spawnados)).toEqual([]);
    // Exatamente uma tentativa consumida: a perdedora ve a proxima tentativa
    // no futuro e desiste. Sem isso, N replicas queimariam N tentativas por
    // ciclo e o backoff deixaria de existir — uma reversao legitima seria
    // rejeitada enquanto a referencia ainda podia chegar.
    expect(desfechos.reduce((s, c) => s + c.adiadas, 0)).toBe(1);
    expect(await mundo.tentativasDeReferencia(transactionId)).toBe(antes + 1);
    await mundo.confereInvarianteFinal(carteira.walletId);
  }, 120_000);
});
