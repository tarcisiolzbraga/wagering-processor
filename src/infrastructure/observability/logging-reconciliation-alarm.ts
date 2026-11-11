import type { Logger } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import type {
  Divergence,
  ReconciliationAlarm,
} from "../../application/ports/reconciliation-alarm";

/**
 * Divergencia entre saldo materializado e ledger: loga e contabiliza.
 *
 * Passa pelo logger do processo, nao por `console.error`: a diferenca e um
 * valor monetario, e so o logger aplica a redacao. Pelo console ela sairia
 * inteira, fora do nivel configurado e sem os campos fixos do processo.
 */
export class LoggingReconciliationAlarm implements ReconciliationAlarm {
  constructor(
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  divergenceDetected(divergence: Divergence): void {
    this.metrics.reconciliationDivergenceDetected();
    this.logger.error("divergencia entre saldo materializado e ledger", {
      walletId: divergence.walletId,
      difference: divergence.difference,
      checkedEntries: divergence.checkedEntries,
    });
  }
}
