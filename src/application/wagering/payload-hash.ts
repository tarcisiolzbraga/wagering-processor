import { createHash } from "node:crypto";

import { canonicalJson } from "../../domain/shared/canonical-json";
import { Money, type MoneyProps } from "../../domain/money/money";
import type { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";

/**
 * Subconjunto de **negocio** do payload. Header, messageId, occurredAt e a
 * propria idempotency key ficam de fora: sao metadados de transporte, e dois
 * envios da mesma operacao tem messageId diferente por definicao — se entrassem
 * no hash, nenhum replay seria detectado.
 */
export interface HashableWagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}

/**
 * `sha256(JSON canonico)` em hexadecimal.
 *
 * O valor monetario e **normalizado por `Money`** antes de entrar no hash, para
 * que "25", "25.0" e "25.00" produzam o mesmo hash: sao o mesmo dinheiro, e
 * tratar como payload diferente transformaria formatacao em conflito.
 */
export function computePayloadHash(payload: HashableWagerPayload): string {
  const money = Money.from(payload.money).toJSON();

  // O dominio trata referencia vazia como ausente. Se o hash nao fizer o
  // mesmo, o mesmo pedido enviado com "" e sem o campo viraria conflito de
  // idempotencia em cima de uma linha identica — o mesmo problema que a
  // normalizacao do valor evita.
  const referencia =
    payload.referenceExternalTransactionId !== undefined &&
    payload.referenceExternalTransactionId.length > 0
      ? payload.referenceExternalTransactionId
      : undefined;

  const canonico = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId: referencia,
  });

  return createHash("sha256").update(canonico, "utf8").digest("hex");
}

/** Exposto para o teste e para a documentacao do algoritmo. */
export const canonicalizeForTest = canonicalJson;
