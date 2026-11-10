import { InvalidInputError } from "../../../domain/shared/domain-error";

export interface LedgerCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Cursor opaco sobre `(created_at, id)` — par totalmente ordenado e estavel.
 *
 * Nao se usa OFFSET: em tabela que recebe insert durante a paginacao, OFFSET
 * pula ou repete linha. Em extrato financeiro, linha pulada e reclamacao de
 * cliente.
 */
export function encodeCursor(cursor: LedgerCursor): string {
  const payload = JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): LedgerCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidInputError("cursor invalido");
  }

  const obj = parsed as { t?: unknown; i?: unknown };
  if (typeof obj.t !== "string" || typeof obj.i !== "string") {
    throw new InvalidInputError("cursor invalido");
  }
  const createdAt = new Date(obj.t);
  if (Number.isNaN(createdAt.getTime())) {
    throw new InvalidInputError("cursor invalido");
  }
  // O id entra numa comparacao de tupla contra uma coluna `uuid`. Sem esta
  // checagem, um cursor adulterado chega ao SQL e estoura 22P02 — 500 em vez
  // do 400 que um cursor invalido merece.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj.i)) {
    throw new InvalidInputError("cursor invalido");
  }
  return { createdAt, id: obj.i.toLowerCase() };
}
