import { describe, expect, it } from "bun:test";

import { Money } from "../../../../src/domain/money/money";
import {
  DomainRuleViolationError,
  InvalidInputError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from "../../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../../src/domain/shared/failure-code";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction";
import {
  WagerTransactionKind as Kind,
  WagerTransactionSource as Source,
} from "../../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../../../src/domain/wagering/wager-transaction-status";
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from "../../../../src/domain/wagering/wager-transaction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-10T10:00:00.000Z");

function props(over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    payloadHash: "hash-abc",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: Kind.Bet,
    money: brl("25.00"),
    source: Source.Api,
    createdAt: at,
    ...over,
  };
}

const criar = (over: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(over));

describe("WagerTransaction — criacao", () => {
  it("nasce em PENDING sem failureCode nem processedAt", () => {
    const tx = criar();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.observedBalance).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  it("rejeita valor nao positivo", () => {
    expect(() => criar({ money: Money.zero("BRL") })).toThrow(InvalidInputError);
    expect(() => criar({ money: brl("1.00").negate() })).toThrow(InvalidInputError);
  });

  const identificadores = [
    "id",
    "providerId",
    "externalTransactionId",
    "idempotencyKey",
    "payloadHash",
    "walletId",
    "playerId",
    "roundId",
    "gameId",
  ] as const;

  for (const campo of identificadores) {
    it(`rejeita ${campo} vazio`, () => {
      expect(() => criar({ [campo]: "   " } as Partial<CreateWagerTransactionProps>)).toThrow(
        new RegExp(campo),
      );
    });
  }
});

describe("WagerTransaction — OPENING e interno", () => {
  it("aceita OPENING com origem interna", () => {
    const tx = criar({ kind: Kind.Opening, source: Source.Internal });
    expect(tx.kind).toBe(Kind.Opening);
  });

  for (const source of [Source.Api, Source.Queue]) {
    it(`recusa OPENING submetido via ${source}`, () => {
      try {
        criar({ kind: Kind.Opening, source });
        throw new Error("deveria ter lancado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(DomainRuleViolationError);
        expect((erro as DomainRuleViolationError).failureCode).toBe(
          FailureCode.InternalKindNotSubmittable,
        );
      }
    });
  }
});

describe("WagerTransaction — exigencia de referencia", () => {
  for (const kind of [Kind.Refund, Kind.Rollback]) {
    it(`${kind} sem referencia e rejeitado com MissingReference`, () => {
      try {
        criar({ kind });
        throw new Error("deveria ter lancado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(DomainRuleViolationError);
        expect((erro as DomainRuleViolationError).failureCode).toBe(FailureCode.MissingReference);
      }
    });

    it(`${kind} com referencia e aceito`, () => {
      const tx = criar({ kind, referenceExternalTransactionId: "transaction-100" });
      expect(tx.requiresReference()).toBe(true);
      expect(tx.referenceExternalTransactionId).toBe("transaction-100");
    });
  }

  it("WIN aceita referencia mas nao exige", () => {
    expect(criar({ kind: Kind.Win }).requiresReference()).toBe(false);
    expect(
      criar({ kind: Kind.Win, referenceExternalTransactionId: "transaction-100" })
        .referenceExternalTransactionId,
    ).toBe("transaction-100");
  });

  for (const kind of [Kind.Bet, Kind.Loss]) {
    it(`${kind} com referencia e recusado — avisar e melhor que ignorar em silencio`, () => {
      expect(() => criar({ kind, referenceExternalTransactionId: "transaction-100" })).toThrow(
        InvalidInputError,
      );
    });
  }

  it("referencia string vazia conta como ausente", () => {
    expect(() =>
      criar({ kind: Kind.Refund, referenceExternalTransactionId: "" }),
    ).toThrow(/exige referenceExternalTransactionId/);
  });
});

describe("WagerTransaction — efeito no saldo por kind", () => {
  it("so LOSS nao afeta saldo", () => {
    const esperado: ReadonlyArray<[Kind, boolean]> = [
      [Kind.Opening, true],
      [Kind.Bet, true],
      [Kind.Win, true],
      [Kind.Refund, true],
      [Kind.Rollback, true],
      [Kind.Loss, false],
    ];
    for (const [kind, afeta] of esperado) {
      const tx = criar({
        kind,
        source: kind === Kind.Opening ? Source.Internal : Source.Api,
        ...(kind === Kind.Refund || kind === Kind.Rollback
          ? { referenceExternalTransactionId: "transaction-100" }
          : {}),
      });
      expect(tx.affectsBalance()).toBe(afeta);
    }
  });
});

describe("WagerTransaction — direcao do lancamento", () => {
  const ref = (kind: Kind) =>
    criar({
      id: `ref-${kind}`,
      kind,
      source: kind === Kind.Opening ? Source.Internal : Source.Api,
      ...(kind === Kind.Refund ? { referenceExternalTransactionId: "transaction-50" } : {}),
    });

  it("BET debita; OPENING, WIN e REFUND creditam", () => {
    expect(criar({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(criar({ kind: Kind.Opening, source: Source.Internal }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(criar({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      criar({ kind: Kind.Refund, referenceExternalTransactionId: "t" }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  it("ROLLBACK inverte a direcao da referencia", () => {
    const rollback = criar({ kind: Kind.Rollback, referenceExternalTransactionId: "t" });
    expect(rollback.ledgerDirectionFor(ref(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(ref(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(ref(Kind.Refund))).toBe(LedgerDirection.Debit);
  });

  it("ROLLBACK sem referencia nao tem direcao definida", () => {
    const rollback = criar({ kind: Kind.Rollback, referenceExternalTransactionId: "t" });
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  it("ROLLBACK de ROLLBACK e recusado", () => {
    const rollback = criar({ kind: Kind.Rollback, referenceExternalTransactionId: "t" });
    const outro = criar({
      id: "ref-rollback",
      kind: Kind.Rollback,
      referenceExternalTransactionId: "t0",
    });
    expect(() => rollback.ledgerDirectionFor(outro)).toThrow(/outro ROLLBACK/);
  });

  it("LOSS nao gera lancamento", () => {
    expect(() => criar({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(/nao gera lancamento/);
  });
});

describe("WagerTransaction — o que pode reverter o que", () => {
  const reversivel = (alvo: Kind, por: Kind) =>
    criar({
      id: `alvo-${alvo}`,
      kind: alvo,
      source: alvo === Kind.Opening ? Source.Internal : Source.Api,
      ...(alvo === Kind.Refund || alvo === Kind.Rollback
        ? { referenceExternalTransactionId: "t" }
        : {}),
    }).isReversibleBy(por);

  it("REFUND so reverte BET", () => {
    expect(reversivel(Kind.Bet, Kind.Refund)).toBe(true);
    for (const alvo of [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Opening]) {
      expect(reversivel(alvo, Kind.Refund)).toBe(false);
    }
  });

  it("ROLLBACK reverte BET, WIN e REFUND", () => {
    for (const alvo of [Kind.Bet, Kind.Win, Kind.Refund]) {
      expect(reversivel(alvo, Kind.Rollback)).toBe(true);
    }
    for (const alvo of [Kind.Loss, Kind.Rollback, Kind.Opening]) {
      expect(reversivel(alvo, Kind.Rollback)).toBe(false);
    }
  });
});

describe("WagerTransaction — idempotencia por payload", () => {
  it("mesma key com payload divergente nao e replay", () => {
    const tx = criar({ payloadHash: "hash-abc" });
    expect(tx.matchesPayload("hash-abc")).toBe(true);
    expect(tx.matchesPayload("hash-xyz")).toBe(false);
  });
});

describe("WagerTransaction — transicoes", () => {
  it("PENDING vai para PROCESSED guardando saldo observado", () => {
    const tx = criar();
    tx.markProcessed({ observedBalance: brl("75.00"), at });

    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toBe(at);
    expect(tx.observedBalance?.toJSON().amount).toBe("75.00");
  });

  it("PENDING vai para PENDING_REFERENCE e depois para PROCESSED", () => {
    const tx = criar({ kind: Kind.Rollback, referenceExternalTransactionId: "t" });
    tx.markPendingReference(at);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);

    tx.markProcessed({ referenceTransactionId: "ref-1", observedBalance: brl("10.00"), at });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("ref-1");
  });

  it("PENDING_REFERENCE pode se remarcar — o worker tenta de novo", () => {
    const tx = criar({ kind: Kind.Refund, referenceExternalTransactionId: "t" });
    tx.markPendingReference(at);
    expect(() => tx.markPendingReference(at)).not.toThrow();
    expect(tx.status).toBe(Status.PendingReference);
  });

  it("reject guarda o failureCode e o saldo do momento", () => {
    const tx = criar();
    tx.reject({ code: FailureCode.InsufficientFunds, observedBalance: brl("20.00"), at });

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance?.toJSON().amount).toBe("20.00");
  });

  it("fail guarda o failureCode e e auditavel", () => {
    const tx = criar();
    tx.fail({ code: FailureCode.ReferenceNotFound, at });
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  const terminais: ReadonlyArray<[string, (tx: WagerTransaction) => void]> = [
    ["PROCESSED", (tx) => tx.markProcessed({ observedBalance: brl("1.00"), at })],
    ["REJECTED", (tx) => tx.reject({ code: FailureCode.InsufficientFunds, at })],
    ["FAILED", (tx) => tx.fail({ code: FailureCode.ReferenceNotFound, at })],
  ];

  for (const [nome, levarAoTerminal] of terminais) {
    it(`${nome} e terminal: qualquer transicao depois disso lanca`, () => {
      const tentativas: ReadonlyArray<(tx: WagerTransaction) => void> = [
        (tx) => tx.markProcessed({ observedBalance: brl("1.00"), at }),
        (tx) => tx.markPendingReference(at),
        (tx) => tx.reject({ code: FailureCode.InsufficientFunds, at }),
        (tx) => tx.fail({ code: FailureCode.ReferenceNotFound, at }),
      ];

      for (const tentativa of tentativas) {
        const tx = criar();
        levarAoTerminal(tx);
        const statusAntes = tx.status;
        expect(() => tentativa(tx)).toThrow(InvalidTransactionStateError);
        expect(tx.status).toBe(statusAntes);
      }
    });
  }

  it("a mensagem do erro terminal explica que o estado nao muda mais", () => {
    const tx = criar();
    tx.markProcessed({ observedBalance: brl("1.00"), at });
    expect(() => tx.markPendingReference(at)).toThrow(/estado terminal nao muda mais/);
  });
});

describe("WagerTransaction — rehydrate", () => {
  it("reconstroi estado terminal sem revalidar transicoes", () => {
    const tx = WagerTransaction.rehydrate({
      ...props(),
      status: Status.Processed,
      processedAt: at,
      observedBalance: brl("500.00"),
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.observedBalance?.toJSON().amount).toBe("500.00");
  });

  it("estado reidratado como terminal continua barrando transicao", () => {
    const tx = WagerTransaction.rehydrate({ ...props(), status: Status.Rejected });
    expect(() => tx.markProcessed({ observedBalance: brl("1.00"), at })).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe("WagerTransaction — identificadores com espaco em volta", () => {
  // "provider-a:tx-9" e "provider-a:tx-9 " seriam duas linhas distintas sob
  // UNIQUE (idempotency_key): debito duplicado sem concorrencia nenhuma.
  for (const campo of ["idempotencyKey", "providerId", "externalTransactionId", "walletId"] as const) {
    it(`recusa ${campo} com espaco em volta`, () => {
      expect(() => criar({ [campo]: " valor " })).toThrow(/espaco em volta/);
    });
  }

  it("recusa referencia com espaco em volta", () => {
    expect(() =>
      criar({ kind: Kind.Refund, referenceExternalTransactionId: "transaction-100 " }),
    ).toThrow(/espaco em volta/);
  });

  it("nao apara em silencio — o dado do provedor nao e alterado", () => {
    expect(() => criar({ providerId: "provider-a " })).toThrow(InvalidInputError);
  });
});

describe("WagerTransaction — tentativas de resolver a referencia", () => {
  const pendente = () => criar({ kind: Kind.Rollback, referenceExternalTransactionId: "t" });

  it("comeca sem tentativas e sem ancora de TTL", () => {
    const tx = pendente();
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.pendingReferenceSince).toBeUndefined();
  });

  it("cada marcacao conta uma tentativa", () => {
    const tx = pendente();
    tx.markPendingReference(at);
    expect(tx.referenceAttempts).toBe(1);
    tx.markPendingReference(new Date(at.getTime() + 60_000));
    expect(tx.referenceAttempts).toBe(2);
  });

  it("a ancora do TTL e a primeira marcacao, nao a ultima", () => {
    const tx = pendente();
    tx.markPendingReference(at);
    tx.markPendingReference(new Date(at.getTime() + 3_600_000));
    expect(tx.pendingReferenceSince).toBe(at);
  });

  it("esgota por numero de tentativas", () => {
    const tx = pendente();
    for (let i = 0; i < 15; i += 1) tx.markPendingReference(at);
    expect(tx.referenceAttempts).toBe(15);
    expect(tx.hasExhaustedReferenceRetries({ now: at })).toBe(true);
  });

  it("esgota por TTL de 24h mesmo com poucas tentativas", () => {
    const tx = pendente();
    tx.markPendingReference(at);

    const antes = new Date(at.getTime() + 23 * 60 * 60 * 1000);
    expect(tx.hasExhaustedReferenceRetries({ now: antes })).toBe(false);

    const depois = new Date(at.getTime() + 24 * 60 * 60 * 1000);
    expect(tx.hasExhaustedReferenceRetries({ now: depois })).toBe(true);
  });

  it("nao esgota antes de entrar em PENDING_REFERENCE", () => {
    expect(
      pendente().hasExhaustedReferenceRetries({
        now: new Date(at.getTime() + 10 * 24 * 60 * 60 * 1000),
      }),
    ).toBe(false);
  });

  it("rehydrate restaura tentativas e ancora", () => {
    const tx = WagerTransaction.rehydrate({
      ...props({ kind: Kind.Rollback, referenceExternalTransactionId: "t" }),
      status: Status.PendingReference,
      referenceAttempts: 14,
      pendingReferenceSince: at,
    });
    expect(tx.referenceAttempts).toBe(14);
    expect(tx.hasExhaustedReferenceRetries({ now: at })).toBe(false);
    tx.markPendingReference(at);
    expect(tx.hasExhaustedReferenceRetries({ now: at })).toBe(true);
  });
});

describe("WagerTransaction — enum desconhecido vindo da persistencia", () => {
  it("falha como invariante, nao como TypeError", () => {
    // TypeError seria classificado como falha transitoria pelo consumer e
    // entraria em loop de retry ate a DLQ.
    const tx = WagerTransaction.rehydrate({
      ...props(),
      status: "LEGADO_DESCONHECIDO" as Status,
    });
    expect(() => tx.markProcessed({ observedBalance: brl("1.00"), at })).toThrow(
      InvariantViolationError,
    );
    expect(() => tx.markProcessed({ observedBalance: brl("1.00"), at })).toThrow(
      /desconhecido vindo da persistencia/,
    );
  });

  it("kind desconhecido nao produz direcao de lancamento em silencio", () => {
    const tx = WagerTransaction.rehydrate({
      ...props(),
      kind: "LEGADO_DESCONHECIDO" as Kind,
      status: Status.Processed,
    });
    expect(() => tx.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => tx.ledgerDirectionFor()).toThrow(/kind desconhecido/);
  });

  it("nada reverte um kind que nao entendemos", () => {
    const tx = WagerTransaction.rehydrate({
      ...props(),
      kind: "LEGADO_DESCONHECIDO" as Kind,
      status: Status.Processed,
    });
    // Devolver false e a falha segura: a reversao e recusada em vez de
    // processada sobre um registro que o dominio nao sabe interpretar.
    expect(tx.isReversibleBy(Kind.Rollback)).toBe(false);
    expect(tx.isReversibleBy(Kind.Refund)).toBe(false);
  });
});
