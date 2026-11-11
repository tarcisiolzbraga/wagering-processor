import type { MikroORM } from "@mikro-orm/postgresql";

import { OpenWallet } from "../../../src/application/wallets/open-wallet";
import { WalletQueries } from "../../../src/application/wallets/wallet-queries";
import { ReconcileWallet } from "../../../src/application/wallets/reconcile-wallet";
import {
  WagerTransactionKind as Kind,
  WagerTransactionSource as Source,
} from "../../../src/domain/wagering/wager-transaction-kind";
import type { SubmitWagerTransactionCommand } from "../../../src/application/wagering/submit-wager-transaction";
import type { Divergence } from "../../../src/application/ports/reconciliation-alarm";
import { MikroUnitOfWork } from "../../../src/infrastructure/persistence/unit-of-work";
import { SystemClock, UuidV7Generator } from "../../../src/infrastructure/system-clock";
import { MetricsEspia } from "../../support/metrics";
import { openOrmWithFreshSchema } from "../../support/database";

/**
 * Lado do **parent**: prepara o estado, lê o resultado e confere invariantes.
 *
 * O parent nunca submete transacao: quem disputa sao os processos filhos. Aqui
 * ficam apenas abertura de carteira, leitura de saldo e reconciliacao.
 */
export class Mundo {
  private constructor(
    readonly orm: MikroORM,
    private readonly uow: MikroUnitOfWork,
    private readonly open: OpenWallet,
    private readonly carteiras: WalletQueries,
    private readonly reconcilia: ReconcileWallet,
    private readonly divergencias: Divergence[],
  ) {}

  static async abre(): Promise<Mundo> {
    const orm = await openOrmWithFreshSchema();
    const uow = new MikroUnitOfWork(orm);
    const divergencias: Divergence[] = [];

    return new Mundo(
      orm,
      uow,
      new OpenWallet(uow, new SystemClock(), new UuidV7Generator(), new MetricsEspia()),
      new WalletQueries(uow),
      new ReconcileWallet(uow, {
        divergenceDetected: (d: Divergence) => void divergencias.push(d),
      }),
      divergencias,
    );
  }

  async fecha(): Promise<void> {
    await this.orm.close(true);
  }

  async carteira(saldo: string): Promise<{ walletId: string; playerId: string }> {
    const playerId = crypto.randomUUID();
    const aberta = await this.open.run({
      playerId,
      initialBalance: { amount: saldo, currency: "BRL" },
      correlationId: crypto.randomUUID(),
    });
    return { walletId: aberta.walletId, playerId };
  }

  async saldo(walletId: string): Promise<string> {
    const wallet = await this.carteiras.byId(walletId);
    if (!wallet) throw new Error(`carteira ${walletId} nao encontrada`);
    return wallet.balance.amount;
  }

  async versao(walletId: string): Promise<number> {
    const wallet = await this.carteiras.byId(walletId);
    if (!wallet) throw new Error(`carteira ${walletId} nao encontrada`);
    return wallet.version;
  }

  /**
   * A assercao que fecha **todo** teste de concorrencia: o saldo materializado
   * tem que ser igual ao saldo reconstruido somando o ledger.
   *
   * E a verificacao que pega duplicacao, perda e lost update de uma vez, sem
   * depender de o teste ter adivinhado onde o bug estaria.
   */
  async confereInvarianteFinal(walletId: string): Promise<void> {
    const resultado = await this.reconcilia.run(walletId);
    if (resultado === undefined) throw new Error(`carteira ${walletId} desapareceu`);
    if (!resultado.consistent) {
      throw new Error(
        `saldo divergiu do ledger em ${walletId}: ` +
          `materializado ${resultado.storedBalance.amount}, ` +
          `ledger ${resultado.calculatedBalance.amount}`,
      );
    }
    if (this.divergencias.length > 0) {
      throw new Error(`alarme de divergencia disparou ${this.divergencias.length}x`);
    }
  }

  /** Lançamentos do ledger da carteira, em ordem. */
  async lancamentos(
    walletId: string,
  ): Promise<Array<{ transactionId: string; direction: string; amount: string }>> {
    return this.uow.read(async (ctx) => {
      const pagina = await ctx.ledger.page(walletId, undefined, 200);
      return pagina.entries.map((entry) => ({
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toJSON().amount,
      }));
    });
  }

  /** Estado da outbox, para afirmar que nada foi publicado duas vezes. */
  async outbox(): Promise<{ pendentes: number; publicados: number; abandonados: number }> {
    const [linha] = await this.orm.em.getConnection().execute<
      Array<{ pendentes: string; publicados: string; abandonados: string }>
    >(
      `select count(*) filter (where published_at is null and abandoned_at is null)::text as pendentes,
              count(*) filter (where published_at is not null)::text as publicados,
              count(*) filter (where abandoned_at is not null)::text as abandonados
         from outbox_messages`,
    );
    return {
      pendentes: Number(linha?.pendentes ?? "0"),
      publicados: Number(linha?.publicados ?? "0"),
      abandonados: Number(linha?.abandonados ?? "0"),
    };
  }

  /** Mensagens que a inbox registrou — a barreira contra redelivery. */
  async contaInbox(): Promise<number> {
    const [linha] = await this.orm.em
      .getConnection()
      .execute<Array<{ total: string }>>("select count(*)::text as total from inbox_messages");
    return Number(linha?.total ?? "0");
  }

  /**
   * Antecipa os agendamentos de referencia ausente.
   *
   * O backoff e real: a primeira tentativa fica no futuro, entao sem isto o
   * worker nao encontraria nada devido e o teste mediria a espera, nao a
   * resolucao.
   */
  async venceAgendamentos(): Promise<void> {
    await this.orm.em
      .getConnection()
      .execute(
        "update wager_transactions set next_reference_attempt_at = now() - interval '1 hour' " +
          "where status = 'PENDING_REFERENCE'",
      );
  }

  /** Tentativas de resolucao de referencia contadas na linha. */
  async tentativasDeReferencia(transactionId: string): Promise<number> {
    const [linha] = await this.orm.em
      .getConnection()
      .execute<Array<{ reference_attempts: number }>>(
        "select reference_attempts from wager_transactions where id = ?",
        [transactionId],
      );
    return Number(linha?.reference_attempts ?? 0);
  }

  async contaPorStatus(walletId: string): Promise<Record<string, number>> {
    const linhas = await this.orm.em
      .getConnection()
      .execute<Array<{ status: string; total: string }>>(
        "select status, count(*)::text as total from wager_transactions where wallet_id = ? group by status",
        [walletId],
      );
    return Object.fromEntries(linhas.map((l) => [l.status, Number(l.total)]));
  }
}

/** Comando de aposta, com o que o teste quiser sobrescrever. */
export function aposta(
  base: { walletId: string; playerId: string },
  over: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId = over.externalTransactionId ?? `external-${crypto.randomUUID()}`;
  const providerId = over.providerId ?? "provider-a";
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: base.playerId,
    walletId: base.walletId,
    roundId: `round-${crypto.randomUUID()}`,
    gameId: "fortune-chimp",
    kind: Kind.Bet,
    money: { amount: "10.00", currency: "BRL" },
    source: Source.Api,
    correlationId: crypto.randomUUID(),
    ...over,
  };
}
