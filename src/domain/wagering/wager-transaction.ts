import { Money } from "../money/money";
import {
  DomainRuleViolationError,
  InvalidInputError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from "../shared/domain-error";
import { FailureCode } from "../shared/failure-code";
import { assertIdentifier } from "../shared/identifier";
import { LedgerDirection } from "../wallet/ledger-direction";
import {
  kindAcceptsReference,
  kindCanReverse,
  kindRequiresReference,
  WagerTransactionKind,
  WagerTransactionSource,
} from "./wager-transaction-kind";
import {
  canTransition,
  isTerminalStatus,
  WagerTransactionStatus,
} from "./wager-transaction-status";

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** id no provedor — nao o id interno. */
  readonly referenceExternalTransactionId?: string | undefined;
  readonly source: WagerTransactionSource;
  readonly createdAt: Date;
}

/**
 * Politica de reprocessamento de referencia ausente.
 *
 * **O TTL e o limite que vale**; o numero de tentativas e rede de seguranca
 * contra laco patologico. Os dois precisam ser coerentes, e na primeira versao
 * nao eram: 15 tentativas com backoff saturado em 5 min esgotam em cerca de 38
 * minutos, o que tornava o TTL de 24h decorativo — a transacao seria rejeitada
 * muito antes de a janela que o TTL promete ter passado.
 *
 * 24h cobre o incidente realista: fila do provedor atrasada, reprocessamento
 * em lote, janela de manutencao. Para o TTL de fato decidir, a soma dos
 * atrasos precisa passar de 24h: com o backoff saturado em 15 min, a rampa
 * inicial soma ~17 min e cada tentativa seguinte adiciona 15, entao 120
 * tentativas cobrem cerca de 28h. Ha teste fixando essa relacao.
 */
export const REFERENCE_MAX_ATTEMPTS = 120;
export const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

const REFERENCE_BACKOFF_BASE_MS = 1_000;
const REFERENCE_BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * Espera antes da proxima tentativa: 1s, 2s, 4s… saturando em 15 min.
 *
 * Deterministico, sem jitter: o agendamento e por linha e a releitura sob o
 * lock da carteira confere o vencimento com o relogio do banco, entao duas
 * replicas nunca consomem a mesma tentativa — nao ha efeito de manada a
 * dispersar. Em troca, o agendamento fica exatamente testavel.
 */
