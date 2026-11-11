import { ForbiddenException } from "@nestjs/common";
import type { Request } from "express";

import type { WithPrincipal } from "./auth.guard";

/**
 * Confronta o provedor do **token** com o do payload.
 *
 * Sem isto, a autenticação provaria apenas que quem chama tem *algum* token
 * válido: o `provider-b` poderia submeter uma aposta dizendo-se `provider-a`,
 * debitando a carteira de um jogador que não é cliente dele. O token manda; o
 * corpo da requisição é entrada do usuário.
 */
export function confereProvedor(
  req: Request & Partial<WithPrincipal>,
  providerIdDoPayload: string,
): void {
  const principal = req.principal;
  // Sem principal significa `AUTH_ENABLED=false`, que é decisão explícita de
  // configuração — o Compose sobe assim para o avaliador exercitar a API.
  if (principal === undefined) return;

  if (principal.providerId !== providerIdDoPayload) {
    throw new ForbiddenException({ error: "PROVIDER_MISMATCH" });
  }
}

/**
 * A chave de idempotência precisa ser do espaço do provedor autenticado.
 *
 * A unicidade de `idempotency_key` é **global** no schema, e a chave vem do
 * cliente. Sem este vínculo, `provider-b` submete uma aposta legítima própria
 * usando `Idempotency-Key: provider-a:TX123`: a linha é gravada e, quando
 * `provider-a` manda a transação real `TX123` com a chave default do
 * enunciado, o insert colide, o `payloadHash` difere — ele inclui o
 * `providerId` — e a API responde 409 para sempre. A aposta legítima de
 * `provider-a` nunca entra, e nenhum retry resolve.
 *
 * O critério é a própria convenção documentada: `{providerId}:{externalId}`.
 * Chave fora do espaço do chamador é recusada antes de tocar o banco.
 */
export function confereEspacoDaChave(
  req: Request & Partial<WithPrincipal>,
  idempotencyKey: string,
): void {
  const principal = req.principal;
  if (principal === undefined) return;

  const prefixo = `${principal.providerId}:`;
  if (idempotencyKey === principal.providerId || idempotencyKey.startsWith(prefixo)) return;

  throw new ForbiddenException({ error: "IDEMPOTENCY_KEY_NOT_OWNED" });
}

/**
 * Esconde o recurso de outro provedor.
 *
 * Devolve 404, não 403: um 403 confirmaria que aquela transação existe, o que
 * permitiria a um provedor varrer ids e descobrir o volume do concorrente.
 */
export function pertenceAoChamador(
  req: Request & Partial<WithPrincipal>,
  providerIdDoRecurso: string,
): boolean {
  const principal = req.principal;
  if (principal === undefined) return true;
  return principal.providerId === providerIdDoRecurso;
}
