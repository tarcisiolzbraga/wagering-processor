import { descreveAmbiente, type Ambiente } from "./ambiente";
import { arredonda, resumeLatencias, type Latencias, type Ponto } from "./medidas";
import { contadores, delta, gauge, raspa, type Contadores } from "./metricas";

/**
 * Teste de carga contra o stack do Compose.
 *
 * Não existe meta de RPS. O objetivo é mostrar **onde o sistema dobra** e com
 * que forma: três perfis, porque um único número agregado esconde exatamente o
 * que importa num processador de apostas — a diferença entre carga espalhada e
 * disputa pela mesma carteira.
 *
 * Roda contra as três instâncias de API alternadamente, sem balanceador: a
 * correção com múltiplas instâncias é requisito, então medir uma só mediria
 * outro sistema.
 */

const API = (process.env["LOAD_API_URLS"] ?? "http://127.0.0.1:3001,http://127.0.0.1:3002,http://127.0.0.1:3003")
  .split(",")
  .map((u) => u.trim())
  .filter((u) => u.length > 0);

const PUBLISHERS = (process.env["LOAD_PUBLISHER_URLS"] ?? "http://127.0.0.1:3012,http://127.0.0.1:3013")
  .split(",")
  .map((u) => u.trim())
  .filter((u) => u.length > 0);

/**
 * Número de configuração, validado.
 *
 * `LOAD_CONCURRENCY=32x` virava `NaN`: zero trabalhadores, laço de aquecimento
 * girando a vazio e um relatório inteiro de zeros, sem um erro sequer.
 */
function inteiroPositivo(nome: string, padrao: number): number {
  const cru = process.env[nome];
  if (cru === undefined || cru.trim().length === 0) return padrao;

  const valor = Number(cru);
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new Error(`${nome} precisa ser inteiro positivo; recebi ${JSON.stringify(cru)}`);
  }
  return valor;
}

const CONCORRENCIA = inteiroPositivo("LOAD_CONCURRENCY", 32);
const SEGUNDOS = inteiroPositivo("LOAD_DURATION_SECONDS", 15);
const AQUECIMENTO_SEGUNDOS = inteiroPositivo("LOAD_WARMUP_SECONDS", 3);
/** Valor pequeno de propósito: saldo não pode virar o gargalo do teste. */
const VALOR = "0.01";
const SALDO_INICIAL = "900000.00";

type Classe = "aplicada" | "replay" | "negocio" | "cliente" | "infra";

interface Resultado {
  readonly classe: Classe;
  readonly ms: number;
  readonly status: number;
}

interface Perfil {
  readonly nome: string;
  readonly descricao: string;
  readonly mede: string;
}

interface Invariante {
  readonly carteirasConferidas: number;
  readonly consistentes: number;
}

interface RelatorioDePerfil extends Perfil {
  readonly duracaoSegundos: number;
  readonly concorrencia: number;
  readonly operacoes: number;
  readonly throughputPorSegundo: number;
  readonly latenciaMs: Latencias;
  readonly porClasse: Record<Classe, number>;
  readonly taxaDeErroInfra: number;
  readonly metricas: Contadores;
  readonly outboxLagSegundos: { readonly media: number; readonly pico: number; readonly serie: Ponto[] };
  readonly invariante: Invariante;
}

let proxima = 0;
const instancia = (): string => {
  const url = API[proxima % API.length] ?? API[0] ?? "";
  proxima += 1;
  return url;
};

const uuid = (): string => crypto.randomUUID();
const agora = (): number => performance.now();
const espera = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function abreCarteira(): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuid();
  const resposta = await fetch(`${instancia()}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: SALDO_INICIAL, currency: "BRL" } }),
  });

  if (!resposta.ok) {
    throw new Error(`abertura de carteira falhou: ${resposta.status} ${await resposta.text()}`);
  }
  return { walletId: ((await resposta.json()) as { id: string }).id, playerId };
}

interface Aposta {
  readonly walletId: string;
  readonly playerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
}

function corpoDeAposta(aposta: Aposta): string {
  return JSON.stringify({
    providerId: "provider-a",
    externalTransactionId: aposta.externalTransactionId,
    playerId: aposta.playerId,
    walletId: aposta.walletId,
    roundId: `round-${aposta.externalTransactionId}`,
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: VALOR, currency: "BRL" },
  });
}

/**
 * Classifica o desfecho.
 *
 * Recusa de negócio **não** é erro: `INSUFFICIENT_FUNDS` é operação normal, e
 * contá-la como falha inflaria a taxa de erro com o funcionamento correto do
 * sistema. Erro é 5xx e queda de conexão — o que o provedor não consegue
 * resolver mudando o payload.
 */
async function submete(aposta: Aposta): Promise<Resultado> {
  const inicio = agora();
  try {
    const resposta = await fetch(`${instancia()}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": aposta.idempotencyKey,
      },
      body: corpoDeAposta(aposta),
    });

    const corpo = (await resposta.json().catch(() => ({}))) as { idempotentReplay?: boolean };
    const ms = agora() - inicio;

    if (resposta.status >= 500) return { classe: "infra", ms, status: resposta.status };
    if (resposta.status === 422) return { classe: "negocio", ms, status: resposta.status };
    if (resposta.status >= 400) return { classe: "cliente", ms, status: resposta.status };
    return {
      classe: corpo.idempotentReplay === true ? "replay" : "aplicada",
      ms,
      status: resposta.status,
    };
  } catch {
    // Conexão recusada ou derrubada no meio: do ponto de vista do provedor é
    // indistinguível de 503, então entra na mesma classe.
    return { classe: "infra", ms: agora() - inicio, status: 0 };
  }
}

