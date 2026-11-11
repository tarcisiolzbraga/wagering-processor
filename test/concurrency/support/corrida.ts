import { abreBarreira } from "./barrier";
import { rodaEmParalelo, type Spawnado } from "./processos";

export interface Desfecho {
  readonly pid: number;
  readonly outcome: string;
  readonly status?: string;
  readonly failureCode?: string;
  readonly transactionId?: string;
  readonly idempotentReplay?: boolean;
  readonly walletId?: string;
  readonly erro?: string;
  readonly mensagem?: string;
}

/**
 * Dispara os processos **juntos** e devolve o que cada um reportou.
 *
 * A barreira e o que torna isto uma corrida: sem ela, a diferenca de tempo de
 * inicializacao entre os filhos serializaria as operacoes e o teste passaria
 * com codigo errado.
 */
export async function corrida<T = Desfecho>(
  script: string,
  tarefas: Array<Record<string, unknown>>,
  opcoes: { env?: Record<string, string>; prazoDaBarreiraMs?: number } = {},
): Promise<{ desfechos: T[]; spawnados: Array<Spawnado<T>> }> {
  const barreira = await abreBarreira(tarefas.length);
  const execucao = rodaEmParalelo<T>(script, tarefas, {
    barreira: barreira.port,
    ...(opcoes.env ? { env: opcoes.env } : {}),
  });

  try {
    await barreira.aguardaTodos(opcoes.prazoDaBarreiraMs);
  } catch (erro: unknown) {
    // Libera **antes** de esperar: quem anunciou `pronto` esta bloqueado na
    // largada e nunca terminaria, entao esperar aqui penduraria o teste ate o
    // timeout do runner — justamente o diagnostico que o prazo existe para
    // evitar. Depois de liberar, mata o que ficou de pe: orfao segurando
    // conexao trava o `drop schema` do proximo arquivo.
    barreira.libera();
    const spawnados = await Promise.race([
      execucao.resultado,
      espera(5_000).then(() => {
        execucao.encerra();
        return execucao.resultado;
      }),
    ]).catch(() => []);
    execucao.encerra();
    await barreira.fecha();

    throw new Error(
      `${String(erro)}\n${spawnados.map((s) => s.stderr.slice(0, 800)).join("\n---\n")}`,
    );
  }

  try {
    barreira.libera();
    const spawnados = await execucao.resultado;
    return { desfechos: spawnados.flatMap((s) => s.resultados), spawnados };
  } finally {
    await barreira.fecha();
  }
}

/**
 * Filho que nao terminou bem.
 *
 * Nao basta olhar "reportou alguma coisa": um processo que reporta e **depois**
 * morre — no `close()`, por exemplo — passaria por saudavel, e o teste
 * concluiria que o cenario funcionou. Entao o criterio e saida limpa, e quem
 * mata o filho de proposito simplesmente nao chama esta funcao.
 */
export function falhasDeProcesso<T>(spawnados: Array<Spawnado<T>>): string[] {
  return spawnados
    .filter((s) => s.resultados.length === 0 || s.exitCode !== 0)
    .map((s) => `exit=${String(s.exitCode)} signal=${String(s.signal)} ${s.stderr.slice(0, 600)}`);
}

const espera = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
