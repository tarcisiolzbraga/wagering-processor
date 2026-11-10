import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "node:net";

import { AppModule } from "../../src/app.module";
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
export async function startTestApp(): Promise<TestApp> {
  const app: INestApplication = await NestFactory.create(AppModule.register(loadEnv()), {
    logger: false,
  });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, "127.0.0.1");

  const endereco = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${endereco.port}`,
    close: () => app.close(),
  };
}
