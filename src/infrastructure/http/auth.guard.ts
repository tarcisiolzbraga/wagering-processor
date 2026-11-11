import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";

import { LOGGER, type Logger } from "../../application/ports/logger";
import { ENV, type Env } from "../../config/env";
import {
  InvalidTokenError,
  TOKEN_VERIFIER,
  type Principal,
  type TokenVerifier,
} from "../auth/principal";
import { correlationIdOf, type WithCorrelation } from "./correlation-id.middleware";

export interface WithPrincipal {
  principal: Principal;
}

/**
 * Autentica o chamador por JWT do Keycloak.
 *
 * Aplicado por controller, não globalmente com lista de caminhos liberados:
 * health e `/metrics` simplesmente não recebem o guard. Uma allowlist de
 * caminhos é uma segunda fonte de verdade que envelhece — endpoint novo nasce
 * aberto se alguém esquecer de atualizá-la, e o esquecimento é silencioso.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /**
   * Os tokens sao declarados aqui, e nao numa fabrica no modulo.
   *
   * Guard referenciado por classe em `@UseGuards` e instanciado pelo Nest
   * pelos `injectables` do modulo, nao pelos `providers`: uma entrada
   * `{ provide: AuthGuard, useFactory }` e simplesmente ignorada nesse
   * caminho, e o container tenta resolver os parametros por tipo — `Env` e
   * `Logger` sao tipos, viram `Object` em metadado, e o boot morre.
   */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.env.AUTH_ENABLED) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & Partial<WithCorrelation> & Partial<WithPrincipal>>();

    const token = bearerDe(req.headers.authorization);
    if (token === undefined) {
      throw new UnauthorizedException({ error: "MISSING_TOKEN" });
    }

    try {
      req.principal = await this.verifier.verify(token);
    } catch (erro: unknown) {
      // O motivo vai para o log do servidor. Na resposta, só 401: distinguir
      // "assinatura inválida" de "audience errada" daria ao atacante um
      // oráculo para descobrir o que falta no token forjado dele.
      this.logger.warn("token recusado", {
        correlationId: correlationIdOf(req),
        path: req.url,
        // Nunca o token: ele é a credencial.
        reason: erro instanceof InvalidTokenError ? erro.reason : "erro inesperado",
      });
      throw new UnauthorizedException({ error: "INVALID_TOKEN" });
    }

    return true;
  }
}

/**
 * Extrai o token do header `Authorization`.
 *
 * O esquema é comparado sem diferenciar maiúsculas porque a RFC 7235 diz que
 * ele é case-insensitive, e cliente que manda `bearer` não está errado.
 */
function bearerDe(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;

  const [esquema, ...resto] = header.trim().split(/\s+/);
  if (esquema?.toLowerCase() !== "bearer") return undefined;

  const token = resto.join(" ").trim();
  return token.length > 0 ? token : undefined;
}
