import { PendingReferenceWorker } from "../../../src/application/wagering/retry-pending-reference";
import { abreContexto } from "../support/contexto";
import { alinha, reporta, tarefaDoFilho } from "../support/processos";

interface Tarefa {
  readonly ciclos?: number;
}

/**
 * Roda o worker de referencia ausente de um processo separado.
 *
 * Duas replicas ao mesmo tempo e o caso que a releitura sob o lock da carteira
 * resolve: a que chega depois ve a proxima tentativa no futuro e desiste sem
 * queimar tentativa.
 */
async function main(): Promise<void> {
  const { ciclos = 1 } = tarefaDoFilho<Tarefa>();
  const app = await abreContexto();
  const worker = app.get(PendingReferenceWorker);

  await alinha();

  let resolvidas = 0;
  let recusadas = 0;
  let adiadas = 0;

  for (let i = 0; i < ciclos; i += 1) {
    const resumo = await worker.runOnce();
    resolvidas += resumo.resolved;
    recusadas += resumo.rejected;
    adiadas += resumo.deferred;
  }

  reporta({ pid: process.pid, resolvidas, recusadas, adiadas });
  await app.close();
  process.exit(0);
}

main().catch((erro: unknown) => {
  console.error(erro);
  process.exit(1);
});
