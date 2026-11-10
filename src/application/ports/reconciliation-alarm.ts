import type { MoneyProps } from "../../domain/money/money";

export interface Divergence {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly checkedEntries: number;
}

/**
 * Divergencia entre saldo materializado e ledger **nao e corrigida em
 * silencio**: se os dois discordam, nao se sabe qual esta certo, e "corrigir"
 * seria escolher um palpite e destruir a evidencia do bug que causou a
 * divergencia. Loga, contabiliza, sinaliza — e um humano investiga com o ledger
 * intacto.
 */
export interface ReconciliationAlarm {
  divergenceDetected(divergence: Divergence): void;
}

export const RECONCILIATION_ALARM = Symbol("RECONCILIATION_ALARM");