export function referenceBackoffDelayMs(attempts: number): number {
  if (attempts < 1) return REFERENCE_BACKOFF_BASE_MS;
  const exponencial = REFERENCE_BACKOFF_BASE_MS * 2 ** (attempts - 1);
  return Math.min(exponencial, REFERENCE_BACKOFF_MAX_MS);
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly processedAt?: Date | undefined;
  /** Tentativas de resolver a referencia ausente. */
  readonly referenceAttempts?: number | undefined;
  /** Quando a transacao entrou em PENDING_REFERENCE pela primeira vez. */
  readonly pendingReferenceSince?: Date | undefined;
  /**
   * Saldo observado no momento em que a transacao chegou ao estado terminal.
   * Existe para a regra 7.7: repetir uma operacao ja processada devolve o
   * resultado original, incluindo o saldo daquele momento. Recalcular
   * devolveria o saldo atual, que e uma resposta factualmente errada.
   */
  readonly observedBalance?: Money | undefined;
}

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly source: WagerTransactionSource,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string | undefined,
    private _failureCode?: FailureCode | undefined,
    private _processedAt?: Date | undefined,
    private _observedBalance?: Money | undefined,
    private _referenceAttempts: number = 0,
    private _pendingReferenceSince?: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida a exigencia de referencia por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertIdentifiers(props);
    // So valida o formato quando ha algo: referencia vazia e "falta referencia"
    // (regra de negocio, 422), nao identificador malformado (400).
    if (
      typeof props.referenceExternalTransactionId === "string" &&
      props.referenceExternalTransactionId.length > 0
    ) {
      assertIdentifier("referenceExternalTransactionId", props.referenceExternalTransactionId);
    }

    if (!props.money.isPositive()) {
      throw new InvalidInputError(
        `transacao com valor nao positivo: ${props.money.toString()}`,
      );
    }

    if (
      props.kind === WagerTransactionKind.Opening &&
      props.source !== WagerTransactionSource.Internal
    ) {
      throw new DomainRuleViolationError(
        FailureCode.InternalKindNotSubmittable,
        `OPENING e interno e nao pode ser submetido via ${props.source}`,
      );
    }

    const temReferencia =
      props.referenceExternalTransactionId !== undefined &&
      props.referenceExternalTransactionId.length > 0;

    if (kindRequiresReference(props.kind) && !temReferencia) {
      throw new DomainRuleViolationError(
        FailureCode.MissingReference,
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }
    if (temReferencia && !kindAcceptsReference(props.kind)) {
      throw new InvalidInputError(
        `${props.kind} nao referencia outra transacao, mas veio com referenceExternalTransactionId`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      temReferencia ? props.referenceExternalTransactionId : undefined,
      props.source,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstrucao a partir da persistencia — nao revalida transicoes. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.source,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceAttempts ?? 0,
      state.pendingReferenceSince,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get pendingReferenceSince(): Date | undefined {
    return this._pendingReferenceSince;
  }

  // ---- transicoes

  markProcessed(props: {
    readonly referenceTransactionId?: string | undefined;
    readonly observedBalance: Money;
    readonly at: Date;
  }): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = props.referenceTransactionId;
    this._observedBalance = props.observedBalance;
    this._processedAt = props.at;
  }

  /**
   * Cada chamada conta uma tentativa. `pendingReferenceSince` e gravado apenas
   * na primeira: e ele que ancora o TTL, entao sobrescrever a cada re-marcacao
   * deixaria a transacao pendente para sempre.
   */
  markPendingReference(at: Date): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._referenceAttempts += 1;
    this._pendingReferenceSince ??= at;
  }

  /** Esgotou tentativas ou TTL? Quem decide rejeitar e o worker. */
  hasExhaustedReferenceRetries(props: {
    readonly now: Date;
    readonly maxAttempts?: number;
    readonly ttlMs?: number;
  }): boolean {
    const maxAttempts = props.maxAttempts ?? REFERENCE_MAX_ATTEMPTS;
    const ttlMs = props.ttlMs ?? REFERENCE_TTL_MS;

    if (this._referenceAttempts >= maxAttempts) return true;
    if (this._pendingReferenceSince === undefined) return false;
    return props.now.getTime() - this._pendingReferenceSince.getTime() >= ttlMs;
  }

  reject(props: { readonly code: FailureCode; readonly observedBalance?: Money | undefined; readonly at: Date }): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = props.code;
    this._observedBalance = props.observedBalance;
    this._processedAt = props.at;
  }

  fail(props: { readonly code: FailureCode; readonly at: Date }): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = props.code;
    this._processedAt = props.at;
  }

  private transitionTo(target: WagerTransactionStatus): void {
    if (!canTransition(this._status, target)) {
      throw new InvalidTransactionStateError(
        `transicao invalida de ${this._status} para ${target} na transacao ${this.id}` +
          (this.isTerminal() ? " — estado terminal nao muda mais" : ""),
      );
    }
    this._status = target;
  }

  // ---- consultas de dominio

  isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  /** LOSS registra o resultado da rodada sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return kindRequiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Esta transacao pode ser revertida por uma operacao do kind informado? */
  isReversibleBy(kind: WagerTransactionKind): boolean {
    return kindCanReverse(kind, this.kind);
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError(
            `ROLLBACK ${this.id} precisa da referencia para determinar a direcao do lancamento`,
          );
        }
        if (reference.kind === WagerTransactionKind.Rollback) {
          throw new InvariantViolationError(
            `ROLLBACK ${this.id} nao pode referenciar outro ROLLBACK`,
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Credit
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
      }

      case WagerTransactionKind.Loss:
        throw new InvariantViolationError(
          `LOSS ${this.id} nao gera lancamento no ledger`,
        );

      default:
        // `rehydrate` aceita o que vier do banco. Sem este default o switch
        // cairia fora e devolveria undefined — direcao de lancamento invalida,
        // em silencio.
        throw new InvariantViolationError(
          `kind desconhecido vindo da persistencia na transacao ${this.id}: ${JSON.stringify(this.kind)}`,
        );
    }
  }

  private static assertIdentifiers(props: CreateWagerTransactionProps): void {
    const obrigatorios: ReadonlyArray<[string, string]> = [
      ["id", props.id],
      ["providerId", props.providerId],
      ["externalTransactionId", props.externalTransactionId],
      ["idempotencyKey", props.idempotencyKey],
      ["payloadHash", props.payloadHash],
      ["walletId", props.walletId],
      ["playerId", props.playerId],
      ["roundId", props.roundId],
      ["gameId", props.gameId],
    ];
    for (const [campo, valor] of obrigatorios) {
      assertIdentifier(campo, valor);
    }
  }
}
