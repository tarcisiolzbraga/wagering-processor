import { z } from "zod";

/**
 * Toda configuracao passa por aqui. Processo com env invalida nao sobe:
 * falhar no boot e barato, falhar no meio de uma transacao financeira nao e.
 */
const schema = z.object({
  APP_ROLE: z.enum(["api", "consumer", "outbox", "reference"]).default("api"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),

  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_ENDPOINT: z.string().url(),
  SQS_QUEUE_URL: z.string().url(),
  SQS_DLQ_URL: z.string().url(),
  /**
   * Destino dos eventos de integracao. O enunciado define a fila de entrada e
   * a DLQ dela; os eventos publicados pela outbox precisam de um destino
   * proprio, senao nao ha onde publicar.
   *
   * A DLQ dos eventos nao aparece aqui de proposito: ela e ligada por
   * RedrivePolicy na criacao da fila, e nenhum codigo da aplicacao a endereca.
   * Exigir uma variavel sem efeito seria so uma forma de o processo nao subir.
   */
  SQS_EVENTS_QUEUE_URL: z.string().url(),

  AUTH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  KEYCLOAK_ISSUER_URL: z.string().url(),
  KEYCLOAK_AUDIENCE: z.string().min(1),
});

export type Env = z.infer<typeof schema>;

/** Token de injecao — o dominio nao conhece Env, so a borda conhece. */
export const ENV = Symbol("ENV");

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Configuracao de ambiente invalida:\n${issues}`);
}
