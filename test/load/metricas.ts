/** Leitura de uma série do endpoint `/metrics`. */
export type Amostra = Record<string, number>;

/**
 * Soma uma série do texto do Prometheus, contando apenas as labels pedidas.
 *
 * O relatório precisa de delta entre dois instantes, e não do valor absoluto:
 * o contador acumula desde o boot do processo, então o número cru incluiria o
 * tráfego do warm-up e de qualquer teste anterior.
 */
export function soma(texto: string, serie: string, labels: Record<string, string> = {}): number {
  const esperadas = Object.entries(labels);
  let total = 0;

  for (const linha of texto.split("\n")) {
    if (!linha.startsWith(serie)) continue;

    // Série pode vir com ou sem chaves de label. Exigir `{` fazia toda série
    // sem label ler zero — o gauge da outbox só funcionava por acidente, por
    // causa do label default `role`.
    const resto = linha.slice(serie.length);
    if (!resto.startsWith("{") && !resto.startsWith(" ")) continue;
    if (!esperadas.every(([k, v]) => linha.includes(`${k}="${v}"`))) continue;

    const valor = Number(linha.slice(linha.lastIndexOf(" ") + 1));
    if (Number.isFinite(valor)) total += valor;
  }

  return total;
}

/**
 * Maior valor do gauge entre as instâncias raspadas.
 *
 * Máximo, não soma: o atraso da outbox é a idade da pendência mais antiga, e
 * ela é a mesma fila para todos os publishers. Somar daria o dobro com dois
 * publishers de pé.
 */
export function gauge(textos: readonly string[], serie: string): number {
  return Math.max(0, ...textos.map((t) => soma(t, serie)));
}

/**
 * Raspagem que **falha alto**.
 *
 * Devolver `""` quando a instância não responde era pior que inútil: a leitura
 * de base perdida fazia o delta somar o contador inteiro daquele processo
 * desde o boot, e um publisher inalcançável reportava atraso zero — o relatório
 * ficava otimista exatamente quando algo estava errado.
 */
export async function raspa(url: string): Promise<string> {
  const resposta = await fetch(`${url}/metrics`);
  if (!resposta.ok) {
    throw new Error(`/metrics de ${url} respondeu ${String(resposta.status)}`);
  }
  return resposta.text();
}

export interface Contadores {
  readonly processadas: number;
  readonly recusadas: number;
  readonly erros: number;
  readonly invalidas: number;
  readonly duplicatas: number;
  readonly conflitosDeLock: number;
  readonly retries: number;
}

/** Lê os contadores do conjunto de instâncias, somando todas. */
export async function contadores(urls: readonly string[]): Promise<Contadores> {
  const textos = await Promise.all(urls.map(raspa));
  const total = (serie: string, labels?: Record<string, string>): number =>
    textos.reduce((acc, t) => acc + soma(t, serie, labels), 0);

  return {
    processadas: total("wager_transactions_total", { outcome: "PROCESSED" }),
    recusadas: total("wager_transactions_total", { outcome: "REJECTED" }),
    erros: total("wager_transactions_total", { outcome: "ERROR" }),
    invalidas: total("wager_transactions_total", { outcome: "INVALID" }),
    duplicatas: total("wager_duplicates_total"),
    conflitosDeLock: total("wager_lock_conflicts_total"),
    retries: total("wager_retries_total"),
  };
}

export function delta(depois: Contadores, antes: Contadores): Contadores {
  return {
    processadas: depois.processadas - antes.processadas,
    recusadas: depois.recusadas - antes.recusadas,
    erros: depois.erros - antes.erros,
    invalidas: depois.invalidas - antes.invalidas,
    duplicatas: depois.duplicatas - antes.duplicatas,
    conflitosDeLock: depois.conflitosDeLock - antes.conflitosDeLock,
    retries: depois.retries - antes.retries,
  };
}
