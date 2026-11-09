import { MikroORM } from "@mikro-orm/postgresql";

import { buildOrmConfig } from "./mikro-orm.config";

/**
 * Driver de migrations pela API do Migrator, nao pelo binario `mikro-orm`.
 * O CLI do MikroORM assume ts-node; sob Bun isso e atrito desnecessario,
 * e a API faz exatamente o mesmo trabalho.
 */
const USAGE = `uso: bun run db <comando>

  up                aplica as migrations pendentes
  down              reverte a ultima migration aplicada
  create <nome>     cria uma migration vazia e versionada
  list              lista o que esta aplicado e o que esta pendente
  fresh             dropa o schema e reaplica tudo (bloqueado em producao)`;

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.log(USAGE);
    return 1;
  }

  const orm = await MikroORM.init(buildOrmConfig());
  const migrator = orm.getMigrator();

  try {
    switch (command) {
      case "up": {
        const applied = await migrator.up();
        console.log(applied.length ? `aplicadas ${applied.length}:` : "nada pendente");
        applied.forEach((m) => console.log(`  + ${m.name}`));
        return 0;
      }
      case "down": {
        const reverted = await migrator.down();
        console.log(reverted.length ? `revertidas ${reverted.length}:` : "nada a reverter");
        reverted.forEach((m) => console.log(`  - ${m.name}`));
        return 0;
      }
      case "create": {
        const name = args[0];
        if (!name) {
          console.error("faltou o nome: bun run db create add_wallets_table");
          return 1;
        }
        const result = await migrator.createMigration(undefined, true, false, name);
        console.log(`criada: ${result.fileName}`);
        return 0;
      }
      case "list": {
        const [executed, pending] = await Promise.all([
          migrator.getExecutedMigrations(),
          migrator.getPendingMigrations(),
        ]);
        console.log(`aplicadas (${executed.length}):`);
        executed.forEach((m) => console.log(`  + ${m.name}`));
        console.log(`pendentes (${pending.length}):`);
        pending.forEach((m) => console.log(`  . ${m.name}`));
        return 0;
      }
      case "fresh": {
        if (process.env["NODE_ENV"] === "production") {
          console.error("fresh e bloqueado em producao");
          return 1;
        }
        await orm.getSchemaGenerator().dropSchema();
        await migrator.up();
        console.log("schema recriado e migrations reaplicadas");
        return 0;
      }
      default:
        console.error(`comando desconhecido: ${command}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await orm.close(true);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
