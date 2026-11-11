/** Quem está chamando, depois de o token ser verificado. */
export interface Principal {
  /** Provedor dono do token. É este valor que manda, nunca o do payload. */
  readonly providerId: string;
  /** `azp` do token: o client do Keycloak. */
  readonly clientId: string;
  readonly subject: string;
  readonly expiresAt: Date;
}

export interface TokenVerifier {
  /** Lança `InvalidTokenError` quando o token não vale. */
  verify(token: string): Promise<Principal>;
}

/**
 * Token inválido é uma coisa só para quem chama: 401.
 *
 * O motivo fica no log do servidor, nunca na resposta — dizer ao cliente
 * "assinatura inválida" contra "audience errada" é dar a ele um oráculo para
 * descobrir como forjar um token que passa.
 */
export class InvalidTokenError extends Error {
  constructor(readonly reason: string) {
    super(`token invalido: ${reason}`);
    this.name = "InvalidTokenError";
  }
}

export const TOKEN_VERIFIER = Symbol("TOKEN_VERIFIER");
