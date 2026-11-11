import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { LOGGER, type Logger } from "./application/ports/logger";
import { WagerTransactionConsumer } from "./application/wagering/consume-wager-transactions";
import { OutboxPublisherWorker } from "./application/wagering/publish-outbox";
import { PendingReferenceWorker } from "./application/wagering/retry-pending-reference";
import { AppModule } from "./app.module";
import { loadEnv, type Env } from "./config/env";
import { DomainExceptionFilter } from "./infrastructure/http/domain-exception.filter";

async function runApi(env: Env): Promise<void> {
  const app = await NestFactory.create(AppModule.register(env), { bufferLogs: false });
  // Um unico caminho de traducao de erro para status HTTP.
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(env.PORT, "0.0.0.0");

  app.get<Logger>(LOGGER).info("api ouvindo", { port: env.PORT });
}

/**
 * O consumer nao abre servidor HTTP: `createApplicationContext` sobe o
 * container de injecao sem rotas.
 *
 * Em SIGTERM o consumer **drena** — para de buscar mensagens novas, espera as
 * em andamento concluirem, e devolve a visibilidade das que chegaram depois do
 * pedido de parada. Matar no meio de uma transacao financeira e o que isso
 * evita.
 */
async function runConsumer(env: Env): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.register(env), {
    logger: false,
  });
  const consumer = app.get(WagerTransactionConsumer);
  const logger = app.get<Logger>(LOGGER);

  let encerrando = false;
  const encerra = async (signal: string): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    logger.info("sinal recebido, drenando", { signal });
    await consumer.stop();
    await app.close();
    logger.info("encerrado com as mensagens em andamento concluidas");
    process.exit(0);
  };

  // O `.catch` nao e cosmetico: sem ele, um stop() que rejeita vira unhandled
  // rejection, `app.close()` e `process.exit(0)` nao rodam, e o container fica
  // pendurado ate o SIGKILL do fim do grace period.
  const trata = (signal: string) => (): void => {
    encerra(signal).catch((erro: unknown) => {
      logger.error("falha ao encerrar; saindo com erro", {
        signal,
        reason: erro instanceof Error ? erro.message : String(erro),
      });
      process.exit(1);
    });
  };

  process.on("SIGTERM", trata("SIGTERM"));
  process.on("SIGINT", trata("SIGINT"));

  await consumer.start();
}

/** Encerramento limpo compartilhado pelos workers sem servidor HTTP. */
function instalaEncerramento(
  logger: Logger,
  parar: () => Promise<void>,
  fechar: () => Promise<void>,
): void {
  let encerrando = false;
  const encerra = async (signal: string): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    logger.info("sinal recebido, encerrando", { signal });
    await parar();
    await fechar();
    process.exit(0);
  };

  // O `.catch` nao e cosmetico: sem ele, um stop() que rejeita vira unhandled
  // rejection, o fechamento nao roda, e o container fica pendurado ate o
  // SIGKILL do fim do grace period.
  const trata = (signal: string) => (): void => {
    encerra(signal).catch((erro: unknown) => {
      logger.error("falha ao encerrar; saindo com erro", {
        signal,
        reason: erro instanceof Error ? erro.message : String(erro),
      });
      process.exit(1);
    });
  };

  process.on("SIGTERM", trata("SIGTERM"));
  process.on("SIGINT", trata("SIGINT"));
}

/**
 * Worker que reprocessa referencia ausente. Sem servidor HTTP.
 */
async function runPendingReferenceWorker(env: Env): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.register(env), {
    logger: false,
  });
  const worker = app.get(PendingReferenceWorker);
  const logger = app.get<Logger>(LOGGER);

  instalaEncerramento(logger, () => worker.stop(), () => app.close());
  await worker.start();
}

/**
 * Worker da outbox. Como o consumer, nao abre servidor HTTP e drena no
 * SIGTERM: parar no meio de um ciclo deixaria mensagens reivindicadas com
 * lease valido, inativas ate ele expirar.
 */
async function runOutboxPublisher(env: Env): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.register(env), {
    logger: false,
  });
  const worker = app.get(OutboxPublisherWorker);
  const logger = app.get<Logger>(LOGGER);

  instalaEncerramento(logger, () => worker.stop(), () => app.close());
  await worker.start();
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  switch (env.APP_ROLE) {
    case "api":
      return runApi(env);
    case "consumer":
      return runConsumer(env);
    case "outbox":
      return runOutboxPublisher(env);
    case "reference":
      return runPendingReferenceWorker(env);
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
