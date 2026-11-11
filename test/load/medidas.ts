/** Resumo de uma amostra de latências, em milissegundos. */
export interface Latencias {
  readonly amostras: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly media: number;
  readonly max: number;
}

/**
 * Percentil por rank mais próximo, sem interpolação.
 *
 * Interpolar inventa um valor que nenhuma requisição teve. Para relatório de
 * latência o que interessa é "95% das requisições ficaram abaixo de X", e X
 * tem que ser uma medida real.
 */
export function percentil(ordenadas: readonly number[], fracao: number): number {
  if (ordenadas.length === 0) return 0;
  const indice = Math.min(
    ordenadas.length - 1,
    Math.max(0, Math.ceil(fracao * ordenadas.length) - 1),
  );
  return ordenadas[indice] ?? 0;
}

export function resumeLatencias(amostras: readonly number[]): Latencias {
  const ordenadas = [...amostras].sort((a, b) => a - b);
  const soma = ordenadas.reduce((acc, v) => acc + v, 0);

  return {
    amostras: ordenadas.length,
    p50: arredonda(percentil(ordenadas, 0.5)),
    p95: arredonda(percentil(ordenadas, 0.95)),
    p99: arredonda(percentil(ordenadas, 0.99)),
    media: arredonda(ordenadas.length === 0 ? 0 : soma / ordenadas.length),
    max: arredonda(ordenadas.at(-1) ?? 0),
  };
}

export const arredonda = (valor: number): number => Math.round(valor * 100) / 100;

/** Série temporal de uma métrica escalar. */
export interface Ponto {
  readonly segundo: number;
  readonly valor: number;
}
