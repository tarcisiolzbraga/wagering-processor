import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { InvalidTokenError, type Principal, type TokenVerifier } from "./principal";

/**
 * Algoritmos aceitos, em allowlist.
 *
 * Sem a lista, um token com `alg: none` ou com `alg: HS256` assinado usando a
 * **chave pública** do JWKS como segredo passaria pela verificação. É o ataque
 * clássico de confusão de algoritmo, e a defesa é não deixar o atacante
 * escolher como o token dele é validado.
 */
const ALGORITMOS = ["RS256", "RS384", "RS512", "ES256", "ES384"];

/** Tolerância de relógio entre o IdP e a aplicação. */
const TOLERANCIA_SEGUNDOS = 5;

export class JoseTokenVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    jwksUrl?: URL,
  ) {
    this.jwks = createRemoteJWKSet(jwksUrl ?? new URL(`${issuer}/protocol/openid-connect/certs`), {
      // As chaves ficam em cache: buscar o JWKS a cada requisição poria o
      // caminho de autenticação na dependência da latência do Keycloak, e um
      // pico de tráfego viraria um ataque de negação de serviço contra o IdP.
      cacheMaxAge: 10 * 60 * 1000,
      // Teto de refetch quando aparece um `kid` desconhecido. Sem ele, uma
      // enxurrada de tokens com kid inventado forçaria uma busca por
      // requisição — o mesmo DoS, agora acionável de fora.
      cooldownDuration: 30 * 1000,
      timeoutDuration: 3 * 1000,
    });
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;

    try {
      const verificado = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ALGORITMOS,
        clockTolerance: TOLERANCIA_SEGUNDOS,
      });
      payload = verificado.payload;
    } catch (erro: unknown) {
      // O motivo entra no erro para o log do servidor, não para a resposta.
      throw new InvalidTokenError(erro instanceof Error ? erro.message : String(erro));
    }

    const providerId = payload["providerId"];
    if (typeof providerId !== "string" || providerId.trim().length === 0) {
      // Token válido mas sem identidade de provedor não autoriza nada: seguir
      // sem ela significaria aceitar o `providerId` que o corpo mandar.
      throw new InvalidTokenError("sem claim providerId");
    }

    if (payload.exp === undefined) {
      // `jwtVerify` aceita token sem `exp`. Credencial que não expira é
      // credencial que vaza para sempre.
      throw new InvalidTokenError("sem expiracao");
    }

    return {
      providerId,
      clientId: typeof payload["azp"] === "string" ? payload["azp"] : providerId,
      subject: payload.sub ?? "desconhecido",
      expiresAt: new Date(payload.exp * 1000),
    };
  }
}
