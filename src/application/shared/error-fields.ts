import { DomainError } from "../../domain/shared/domain-error";

/**
 * Campos de erro seguros para log.
 *
 * A redação do logger age sobre **campo**, não sobre texto dentro de uma
 * string. E a mensagem de um erro de domínio cita o valor submetido — `Money`
 * lança "escala maior que 2: 25.123". Logar `erro.message` cru devolveria o
 * valor monetário por uma porta que a redação não cobre.
 *
 * Então, para erro de domínio, a mensagem fica fora e a pilha vai sem a
 * primeira linha (que repete a mensagem). O nome da classe e o `failureCode`
 * dizem o que aconteceu, e o detalhe completo já foi para a resposta HTTP, que
 * vai para quem submeteu e não para o agregador de log.
 */
export function errorNameOf(erro: unknown): string {
  return erro instanceof Error ? erro.constructor.name : typeof erro;
}

export function errorMessageForLog(erro: unknown): string | undefined {
  if (erro instanceof DomainError) return undefined;
  return erro instanceof Error ? erro.message : String(erro);
}

export function errorStackForLog(erro: unknown): string | undefined {
  if (!(erro instanceof Error) || erro.stack === undefined) return undefined;
  if (!(erro instanceof DomainError)) return erro.stack;

  const quadros = erro.stack.split("\n").slice(1);
  return quadros.length > 0 ? quadros.join("\n") : undefined;
}
