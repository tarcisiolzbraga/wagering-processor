import "reflect-metadata";

import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "../../../src/app.module";
import { loadEnv } from "../../../src/config/env";

/**
 * Sobe a fiacao real da aplicacao no processo filho, sem servidor HTTP.
 *
 * O filho usa o mesmo `AppModule` da producao de proposito: um harness que
 * monta as dependencias a mao testaria a montagem do harness. O que precisa
 * valer aqui e que **a aplicacao como ela sobe** esta correta com replicas.
 */
export async function abreContexto(): Promise<INestApplicationContext> {
  // `abortOnError: false`: sem ele, um erro de injecao chama `process.exit(1)`
  // sem imprimir nada, e o filho morre sem diagnostico nenhum.
  return NestFactory.createApplicationContext(AppModule.register(loadEnv()), {
    logger: false,
    abortOnError: false,
  });
}
