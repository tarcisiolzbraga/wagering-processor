import { connect, createServer, type Server, type Socket } from "node:net";

/**
 * Barreira de largada entre processos.
 *
 * Sem ela a corrida nao acontece: o custo de subir Bun, conectar no Postgres e
 * inicializar o MikroORM varia entre centenas de milissegundos entre os
 * filhos, entao o primeiro processo ja teria commitado antes de o ultimo abrir
 * conexao. O teste passaria com codigo errado — que e exatamente o defeito dos
 * "testes de concorrencia" sequenciais.
 *
 * TCP em 127.0.0.1, e nao `LISTEN/NOTIFY` do Postgres, porque o banco e o
 * objeto do teste: a sincronizacao nao deve compartilhar nada com o que esta
 * sendo medido.
 */
export interface Barreira {
  readonly port: number;
  /**
   * Resolve quando todos anunciaram que estao prontos, ou rejeita no prazo.
   *
   * O prazo existe porque filho que morre na inicializacao nunca anuncia nada:
   * sem ele o teste ficaria pendurado ate o timeout do runner, sem diagnostico.
   */
  aguardaTodos(timeoutMs?: number): Promise<void>;
  /** Libera a largada. */
  libera(): void;
  fecha(): Promise<void>;
}

export async function abreBarreira(participantes: number): Promise<Barreira> {
  const conectados: Socket[] = [];
  let prontos = 0;
  let avisaTodosProntos: (() => void) | undefined;

  const todosProntos = new Promise<void>((resolve) => {
    avisaTodosProntos = resolve;
  });

  const server: Server = createServer((socket) => {
    conectados.push(socket);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (!chunk.toString().includes("pronto")) return;
      prontos += 1;
      if (prontos === participantes) avisaTodosProntos?.();
    });
    // Filho que morre no meio (cenario de crash) nao derruba o parent.
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endereco = server.address();
  if (endereco === null || typeof endereco === "string") {
    throw new Error("barreira sem porta");
  }

  return {
    port: endereco.port,
    aguardaTodos: (timeoutMs = 30_000) =>
      Promise.race([
        todosProntos,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `barreira: ${prontos} de ${participantes} processos prontos em ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          ).unref(),
        ),
      ]),
    libera: () => {
      for (const socket of conectados) socket.write("larga\n");
    },
    fecha: () =>
      new Promise<void>((resolve) => {
        for (const socket of conectados) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Lado do filho: anuncia que esta pronto e bloqueia ate a largada.
 *
 * Chamado **depois** de toda inicializacao caba — conexao de banco aberta,
 * comando montado — para que o unico trabalho restante seja a operacao em
 * disputa.
 */
export function esperaLargada(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.setNoDelay(true);
      socket.write("pronto\n");
    });
    socket.on("data", (chunk) => {
      if (chunk.toString().includes("larga")) resolve();
    });
    socket.on("error", reject);
  });
}
