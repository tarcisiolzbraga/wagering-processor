import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";

import { ENV, type Env } from "../../../config/env";

export interface ProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface ReadinessResult {
  readonly ok: boolean;
  readonly probes: readonly ProbeResult[];
}

/**
 * Readiness responde "me manda trafego?" — e isso depende de PostgreSQL e SQS
 * estarem alcancaveis. Liveness responde "me reinicia?" e nao olha dependencia
 * externa: juntar os dois transformaria uma indisponibilidade momentanea do
 * banco em restart loop.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async check(): Promise<ReadinessResult> {
    const probes = await Promise.all([
      this.probe("postgres", () => this.orm.em.getConnection().execute("select 1")),
      this.probe("schema", () => this.confereSchema()),
      this.probe("sqs", () =>
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.env.SQS_QUEUE_URL,
            AttributeNames: ["QueueArn"],
          }),
        ),
      ),
    ]);

    return { ok: probes.every((probe) => probe.ok), probes };
  }

  /**
   * Banco alcancavel nao e banco pronto.
   *
   * Com `select 1` sozinho, uma instancia apontada para um banco **sem
   * migrations** respondia `200 ready` e so falhava na primeira operacao de
   * negocio, com 500. Readiness existe para responder "me manda trafego?", e
   * sem schema a resposta e nao: o balanceador precisa saber disso antes de
   * mandar a primeira aposta, nao depois.
   */
  private async confereSchema(): Promise<void> {
    const pendentes = await this.orm.getMigrator().getPendingMigrations();
    if (pendentes.length > 0) {
      const nomes = pendentes.map((m) => m.name).join(", ");
      throw new Error(`migrations pendentes: ${nomes}`);
    }
  }

  private async probe(name: string, run: () => Promise<unknown>): Promise<ProbeResult> {
    const startedAt = performance.now();
    try {
      await run();
      return { name, ok: true, latencyMs: Math.round(performance.now() - startedAt) };
    } catch (error: unknown) {
      return {
        name,
        ok: false,
        latencyMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
