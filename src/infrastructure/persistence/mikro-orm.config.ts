import { Migrator } from "@mikro-orm/migrations";
import { UnderscoreNamingStrategy } from "@mikro-orm/core";
import { defineConfig } from "@mikro-orm/postgresql";

import { entitySchemas } from "./entities";

import { loadEnv, type Env } from "../../config/env";

/**
 * `disableDynamicFileAccess` desliga a descoberta de entidades por glob:
 * cada EntitySchema e registrado explicitamente abaixo. Isso mantem o boot
 * deterministico e evita o acesso dinamico a arquivos, que e o ponto de
 * atrito conhecido entre MikroORM e Bun.
 */
export function buildOrmConfig(env: Env = loadEnv()) {
  return defineConfig({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    dbName: env.POSTGRES_DB,

    entities: entitySchemas,
    discovery: { disableDynamicFileAccess: true, warnWhenNoEntities: false },

    // Evita repetir `fieldName` em cada propriedade: o schema e snake_case e
    // o codigo e camelCase. Nomes de tabela continuam explicitos no schema.
    namingStrategy: UnderscoreNamingStrategy,

    extensions: [Migrator],
    migrations: {
      path: "./src/infrastructure/persistence/migrations",
      pathTs: "./src/infrastructure/persistence/migrations",
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      emit: "ts",
      snapshot: false,
    },

    debug: env.LOG_LEVEL === "debug",
  });
}
