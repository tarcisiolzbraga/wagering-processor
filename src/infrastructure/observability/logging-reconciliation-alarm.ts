import type {
  Divergence,
  ReconciliationAlarm,
} from "../../application/ports/reconciliation-alarm";

/**
 * Loga a divergencia em JSON estruturado. A metrica correspondente entra na
 * Fase 9; o log existe desde agora porque divergencia silenciosa e justamente
 * o que nao pode acontecer.
 */
export class LoggingReconciliationAlarm implements ReconciliationAlarm {
  divergenceDetected(divergence: Divergence): void {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "divergencia entre saldo materializado e ledger",
        walletId: divergence.walletId,
        difference: divergence.difference,
        checkedEntries: divergence.checkedEntries,
      }),
    );
  }
}
