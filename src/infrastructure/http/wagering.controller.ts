import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { assertUuid } from "../../application/shared/assert-uuid";
import {
  SubmitOutcome,
  SubmitWagerTransaction,
  type SubmitWagerTransactionResult,
} from "../../application/wagering/submit-wager-transaction";
import { WagerTransactionQueries } from "../../application/wagering/wager-transaction-queries";
import { InvalidInputError } from "../../domain/shared/domain-error";
import { WagerTransactionSource } from "../../domain/wagering/wager-transaction-kind";
import { correlationIdOf, type WithCorrelation } from "./correlation-id.middleware";
import {
  submitWagerTransactionSchema,
  type SubmitWagerTransactionBody,
} from "./dto/schemas";
import { ZodValidationPipe } from "./zod-validation.pipe";

/**
 * Cada situacao tem um status proprio e consistente. Colapsar isso obriga o
 * provedor a interpretar mensagem de erro para decidir se pode reenviar.
 */
const STATUS_POR_RESULTADO: Readonly<Record<SubmitOutcome, number>> = {
  // Aplicada, ou replay da aplicacao original.
  [SubmitOutcome.Processed]: HttpStatus.OK,
  // Bem formada e compreendida — foi o dominio que disse nao. Nao e 400.
  [SubmitOutcome.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  // Aceita e aguardando a referencia chegar. Nem sucesso final, nem erro.
  [SubmitOutcome.PendingReference]: HttpStatus.ACCEPTED,
  // Mesma key, payload diferente: o estado do recurso impede.
  [SubmitOutcome.IdempotencyConflict]: HttpStatus.CONFLICT,
  [SubmitOutcome.DuplicateExternalTransaction]: HttpStatus.CONFLICT,
  // So alcancavel pela fila; aqui por completude do mapa.
  [SubmitOutcome.DuplicateMessage]: HttpStatus.OK,
};

function corpoDe(resultado: SubmitWagerTransactionResult): Record<string, unknown> {
  const corpo: Record<string, unknown> = { idempotentReplay: resultado.idempotentReplay };
  if (resultado.transactionId !== undefined) corpo["transactionId"] = resultado.transactionId;
  if (resultado.status !== undefined) corpo["status"] = resultado.status;
  if (resultado.balance !== undefined) corpo["balance"] = resultado.balance;
  if (resultado.failureCode !== undefined) corpo["failureCode"] = resultado.failureCode;
  if (resultado.outcome === SubmitOutcome.IdempotencyConflict) {
    corpo["error"] = "IDEMPOTENCY_KEY_CONFLICT";
  }
  if (resultado.outcome === SubmitOutcome.DuplicateExternalTransaction) {
    corpo["error"] = "DUPLICATE_EXTERNAL_TRANSACTION";
  }
  return corpo;
}

@Controller("wagering/transactions")
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly queries: WagerTransactionQueries,
  ) {}

  @Post()
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(submitWagerTransactionSchema))
    body: SubmitWagerTransactionBody,
    @Req() req: Request & Partial<WithCorrelation>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    // O header e a fonte da verdade da idempotencia, entao e obrigatorio:
    // aceitar sem ele seria aceitar uma operacao sem identidade.
    if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
      throw new InvalidInputError("header Idempotency-Key e obrigatorio");
    }

    const resultado = await this.submit.run({
      idempotencyKey,
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      source: WagerTransactionSource.Api,
      correlationId: correlationIdOf(req),
    });

    res.status(STATUS_POR_RESULTADO[resultado.outcome]);
    return corpoDe(resultado);
  }

  @Get(":transactionId")
  async byId(@Param("transactionId") transactionId: string): Promise<Record<string, unknown>> {
    assertUuid("transactionId", transactionId);
    const tx = await this.queries.byId(transactionId);
    if (!tx) throw new NotFoundException({ error: "TRANSACTION_NOT_FOUND" });
    return { ...tx };
  }
}

@Controller("providers")
export class ProvidersController {
  constructor(private readonly queries: WagerTransactionQueries) {}

  @Get(":providerId/wagering/transactions/:externalTransactionId")
  async byProviderAndExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    const tx = await this.queries.byProviderAndExternalId(providerId, externalTransactionId);
    if (!tx) throw new NotFoundException({ error: "TRANSACTION_NOT_FOUND" });
    return { ...tx };
  }
}
