import { OutboxPublisherWorker } from "../../../src/application/wagering/publish-outbox";
import { abreContexto } from "../support/contexto";
import { alinha, reporta, tarefaDoFilho } from "../support/processos";

interface Tarefa {
  /** Quantas voltas de publicacao, para dois publishers disputarem a mesma outbox. */
  readonly ciclos?: number;
}

/**
 * Publica a outbox de um processo separado.
 *
 * Dois destes ao mesmo tempo e o cenario que o `FOR UPDATE SKIP LOCKED` e o
 * lease existem para resolver: nenhum evento publicado duas vezes, nenhum
 * ficando para tras.
 */
async function main(): Promise<void> {
  const { ciclos = 1 } = tarefaDoFilho<Tarefa>();
  const app = await abreContexto();
  const worker = app.get(OutboxPublisherWorker);

  await alinha();

  let publicados = 0;
  for (let i = 0; i < ciclos; i += 1) {
    publicados += await worker.publishOnce();
  }

  reporta({ pid: process.pid, publicados });
  await app.close();
  process.exit(0);
}

main().catch((erro: unknown) => {
  console.error(erro);
  process.exit(1);
});
