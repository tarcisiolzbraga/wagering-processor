import { InvariantViolationError } from "../shared/domain-error";

export enum WagerTransactionStatus {
  /** Aceita, ainda nao aplicada. */
  Pending = "PENDING",
  /** Aguardando a transacao referenciada chegar. */
  PendingReference = "PENDING_REFERENCE",
  /** Aplicada. Terminal. */
  Processed = "PROCESSED",
  /** Violacao de regra de negocio. Terminal e auditavel. */
  Rejected = "REJECTED",
  /** Erro permanente de infraestrutura. Terminal e auditavel. */
  Failed = "FAILED",
}

const TERMINAL: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

/**
 * Transicoes validas. Os tres terminais nao saem de onde estao: uma transacao
 * terminal sendo re-transicionada significa que a deduplicacao falhou em algum
 * ponto, e isso e bug, nao caminho de negocio.
 *
 * PENDING_REFERENCE -> PENDING_REFERENCE e permitido de proposito: o worker
 * agendado re-marca a cada tentativa que ainda nao acha a referencia.
 */
const ALLOWED: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return TERMINAL.includes(status);
}

export function canTransition(
  from: WagerTransactionStatus,
  to: WagerTransactionStatus,
): boolean {
  // `rehydrate` aceita o que vier do banco. Um status desconhecido aqui viraria
  // TypeError — erro sem tipo de dominio, que o consumer leria como falha
  // transitoria e levaria a DLQ por retry. Melhor falhar como invariante.
  const permitidos: readonly WagerTransactionStatus[] | undefined = ALLOWED[from];
  if (permitidos === undefined) {
    throw new InvariantViolationError(
      `status de transacao desconhecido vindo da persistencia: ${JSON.stringify(from)}`,
    );
  }
  return permitidos.includes(to);
}
