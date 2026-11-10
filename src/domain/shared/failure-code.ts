/**
 * Taxonomia de falha. O provedor e uma maquina: ela precisa decidir sozinha
 * entre reenviar, corrigir o payload ou desistir. Parsear texto de mensagem
 * para tomar essa decisao quebra no dia que alguem melhora o texto do erro.
 */
export enum FailureCode {
  /** Aposta sem saldo. Operacao normal do negocio, acontece o tempo todo. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /**
   * Reversao que deixaria o saldo negativo. Distinto de InsufficientFunds de
   * proposito: significa que o dinheiro que supostamente entrou nao cabe mais
   * no saldo, ou seja, ha algo inconsistente entre nos e o provedor. O primeiro
   * e metrica de negocio; este e alerta de plantao.
   */
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",

  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  PlayerMismatch = "PLAYER_MISMATCH",

  /** REFUND/ROLLBACK chegou sem referencia no payload. */
  MissingReference = "MISSING_REFERENCE",
  /** A referencia nao existe — pode ser ordem de entrega, pode ser payload errado. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceKindNotReversible = "REFERENCE_KIND_NOT_REVERSIBLE",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  /** Referencia existe mas e de outro provider, player, wallet, moeda ou rodada. */
  ReferenceScopeMismatch = "REFERENCE_SCOPE_MISMATCH",

  /**
   * Valor computado estourou a capacidade de NUMERIC(20,2). Rejeitar aqui em
   * vez de deixar o INSERT falhar com 22003: um erro do banco seria
   * classificado como transitorio e entraria em loop de retry ate a DLQ.
   */
  AmountOverflow = "AMOUNT_OVERFLOW",

  IdempotencyKeyConflict = "IDEMPOTENCY_KEY_CONFLICT",
  /** OPENING nao pode ser submetido pela API nem pela fila. */
  InternalKindNotSubmittable = "INTERNAL_KIND_NOT_SUBMITTABLE",
}
