import { Controller, Get, HttpCode, ServiceUnavailableException } from "@nestjs/common";

import { ReadinessService } from "./readiness.service";

/** Os dois endpoints ficam abertos — readiness precisa funcionar com o IdP fora. */
@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get("live")
  @HttpCode(200)
  live(): { status: "ok"; uptimeSeconds: number } {
    return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ok"; probes: readonly unknown[] }> {
    const result = await this.readiness.check();
    const body = { status: "ok" as const, probes: result.probes };
    if (!result.ok) {
      throw new ServiceUnavailableException({ status: "unavailable", probes: result.probes });
    }
    return body;
  }
}
