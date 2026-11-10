import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { assertUuid } from "../../application/shared/assert-uuid";
import { OpenWallet, OpenWalletOutcome } from "../../application/wallets/open-wallet";
import { ReconcileWallet } from "../../application/wallets/reconcile-wallet";
import { WalletQueries } from "../../application/wallets/wallet-queries";
import { correlationIdOf, type WithCorrelation } from "./correlation-id.middleware";
import {
  ledgerQuerySchema,
  openWalletSchema,
  type LedgerQuery,
  type OpenWalletBody,
} from "./dto/schemas";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WalletQueries,
    private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  async open(
    @Body(new ZodValidationPipe(openWalletSchema)) body: OpenWalletBody,
    @Req() req: Request & Partial<WithCorrelation>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const resultado = await this.openWallet.run({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId: correlationIdOf(req),
    });

    const criada = resultado.outcome === OpenWalletOutcome.Opened;
    res.status(criada ? HttpStatus.CREATED : HttpStatus.CONFLICT);

    const corpo: Record<string, unknown> = {
      id: resultado.walletId,
      playerId: resultado.playerId,
      balance: resultado.balance,
      version: resultado.version,
    };
    if (!criada) {
      // 409 e nao 201: o estado atual do recurso impede, e reenviar igual nao
      // resolve. O corpo traz a carteira existente para o cliente seguir.
      corpo["error"] = "WALLET_ALREADY_EXISTS";
    }
    return corpo;
  }

  @Get(":walletId")
  async byId(@Param("walletId") walletId: string): Promise<Record<string, unknown>> {
    assertUuid("walletId", walletId);
    const wallet = await this.queries.byId(walletId);
    if (!wallet) throw new NotFoundException({ error: "WALLET_NOT_FOUND" });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance,
      version: wallet.version,
    };
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
  ): Promise<Record<string, unknown>> {
    assertUuid("walletId", walletId);
    if (!(await this.queries.byId(walletId))) {
      throw new NotFoundException({ error: "WALLET_NOT_FOUND" });
    }

    const pagina = await this.queries.ledger(walletId, query.cursor, query.limit);
    return { entries: pagina.entries, nextCursor: pagina.nextCursor ?? null };
  }

  /**
   * Divergencia **nao** e corrigida: se os dois lados discordam, nao se sabe
   * qual esta certo, e corrigir seria destruir a evidencia do bug. Responde
   * 200 com `consistent: false` sinalizado — quem decide o que fazer e humano.
   */
  // 200, nao o 201 que o Nest da por default em POST: a reconciliacao nao cria
  // recurso nenhum, so compara e reporta.
  @HttpCode(HttpStatus.OK)
  @Post(":walletId/reconciliation")
  async reconciliation(@Param("walletId") walletId: string): Promise<Record<string, unknown>> {
    assertUuid("walletId", walletId);
    const resultado = await this.reconcile.run(walletId);
    if (!resultado) throw new NotFoundException({ error: "WALLET_NOT_FOUND" });
    return { ...resultado };
  }
}
