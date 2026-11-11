import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "node:net";

import { LOGGER, type Logger } from "../../src/application/ports/logger";
import { AppModule, type HttpSurface } from "../../src/app.module";
import { loadEnv } from "../../src/config/env";
import { DomainExceptionFilter } from "../../src/infrastructure/http/domain-exception.filter";

export interface TestApp {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Sobe a aplicacao Nest de verdade numa porta livre. Exercita a pilha HTTP
 * completa — pipes, filtro de excecao, middleware de correlacao — em vez de
 * chamar o use case direto: o que esta sendo testado aqui e justamente a
 * traducao entre dominio e HTTP.
 */
export async function startTestApp(
  surface: HttpSurface = "full",
  /** Sobrescreve a env do processo — usado para ligar a autenticacao. */
  envOverride: Record<string, string> = {},
): Promise<TestApp> {
  const env = loadEnv({ ...process.env, ...envOverride });
  const app: INestApplication = await NestFactory.create(
    AppModule.register(env, surface),
    // `abortOnError: false` e o que faz erro de injecao virar excecao. Com o
    // default, o Nest chama `process.exit(1)` e, com o logger desligado, o
    // processo morre **sem imprimir nada** — o boot falha em silencio.
    { logger: false, abortOnError: false },
  );
  app.useGlobalFilters(new DomainExceptionFilter(app.get<Logger>(LOGGER)));
  await app.listen(0, "127.0.0.1");

  const endereco = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${endereco.port}`,
    close: () => app.close(),
  };
}
