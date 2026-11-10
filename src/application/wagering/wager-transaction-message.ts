import { z } from "zod";

import { InvalidInputError } from "../../domain/shared/domain-error";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

const envelopeSchema = z
  .object({
    /**
     * Identidade da mensagem **no provedor**, nao o id do broker. E esta que
     * vai para a inbox: o id do broker muda quando o provedor reenvia a mesma
     * operacao, e aí a deduplicacao nao pegaria nada.
     */
    messageId: z.string().min(1),
    type: z.literal(WAGER_TRANSACTION_REQUESTED),
    occurredAt: z.string().min(1),
    data: z
      .object({
        providerId: z.string().min(1),
        externalTransactionId: z.string().min(1),
        idempotencyKey: z.string().min(1),
        playerId: z.string(),
        walletId: z.string(),
        roundId: z.string().min(1),
        gameId: z.string().min(1),
        kind: z.nativeEnum(WagerTransactionKind),
        money: z.object({ amount: z.string(), currency: z.string() }),
        referenceExternalTransactionId: z.string().optional(),
        correlationId: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type WagerTransactionEnvelope = z.infer<typeof envelopeSchema>;

/**
 * Envelope malformado e erro **permanente**: retry nunca conserta JSON errado.
 * O `InvalidInputError` e o que faz a classificacao mandar para a DLQ em vez de
 * reenfileirar cinco vezes.
 */
export function parseWagerTransactionEnvelope(body: string): WagerTransactionEnvelope {
  let cru: unknown;
  try {
    cru = JSON.parse(body);
  } catch {
    throw new InvalidInputError("corpo da mensagem nao e JSON valido");
  }

  const parsed = envelopeSchema.safeParse(cru);
  if (parsed.success) return parsed.data;

  const detalhe = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
    .join("; ");
  throw new InvalidInputError(`envelope invalido — ${detalhe}`);
}
