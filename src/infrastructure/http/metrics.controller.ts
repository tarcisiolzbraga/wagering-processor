import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { Response } from "express";

import { METRICS, type Metrics } from "../../application/ports/metrics";

/**
 * Exposicao no formato de texto do Prometheus.
 *
 * Aberto, como os health checks: um scraper nao carrega credencial de
 * provedor, e metrica agregada nao contem dado de operacao — os valores
 * monetarios nunca entram em label nem em valor de serie.
 */
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  @Get()
  @Header("Cache-Control", "no-store")
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader("Content-Type", this.metrics.contentType);
    return this.metrics.render();
  }
}