/** Amostra o atraso da outbox a cada segundo, para o gráfico no tempo. */
let falhaDaObservacao: string | undefined;

function observaOutbox(serie: Ponto[], inicio: number): () => void {
  let vivo = true;

  const laco = async (): Promise<void> => {
    while (vivo) {
      try {
        const textos = await Promise.all(PUBLISHERS.map(raspa));
        serie.push({
          segundo: arredonda((agora() - inicio) / 1000),
          valor: arredonda(gauge(textos, "wager_outbox_lag_seconds")),
        });
      } catch (erro: unknown) {
        // Publisher inalcançável no meio da medição invalida a série: melhor
        // interromper o relatório que publicar atraso zero.
        falhaDaObservacao = erro instanceof Error ? erro.message : String(erro);
        vivo = false;
      }
      await espera(1000);
    }
  };

  void laco();
  return () => {
    vivo = false;
  };
}

/**
 * Laço fechado: `CONCORRENCIA` trabalhadores, cada um submetendo em sequência.
 *
 * Fechado e não aberto (taxa fixa) de propósito: carga aberta num sistema que
 * serializa por carteira formaria fila ilimitada e mediria a fila, não o
 * sistema. Com laço fechado, a contenção aparece como latência — que é onde
 * ela precisa aparecer.
 */
/**
 * Confere, pela reconciliação real, que o saldo fecha com o ledger.
 *
 * É a mesma invariante que fecha todo teste do projeto. Sem ela, "zero erros"
 * significaria apenas que ninguém recebeu 5xx — e perda de dinheiro sob carga
 * não devolve 5xx, devolve 200 com o saldo errado.
 */
async function confereInvariante(walletIds: readonly string[]): Promise<Invariante> {
  let consistentes = 0;

  for (const walletId of walletIds) {
    const resposta = await fetch(`${instancia()}/wallets/${walletId}/reconciliation`, {
      method: "POST",
    });
    if (!resposta.ok) {
      throw new Error(`reconciliação de ${walletId} respondeu ${String(resposta.status)}`);
    }

    const corpo = (await resposta.json()) as { consistent?: boolean };
    if (corpo.consistent !== true) {
      throw new Error(`saldo divergiu do ledger em ${walletId}`);
    }
    consistentes += 1;
  }

  return { carteirasConferidas: walletIds.length, consistentes };
}

/**
 * Espera o publisher zerar a fila antes do próximo perfil.
 *
 * Sem isto, o atraso medido num perfil é em boa parte herdado do anterior, e o
 * número deixa de significar algo sobre o perfil que o reporta.
 */
async function aguardaOutboxEmDia(limiteMs = 60_000): Promise<number> {
  const limite = Date.now() + limiteMs;

  while (Date.now() < limite) {
    const lag = gauge(await Promise.all(PUBLISHERS.map(raspa)), "wager_outbox_lag_seconds");
    if (lag < 1) return arredonda(lag);
    await espera(1000);
  }

  return gauge(await Promise.all(PUBLISHERS.map(raspa)), "wager_outbox_lag_seconds");
}

