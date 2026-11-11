import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from "../../../src/application/wagering/submit-wager-transaction";
import { abreContexto } from "../support/contexto";
import { alinha, reporta, tarefaDoFilho } from "../support/processos";

interface Tarefa {
  readonly comandos: SubmitWagerTransactionCommand[];
  /** Quantas vezes cada comando e submetido, em paralelo dentro do processo. */
  readonly vezes?: number;
}

/**
 * Submete o que a tarefa pedir e reporta cada desfecho.
 *
 * A inicializacao inteira acontece antes da barreira: depois dela sobra apenas
 * a chamada do use case, que e o que precisa disputar.
 */
async function main(): Promise<void> {
  const { comandos, vezes = 1 } = tarefaDoFilho<Tarefa>();
  const app = await abreContexto();
  const submit = app.get(SubmitWagerTransaction);

  await alinha();

  const tentativas = comandos.flatMap((comando) =>
    Array.from({ length: vezes }, () => comando),
  );

  await Promise.all(
    tentativas.map(async (comando) => {
      try {
        const resultado = await submit.run(comando);
        reporta({
          pid: process.pid,
          outcome: resultado.outcome,
          status: resultado.status,
          failureCode: resultado.failureCode,
          transactionId: resultado.transactionId,
          idempotentReplay: resultado.idempotentReplay,
          balance: resultado.balance,
          walletId: comando.walletId,
        });
      } catch (erro: unknown) {
        // Erro cru tambem e resultado: um deadlock ou um 500 vazando para o
        // provedor e falha do desenho, e o teste precisa ver isso em vez de o
        // processo morrer em silencio.
        reporta({
          pid: process.pid,
          outcome: "THREW",
          erro: erro instanceof Error ? erro.constructor.name : typeof erro,
          mensagem: erro instanceof Error ? erro.message : String(erro),
          walletId: comando.walletId,
        });
      }
    }),
  );

  await app.close();

  // Saida explicita, como no encerramento da aplicacao: sockets de keep-alive
  // do cliente SQS e o stream do logger mantem o event loop vivo depois do
  // `close()`, e o parent espera o filho **terminar** para ler o resultado.
  process.exit(0);
}

main().catch((erro: unknown) => {
  // Falha na propria inicializacao: o parent precisa ver o motivo.
  console.error(erro);
  process.exit(1);
});
