/**
 * Serializacao canonica: chaves ordenadas, sem espaco, campos `undefined`
 * omitidos.
 *
 * Existe num lugar so porque duas partes do sistema dependem da **mesma**
 * ordenacao por motivos diferentes: o `payloadHash` precisa que o mesmo pedido
 * serializado em ordem diferente gere o mesmo hash — senao o provedor trocar de
 * biblioteca HTTP viraria "conflito de idempotencia" —, e o envelope de evento
 * sai ordenado para que dois publicadores produzam bytes identicos para o mesmo
 * evento. Duas implementacoes divergiriam no primeiro ajuste.
 */
export function sortKeys<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => sortKeys(item)) as T;

  const ordenado: Record<string, unknown> = {};
  for (const chave of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[chave];
    if (item !== undefined) ordenado[chave] = sortKeys(item);
  }
  return ordenado as T;
}

/** `JSON.stringify` sobre a forma canonica. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}