async function roda(
  perfil: Perfil,
  proximaAposta: () => Aposta,
  carteirasUsadas: readonly string[],
): Promise<RelatorioDePerfil> {
  const antesDoAquecimento = agora();
  while (agora() - antesDoAquecimento < AQUECIMENTO_SEGUNDOS * 1000) {
    await Promise.all(Array.from({ length: CONCORRENCIA }, () => submete(proximaAposta())));
  }

  const metricasAntes = await contadores([...API, ...PUBLISHERS]);
  const resultados: Resultado[] = [];
  const serie: Ponto[] = [];
  const inicio = agora();
  const paraDeObservar = observaOutbox(serie, inicio);

  const trabalhador = async (): Promise<void> => {
    while (agora() - inicio < SEGUNDOS * 1000) {
      resultados.push(await submete(proximaAposta()));
    }
  };

  await Promise.all(Array.from({ length: CONCORRENCIA }, trabalhador));
  const duracao = (agora() - inicio) / 1000;

  // A observação continua durante a carência: o publisher trabalha em ciclos,
  // então o pico aparece depois da última requisição. Parar de observar antes
  // da espera — como estava — fazia o pico reportado ser sempre um piso.
  await espera(2500);
  paraDeObservar();
  if (falhaDaObservacao !== undefined) {
    throw new Error(`observação da outbox falhou: ${falhaDaObservacao}`);
  }

  const metricasDepois = await contadores([...API, ...PUBLISHERS]);

  const porClasse: Record<Classe, number> = {
    aplicada: 0,
    replay: 0,
    negocio: 0,
    cliente: 0,
    infra: 0,
  };
  for (const r of resultados) porClasse[r.classe] += 1;

  const lags = serie.map((p) => p.valor);

  return {
    ...perfil,
    duracaoSegundos: arredonda(duracao),
    concorrencia: CONCORRENCIA,
    operacoes: resultados.length,
    throughputPorSegundo: arredonda(resultados.length / duracao),
    latenciaMs: resumeLatencias(resultados.map((r) => r.ms)),
    porClasse,
    taxaDeErroInfra: arredonda((porClasse.infra / Math.max(1, resultados.length)) * 100),
    metricas: delta(metricasDepois, metricasAntes),
    outboxLagSegundos: {
      media: arredonda(lags.length === 0 ? 0 : lags.reduce((a, b) => a + b, 0) / lags.length),
      pico: arredonda(Math.max(0, ...lags)),
      serie,
    },
    invariante: await confereInvariante(carteirasUsadas),
  };
}

async function carteirasDistintas(): Promise<RelatorioDePerfil> {
  // Uma carteira por trabalhador: nenhuma disputa, então o que sai é o teto.
  const carteiras = await Promise.all(
    Array.from({ length: CONCORRENCIA }, () => abreCarteira()),
  );
  let i = 0;

  return roda(
    {
      nome: "carteiras-distintas",
      descricao: `${String(CONCORRENCIA)} carteiras, uma por trabalhador`,
      mede: "throughput de pico sem contenção — o teto do sistema",
    },
    () => {
      const carteira = carteiras[i % carteiras.length]!;
      i += 1;
      const externalTransactionId = `load-${uuid()}`;
      return {
        ...carteira,
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
      };
    },
    carteiras.map((c) => c.walletId),
  );
}

async function carteiraQuente(): Promise<RelatorioDePerfil> {
  // Todos na mesma carteira: é o caso real de iGaming, e é aqui que o lock
  // pessimista serializa e o p99 degrada.
  const carteira = await abreCarteira();

  return roda(
    {
      nome: "carteira-quente",
      descricao: `uma carteira, ${String(CONCORRENCIA)} trabalhadores`,
      mede: "contenção no lock da carteira",
    },
    () => {
      const externalTransactionId = `load-${uuid()}`;
      return {
        ...carteira,
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
      };
    },
    [carteira.walletId],
  );
}

async function replay(): Promise<RelatorioDePerfil> {
  // Mesma chave e mesmo payload em todas as submissões: mede o caminho de
  // dedup, que precisa ser mais barato que o de escrita.
  const carteira = await abreCarteira();
  const externalTransactionId = `load-replay-${uuid()}`;
  const aposta: Aposta = {
    ...carteira,
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
  };

  const primeira = await submete(aposta);
  if (primeira.classe !== "aplicada") {
    throw new Error(`a primeira submissão do perfil replay não aplicou: ${primeira.status}`);
  }

  return roda(
    {
      nome: "replay",
      descricao: "mesma chave de idempotência, repetida",
      mede: "custo do caminho de deduplicação",
    },
    () => aposta,
    [carteira.walletId],
  );
}

/**
 * Saldo escasso de propósito: quase toda aposta é recusada.
 *
 * Mede o caminho de rejeição, que também é escrita — a transação `REJECTED` é
 * persistida —, e é o único perfil que produz composição de erro por classe.
 * Sem ele o relatório teria uma barra de zero, que não informa se a recusa é
 * barata ou cara.
 */
