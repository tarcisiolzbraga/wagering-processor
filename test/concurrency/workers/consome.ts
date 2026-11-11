import { writeSync } from "node:fs";

import { MESSAGE_QUEUE, type MessageQueue } from "../../../src/application/ports/message-queue";
import { LOGGER, type Logger } from "../../../src/application/ports/logger";
import { METRICS, type Metrics } from "../../../src/application/ports/metrics";
import {
  DEFAULT_CONSUMER_OPTIONS,
  WagerTransactionConsumer,
} from "../../../src/application/wagering/consume-wager-transactions";
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionResult,
  type SubmitWagerTransactionCommand,
} from "../../../src/application/wagering/submit-wager-transaction";
import { abreContexto } from "../support/contexto";
import { alinha, PREFIXO, reporta, tarefaDoFilho } from "../support/processos";

interface Tarefa {
  /**
   * Mata o processo **depois do commit e antes do ack**, com SIGKILL.
   *
   * SIGKILL, e nao excecao: excecao roda handlers de cleanup, e o cenario que
   * interessa e o em que nada e limpo — nem o ack, nem a devolucao da
   * visibilidade, nem o fechamento da conexao.
   */
  readonly mataDepoisDoCommit?: boolean;
  /** Para depois de processar esta quantidade de mensagens. */
  readonly ate?: number;
  /** Teto de tempo, para o processo nao ficar vivo se a fila estiver vazia. */
  readonly limiteMs?: number;
}

async function main(): Promise<void> {
  const tarefa = tarefaDoFilho<Tarefa>();
  const app = await abreContexto();

  const submit = app.get(SubmitWagerTransaction);
  const fila = app.get<MessageQueue>(MESSAGE_QUEUE);
  const logger = app.get<Logger>(LOGGER);
  const metrics = app.get<Metrics>(METRICS);

  let processadas = 0;
  const original = submit.run.bind(submit);

  // A decoracao fica **no harness**, nao em codigo de producao: um hook de
  // crash atras de env em `SubmitWagerTransaction` seria caminho de falha
  // morando no caminho do dinheiro.
  submit.run = async (
    comando: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> => {
    const resultado = await original(comando);
    processadas += 1;

    if (tarefa.mataDepoisDoCommit === true) {
      // writeSync: o stdout em pipe e bufferizado e o SIGKILL nao descarrega.
      writeSync(
        1,
        `${PREFIXO}${JSON.stringify({
          pid: process.pid,
          evento: "commitado",
          outcome: resultado.outcome,
          transactionId: resultado.transactionId,
        })}\n`,
      );
      process.kill(process.pid, "SIGKILL");
    }

    return resultado;
  };

  const consumer = new WagerTransactionConsumer(fila, submit, logger, metrics, {
    ...DEFAULT_CONSUMER_OPTIONS,
    // Espera curta: o teste nao pode herdar os 20s de long polling da producao.
    waitSeconds: 1,
  });

  await alinha();

  const rodando = consumer.start();
  const limite = tarefa.limiteMs ?? 15_000;
  const inicio = Date.now();

  while (processadas < (tarefa.ate ?? 1) && Date.now() - inicio < limite) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await consumer.stop();
  await rodando;

  reporta({ pid: process.pid, evento: "encerrado", processadas });
  await app.close();
  process.exit(0);
}

main().catch((erro: unknown) => {
  console.error(erro);
  process.exit(1);
});
