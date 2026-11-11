import { esperaLargada } from "./barrier";

/**
 * Prefixo da linha de resultado no stdout do filho.
 *
 * Exportado porque o filho que morre por SIGKILL escreve a linha na mao, com
 * `writeSync` — stdout em pipe e bufferizado e o SIGKILL nao descarrega. Se
 * cada lado tivesse a sua copia do literal, um rename quebraria a leitura do
 * unico resultado que aquele filho chega a produzir.
 */
export const PREFIXO = "__resultado__";

export interface Execucao<T> {
  readonly resultado: Promise<Array<Spawnado<T>>>;
  /** Mata o que ainda estiver de pe. */
  encerra(): void;
}

export interface Spawnado<T> {
  readonly exitCode: number | null;
  readonly signal: string | number | null;
  readonly resultados: T[];
  readonly stdout: string;
  readonly stderr: string;
}

export function reporta(valor: unknown): void {
  console.log(PREFIXO + JSON.stringify(valor));
}

/**
 * Sobe N processos Bun de verdade e devolve o que cada um reportou.
 *
 * Processos, e nao `Promise.all` no mesmo processo, porque o enunciado exige
 * correcao com multiplas instancias: um unico event loop compartilha pool de
 * conexao e cache do ORM, e esconderia justamente os erros que aparecem com
 * replicas separadas.
 */
export function rodaEmParalelo<T>(
  script: string,
  tarefas: Array<Record<string, unknown>> | readonly object[],
  opcoes: { barreira?: number; env?: Record<string, string> } = {},
): Execucao<T> {
  const filhos = tarefas.map((tarefa) =>
    Bun.spawn({
      cmd: ["bun", "run", script],
      env: {
        ...process.env,
        ...opcoes.env,
        TAREFA: JSON.stringify(tarefa),
        ...(opcoes.barreira === undefined ? {} : { BARREIRA_PORT: String(opcoes.barreira) }),
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );

  const resultado = Promise.all(
    filhos.map(async (filho) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(filho.stdout).text(),
        new Response(filho.stderr).text(),
        filho.exited,
      ]);

      return {
        exitCode,
        signal: filho.signalCode,
        resultados: stdout
          .split("\n")
          .filter((linha) => linha.startsWith(PREFIXO))
          .map((linha) => JSON.parse(linha.slice(PREFIXO.length)) as T),
        stdout,
        stderr,
      };
    }),
  );

  return {
    resultado,
    // Usado quando a largada nao aconteceu: filho bloqueado na barreira nunca
    // termina sozinho, e orfao segurando conexao do Postgres trava o
    // `drop schema` do proximo arquivo de teste.
    encerra: () => {
      for (const filho of filhos) filho.kill("SIGKILL");
    },
  };
}

/** Lado do filho: tarefa recebida por env, tipada pelo chamador. */
export function tarefaDoFilho<T>(): T {
  const cru = process.env["TAREFA"];
  if (cru === undefined) throw new Error("filho sem TAREFA");
  return JSON.parse(cru) as T;
}

/** Lado do filho: bloqueia na largada, quando o teste pediu barreira. */
export async function alinha(): Promise<void> {
  const port = process.env["BARREIRA_PORT"];
  if (port !== undefined) await esperaLargada(Number(port));
}