async function saldoEscasso(): Promise<RelatorioDePerfil> {
  const playerId = uuid();
  const resposta = await fetch(`${instancia()}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: "0.05", currency: "BRL" } }),
  });

  // Sem esta checagem, uma abertura que falha dava `walletId: undefined` e o
  // perfil media 400 do próprio teste reportando 0% de erro de infra.
  if (!resposta.ok) {
    throw new Error(`abertura da carteira escassa falhou: ${resposta.status} ${await resposta.text()}`);
  }

  const carteira = {
    walletId: ((await resposta.json()) as { id: string }).id,
    playerId,
  };

  return roda(
    {
      nome: "saldo-escasso",
      descricao: "uma carteira sem saldo para a maioria das apostas",
      mede: "custo do caminho de recusa por saldo insuficiente",
    },
    () => {
      const externalTransactionId = `load-${uuid()}`;
      return {
        ...carteira,
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
      };
    },
    [carteira.walletId],
  );
}

interface Relatorio {
  readonly ambiente: Ambiente;
  readonly metodologia: Record<string, string | number>;
  readonly perfis: RelatorioDePerfil[];
}

async function confereStack(): Promise<void> {
  const problemas: string[] = [];

  for (const url of API) {
    // `/health/ready`, não `/health/live`: liveness só diz que o processo
    // responde. O que precisa valer antes de medir é que Postgres e SQS estão
    // alcançáveis — senão o relatório mede a indisponibilidade deles.
    try {
      const resposta = await fetch(`${url}/health/ready`);
      if (!resposta.ok) problemas.push(`${url} readiness respondeu ${String(resposta.status)}`);
    } catch {
      problemas.push(`${url} inalcançável`);
    }
  }

  for (const url of PUBLISHERS) {
    try {
      await raspa(url);
    } catch (erro: unknown) {
      problemas.push(erro instanceof Error ? erro.message : `${url} inalcançável`);
    }
  }

  if (problemas.length > 0) {
    throw new Error(
      `stack não está de pé:\n  ${problemas.join("\n  ")}\n` +
        "Suba com `bun run compose:up` antes de medir.",
    );
  }
}

function imprime(relatorio: Relatorio): void {
  const { ambiente } = relatorio;
  console.log("\n=== ambiente ===");
  console.log(`${ambiente.cpu} · ${String(ambiente.nucleos)} núcleos · ${String(ambiente.memoriaGb)} GB`);
  console.log(`bun ${ambiente.bun} · ${ambiente.docker}`);
  console.log(`${ambiente.postgres} · ${ambiente.localstack} · commit ${ambiente.commit}`);
  console.log(
    `${String(ambiente.instanciasApi)} instâncias de API · ${String(ambiente.instanciasPublisher)} publishers`,
  );

  console.log("\n=== resultado ===");
  const linhas = relatorio.perfis.map((p) => ({
    perfil: p.nome,
    "ops/s": p.throughputPorSegundo,
    "p50 ms": p.latenciaMs.p50,
    "p95 ms": p.latenciaMs.p95,
    "p99 ms": p.latenciaMs.p99,
    aplicadas: p.porClasse.aplicada,
    replays: p.porClasse.replay,
    negócio: p.porClasse.negocio,
    // 4xx no relatório: sem esta coluna, uma execução inteira de requisição
    // malformada imprimia como saudável.
    cliente: p.porClasse.cliente,
    "erro infra %": p.taxaDeErroInfra,
    "conflitos lock": p.metricas.conflitosDeLock,
    "outbox lag pico s": p.outboxLagSegundos.pico,
    "saldo == ledger": `${String(p.invariante.consistentes)}/${String(p.invariante.carteirasConferidas)}`,
  }));
  console.table(linhas);
}

async function main(): Promise<void> {
  await confereStack();

  const relatorio: Relatorio = {
    ambiente: await descreveAmbiente(API.length, PUBLISHERS.length),
    metodologia: {
      laco: "fechado",
      concorrencia: CONCORRENCIA,
      duracaoSegundosPorPerfil: SEGUNDOS,
      aquecimentoSegundos: AQUECIMENTO_SEGUNDOS,
      valorPorAposta: VALOR,
      saldoInicial: SALDO_INICIAL,
      instanciasAlternadas: API.join(","),
    },
    perfis: [],
  };

  // Entre perfis, espera a outbox zerar: o atraso reportado por um perfil tem
  // que ser o que **ele** gerou, não backlog herdado do anterior.
  const perfis: RelatorioDePerfil[] = [];
  for (const executa of [carteirasDistintas, carteiraQuente, replay, saldoEscasso]) {
    const lagInicial = await aguardaOutboxEmDia();
    if (lagInicial >= 1) {
      console.warn(
        `aviso: a outbox ainda tinha ${String(lagInicial)}s de atraso ao iniciar ${executa.name}`,
      );
    }
    perfis.push(await executa());
  }

  const completo: Relatorio = { ...relatorio, perfis };
  const destino = `test/load/resultados/${completo.ambiente.medidoEm.replace(/[:.]/g, "-")}.json`;
  await Bun.write(destino, `${JSON.stringify(completo, null, 2)}\n`);
  await Bun.write("test/load/resultados/ultimo.json", `${JSON.stringify(completo, null, 2)}\n`);

  imprime(completo);
  console.log(`\nrelatório salvo em ${destino}`);
}

main().catch((erro: unknown) => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
