import { InvariantViolationError } from "../shared/domain-error";

export enum WagerTransactionKind {
  /** Interno: credito de abertura da wallet. Nao submissivel pela API nem pela fila. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

/** De onde a operacao entrou. Guarda a regra de que OPENING e interno. */
export enum WagerTransactionSource {
  Internal = "INTERNAL",
  Api = "API",
  Queue = "QUEUE",
}

/** O que cada kind pode reverter. REFUND so reverte BET; ROLLBACK reverte mais. */
const REVERSIBLE: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [],
  [WagerTransactionKind.Loss]: [],
};

/** Kinds que exigem referencia. */
export function kindRequiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

/**
 * Kinds que podem carregar referencia. WIN pode referenciar a BET da rodada,
 * mas nao e obrigado. BET, LOSS e OPENING nao referenciam nada: receber o
 * campo neles indica bug do provedor, e avisar e melhor que ignorar em silencio.
 */
export function kindAcceptsReference(kind: WagerTransactionKind): boolean {
  return kindRequiresReference(kind) || kind === WagerTransactionKind.Win;
}

export function kindCanReverse(
  kind: WagerTransactionKind,
  referenceKind: WagerTransactionKind,
): boolean {
  const reversiveis: readonly WagerTransactionKind[] | undefined = REVERSIBLE[kind];
  if (reversiveis === undefined) {
    throw new InvariantViolationError(
      `kind de transacao desconhecido vindo da persistencia: ${JSON.stringify(kind)}`,
    );
  }
  return reversiveis.includes(referenceKind);
}
