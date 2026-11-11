import { cpus, totalmem } from "node:os";

export interface Ambiente {
  readonly cpu: string;
  readonly nucleos: number;
  readonly memoriaGb: number;
  readonly bun: string;
  readonly plataforma: string;
  readonly docker: string;
  readonly postgres: string;
  readonly localstack: string;
  readonly commit: string;
  readonly instanciasApi: number;
  readonly instanciasPublisher: number;
  readonly medidoEm: string;
}

async function comando(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    // Os dois fluxos são drenados: deixar o stderr num pipe cheio travaria o
    // processo filho esperando alguém ler.
    const [texto, _erro, codigo] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);

    // Sem conferir o código, um `docker inspect` que falha gravava string
    // vazia e o bloco de ambiente saía incompleto sem avisar.
    if (codigo !== 0) return "indisponivel";
    const limpo = texto.trim();
    return limpo.length > 0 ? limpo : "indisponivel";
  } catch {
    return "indisponivel";
  }
}

/**
 * Registra o ambiente junto com o resultado.
 *
 * Número de carga sem ambiente não é medida, é anedota: o mesmo código em
 * outra máquina dá outro número, e sem isto ninguém — nem eu, em um mês —
 * consegue dizer se uma regressão é do código ou do hardware.
 */
export async function descreveAmbiente(
  instanciasApi: number,
  instanciasPublisher: number,
): Promise<Ambiente> {
  const nucleos = cpus();
  return {
    cpu: nucleos[0]?.model.trim() ?? "desconhecida",
    nucleos: nucleos.length,
    memoriaGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    bun: Bun.version,
    plataforma: `${process.platform} ${process.arch}`,
    docker: await comando(["docker", "--version"]),
    postgres: await comando([
      "docker",
      "inspect",
      "--format",
      "{{index .Config.Image}}",
      "wagering-postgres-1",
    ]),
    localstack: await comando([
      "docker",
      "inspect",
      "--format",
      "{{index .Config.Image}}",
      "wagering-localstack-1",
    ]),
    commit: await comando(["git", "rev-parse", "--short", "HEAD"]),
    instanciasApi,
    instanciasPublisher,
    medidoEm: new Date().toISOString(),
  };
}
