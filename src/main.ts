import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";

const NOT_YET_IMPLEMENTED: Record<string, string> = {
  consumer: "Fase 6",
  outbox: "Fase 7",
  reference: "Fase 8",
};

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  if (env.APP_ROLE !== "api") {
    const phase = NOT_YET_IMPLEMENTED[env.APP_ROLE];
    throw new Error(`APP_ROLE=${env.APP_ROLE} ainda nao implementado (chega na ${phase}).`);
  }

  const app = await NestFactory.create(AppModule.register(env), { bufferLogs: false });
  app.enableShutdownHooks();
  await app.listen(env.PORT, "0.0.0.0");

  console.log(
    JSON.stringify({
      level: "info",
      msg: "api ouvindo",
      role: env.APP_ROLE,
      port: env.PORT,
      pid: process.pid,
    }),
  );
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
