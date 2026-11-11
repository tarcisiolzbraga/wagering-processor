import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyObject } from "jose";

import { JoseTokenVerifier } from "../../../src/infrastructure/auth/jose-token-verifier";
import { InvalidTokenError } from "../../../src/infrastructure/auth/principal";

const ISSUER = "https://idp.exemplo/realms/jungle";
const AUDIENCE = "wagering-api";

let privada: KeyObject;
let publica: KeyObject;
let jwk: JWK;
/** Par de chaves de um "atacante": assina, mas não está no JWKS. */
let privadaIntrusa: KeyObject;
let servidor: ReturnType<typeof Bun.serve>;
let verifier: JoseTokenVerifier;

/**
 * JWKS servido de verdade por HTTP.
 *
 * O verificador busca as chaves por URL, então um duplo em memória testaria o
 * duplo. Com um servidor real, o que está sendo exercitado é o caminho que
 * roda em produção — incluindo o cache.
 */
beforeAll(async () => {
  const par = await generateKeyPair("RS256");
  privada = par.privateKey as KeyObject;
  publica = par.publicKey as KeyObject;
  jwk = { ...(await exportJWK(publica)), kid: "chave-1", alg: "RS256", use: "sig" };

  const intruso = await generateKeyPair("RS256");
  privadaIntrusa = intruso.privateKey as KeyObject;

  servidor = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      }),
  });

  verifier = new JoseTokenVerifier(
    ISSUER,
    AUDIENCE,
    new URL(`http://127.0.0.1:${String(servidor.port)}/certs`),
  );
});

afterAll(() => {
  servidor.stop(true);
});

interface Opcoes {
  readonly issuer?: string;
  readonly audience?: string | string[];
  readonly providerId?: string | number | null;
  readonly expiraEm?: string | number;
  readonly chave?: KeyObject;
  readonly semExp?: boolean;
}

async function token(opcoes: Opcoes = {}): Promise<string> {
  const corpo: Record<string, unknown> = { azp: "provider-a", sub: "service-account" };
  if (opcoes.providerId !== null) corpo["providerId"] = opcoes.providerId ?? "provider-a";

  let jwt = new SignJWT(corpo)
    .setProtectedHeader({ alg: "RS256", kid: "chave-1" })
    .setIssuedAt()
    .setIssuer(opcoes.issuer ?? ISSUER)
    .setAudience(opcoes.audience ?? AUDIENCE);

  if (opcoes.semExp !== true) jwt = jwt.setExpirationTime(opcoes.expiraEm ?? "5m");

  return jwt.sign(opcoes.chave ?? privada);
}

describe("JoseTokenVerifier — token válido", () => {
  it("devolve o provedor, o client e a expiração", async () => {
    const principal = await verifier.verify(await token());

    expect(principal.providerId).toBe("provider-a");
    expect(principal.clientId).toBe("provider-a");
    expect(principal.subject).toBe("service-account");
    expect(principal.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("aceita audience em lista, como o Keycloak emite", async () => {
    // O token real do Keycloak traz `aud: ["wagering-api", "account"]`.
    const principal = await verifier.verify(
      await token({ audience: [AUDIENCE, "account"] }),
    );
    expect(principal.providerId).toBe("provider-a");
  });
});

describe("JoseTokenVerifier — recusas", () => {
  const recusa = async (promessa: Promise<unknown>): Promise<InvalidTokenError> => {
    try {
      await promessa;
    } catch (erro: unknown) {
      expect(erro).toBeInstanceOf(InvalidTokenError);
      if (erro instanceof InvalidTokenError) return erro;
      throw erro;
    }
    throw new Error("deveria ter recusado");
  };

  it("audience de outro serviço", async () => {
    await recusa(verifier.verify(await token({ audience: "outro-servico" })));
  });

  it("issuer diferente", async () => {
    // Token legítimo de outro realm é token de outro mundo.
    await recusa(verifier.verify(await token({ issuer: "https://idp.exemplo/realms/outro" })));
  });

  it("expirado", async () => {
    await recusa(verifier.verify(await token({ expiraEm: "-1m" })));
  });

  it("sem expiração", async () => {
    // `jwtVerify` aceita token sem `exp`; credencial que não expira é
    // credencial que vaza para sempre.
    const erro = await recusa(verifier.verify(await token({ semExp: true })));
    expect(erro.reason).toContain("expiracao");
  });

  it("assinado por chave que não está no JWKS", async () => {
    await recusa(verifier.verify(await token({ chave: privadaIntrusa })));
  });

  it("sem a claim providerId", async () => {
    const erro = await recusa(verifier.verify(await token({ providerId: null })));
    expect(erro.reason).toContain("providerId");
  });

  it("providerId vazio ou de outro tipo", async () => {
    await recusa(verifier.verify(await token({ providerId: "   " })));
    await recusa(verifier.verify(await token({ providerId: 42 })));
  });

  it("alg none", async () => {
    // Cabeçalho `alg: none` com assinatura vazia: o teste clássico de quem
    // aceita o que o token manda sobre como validá-lo.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const corpo = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        providerId: "provider-a",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url");

    await recusa(verifier.verify(`${header}.${corpo}.`));
  });

  it("confusão de algoritmo: HS256 assinado com a chave pública", async () => {
    // Ataque clássico: a chave pública do JWKS é pública, então se HS256
    // fosse aceito o atacante usaria o próprio material público como segredo.
    const segredo = new TextEncoder().encode(JSON.stringify(jwk.n ?? "chave"));
    const forjado = await new SignJWT({ providerId: "provider-a", azp: "provider-a" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(segredo);

    await recusa(verifier.verify(forjado));
  });

  it("token lixo", async () => {
    await recusa(verifier.verify("nao-e-um-jwt"));
    await recusa(verifier.verify(""));
  });
});

describe("JoseTokenVerifier — cache do JWKS", () => {
  it("não busca as chaves a cada verificação", async () => {
    let buscas = 0;
    const contador = Bun.serve({
      port: 0,
      fetch: () => {
        buscas += 1;
        return new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    try {
      const comCache = new JoseTokenVerifier(
        ISSUER,
        AUDIENCE,
        new URL(`http://127.0.0.1:${String(contador.port)}/certs`),
      );

      for (let i = 0; i < 5; i += 1) await comCache.verify(await token());

      // Uma busca para cinco verificações. Sem cache, o caminho de
      // autenticação ficaria na dependência da latência do IdP, e um pico de
      // tráfego viraria negação de serviço contra ele.
      expect(buscas).toBe(1);
    } finally {
      contador.stop(true);
    }
  });
});
