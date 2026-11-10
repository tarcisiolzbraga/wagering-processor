import { z } from "zod";

import { WagerTransactionKind } from "../../../domain/wagering/wager-transaction-kind";

/**
 * Validacao de **forma**, nao de regra monetaria: a escala, a notacao e o
 * sinal do valor sao decididos por `Money`, que ja rejeita com mensagem
 * precisa. Duplicar aqui criaria duas fontes da mesma regra, que divergem.
 */
const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const openWalletSchema = z
  .object({
    playerId: z.string(),
    initialBalance: moneySchema,
  })
  .strict();

export const submitWagerTransactionSchema = z
  .object({
    providerId: z.string().min(1),
    externalTransactionId: z.string().min(1),
    playerId: z.string(),
    walletId: z.string(),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    // OPENING passa pela validacao de forma de proposito: recusar aqui daria
    // 400, e o enunciado pede que o provedor saiba *por que* foi recusado —
    // o dominio devolve 422 com INTERNAL_KIND_NOT_SUBMITTABLE.
    kind: z.nativeEnum(WagerTransactionKind),
    money: moneySchema,
    referenceExternalTransactionId: z.string().optional(),
  })
  .strict();

export const ledgerQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type OpenWalletBody = z.infer<typeof openWalletSchema>;
export type SubmitWagerTransactionBody = z.infer<typeof submitWagerTransactionSchema>;
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
