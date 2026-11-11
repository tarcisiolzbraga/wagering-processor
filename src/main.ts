import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import type { Logger } from "./application/ports/logger";
import { WagerTransactionConsumer } from "./application/wagering/consume-wager-transactions";
import { OutboxPublisherWorker } from "./application/wagering/publish-outbox";
import { PendingReferenceWorker } from "./application/wagering/retry-pending-reference";
import { AppModule } from "./app.module";
import { loadEnv, type Env } from "./config/env";
import { DomainExceptionFilter } from "./infrastructure/http/domain-exception.filter";
import { createLogger } from "./infrastructure/observability/create-logger";
import { NestLoggerBridge } from "./infrastructure/observability/nest-logger";

async function runApi(env: Env): Promise<void> {
  const logger = createLogger(env);
  const app = await NestFactory.create(AppModule.register(env), {
    // O logger do proprio Nest tambem passa pelo pino: uma linha em prosa
    // colorida no meio de um stream JSON e uma linha que o agregador perde.
    logger: new NestLoggerBridge(logger),
  });
  // Um unico caminho de traducao de erro para status HTTP.
  app.useGlobalFilters(new DomainExceptionFilter(logger));
  app.enableShutdownHooks();
  await app.listen(env.PORT, "0.0.0.0");

  logger.info("api ouvindo", { port: env.PORT });
}

/**
 * Em SIGTERM o consumer **drena** — para de buscar mensagens novas, espera as
 * em andamento concluirem, e devolve a visibilidade das que chegaram depois do
 * pedido de parada. Matar no meio de uma transacao financeira e o que isso
 * evita.
 */
async function runConsumer(env: Env): Promise<void> {
  const { app, logger } = await abreWorker(env);
  const consumer = app.get(WagerTransactionConsumer);

  instalaEncerramento(logger, () => consumer.stop(), () => app.close());
  await consumer.start();
}

/**
 * Sobe um worker com superficie HTTP **minima**: so `/metrics` e os health
 * checks, nenhum endpoint de negocio.
 *
 * Metrica que so existe no processo da API deixa cego justamente o lado onde a
 * falha e silenciosa: publisher parado, consumer em loop de retry.
 */
async function abreWorker(env: Env): Promise<{ app: INestApplication; logger: Logger }> {
  const logger = createLogger(env);
  const app = await NestFactory.create(AppModule.register(env, "observability-only"), {
    logger: new NestLoggerBridge(logger),
  });
  app.useGlobalFilters(new DomainExceptionFilter(logger));
  await app.listen(env.PORT, "0.0.0.0");

  logger.info("worker ouvindo para observabilidade", { port: env.PORT });
  return { app, logger };
}

/** Encerramento limpo compartilhado pelos workers. */
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

/** Worker que reprocessa referencia ausente. */
async function runPendingReferenceWorker(env: Env): Promise<void> {
  const { app, logger } = await abreWorker(env);
  const worker = app.get(PendingReferenceWorker);

  instalaEncerramento(logger, () => worker.stop(), () => app.close());
  await worker.start();
}

/**
 * Worker da outbox. Como o consumer, drena no SIGTERM: parar no meio de um
 * ciclo deixaria mensagens reivindicadas com lease valido, inativas ate ele
 * expirar.
 */
async function runOutboxPublisher(env: Env): Promise<void> {
  const { app, logger } = await abreWorker(env);
  const worker = app.get(OutboxPublisherWorker);

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
