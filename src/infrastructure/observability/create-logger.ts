import type { Logger } from "../../application/ports/logger";
import type { Env } from "../../config/env";
import { PinoLogger } from "./pino-logger";

/**
 * Uma instancia por processo, compartilhada entre o container do Nest e o
 * bootstrap. O bootstrap precisa do logger **antes** de o container existir —
 * e duas instancias dariam dois streams concorrendo pelo mesmo descritor.
 */
let instancia: Logger | undefined;

export function createLogger(env: Env): Logger {
  // Memoizado porque ha dois chamadores por processo — o bootstrap e o
  // container. Duas instancias seriam dois streams assincronos sobre o mesmo
  // descritor: sem ordem garantida entre as linhas e com risco de intercalar
  // no meio de uma linha longa.
  instancia ??= PinoLogger.create(env.LOG_LEVEL, { role: env.APP_ROLE, pid: process.pid });
  return instancia;
}
