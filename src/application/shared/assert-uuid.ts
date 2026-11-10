import { InvalidInputError } from "../../domain/shared/domain-error";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `walletId` e `playerId` sao colunas `uuid` no schema. Sem esta checagem, um
 * identificador malformado atravessa o dominio (que nao exige UUID — o
 * `providerId` e "provider-a") e morre no INSERT com SQLSTATE 22P02: erro sem
 * tipo de dominio, que o consumer leria como falha transitoria e levaria a DLQ
 * por retry de algo que nunca vai dar certo.
 *
 * E validacao de fronteira da aplicacao, nao do dominio: a exigencia vem da
 * persistencia, nao da regra de negocio.
 */
export function assertUuid(field: string, value: string): string {
  if (!UUID_SHAPE.test(value)) {
    throw new InvalidInputError(
      `${field} deve ser um UUID, recebido ${JSON.stringify(value)}`,
    );
  }
  // Normaliza para minusculas, e o chamador **tem** que usar o retorno.
  //
  // O PostgreSQL grava `uuid` em minusculas. Sem normalizar, um playerId em
  // maiusculas seria comparado cru contra o valor lido do banco, daria
  // PLAYER_MISMATCH e gravaria uma linha REJECTED — e aí o UNIQUE de
  // (provider, external id) faria a reapresentacao corrigida devolver 409 para
  // sempre. Uma aposta legitima perdida de forma definitiva.
  //
  // Por isso tambem entra **antes** do payloadHash: mesma operacao em caixa
  // diferente tem que gerar o mesmo hash.
  return value.toLowerCase();
}
