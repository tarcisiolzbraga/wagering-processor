import { InvalidInputError } from "./domain-error";

/**
 * Identificadores sao chave de unicidade no banco. "provider-a:tx-9" e
 * "provider-a:tx-9 " seriam duas linhas distintas sob UNIQUE (idempotency_key),
 * ou seja, um debito duplicado sem concorrencia nenhuma envolvida.
 *
 * Por isso o espaco em volta e **recusado**, nao aparado: aparar alteraria em
 * silencio o dado que o provedor enviou.
 */
export function assertIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInputError(`campo obrigatorio ausente ou vazio: ${name}`);
  }
  if (value !== value.trim()) {
    throw new InvalidInputError(
      `campo ${name} tem espaco em volta: ${JSON.stringify(value)}`,
    );
  }
  if (value.trim().length === 0) {
    throw new InvalidInputError(`campo obrigatorio ausente ou vazio: ${name}`);
  }
  return value;
}
