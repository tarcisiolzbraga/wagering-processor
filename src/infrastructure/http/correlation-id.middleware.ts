import type { NextFunction, Request, Response } from "express";

export const CORRELATION_HEADER = "x-correlation-id";

export interface WithCorrelation {
  correlationId: string;
}

/**
 * Aceita o correlationId do cliente ou gera um. Ele atravessa HTTP, outbox,
 * SQS e consumer: sem isso, investigar um incidente financeiro significa
 * costurar logs de tres sistemas sem ligacao entre eles.
 *
 * Volta no header da resposta para que o provedor possa citar o mesmo id ao
 * abrir um ticket.
 */
export function correlationIdMiddleware(
  req: Request & Partial<WithCorrelation>,
  res: Response,
  next: NextFunction,
): void {
  const recebido = req.headers[CORRELATION_HEADER];
  const correlationId =
    typeof recebido === "string" && recebido.trim().length > 0
      ? recebido.trim()
      : crypto.randomUUID();

  req.correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  next();
}

export function correlationIdOf(req: Request & Partial<WithCorrelation>): string {
  return req.correlationId ?? crypto.randomUUID();
}
