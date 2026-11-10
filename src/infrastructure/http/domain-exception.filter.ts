import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { Request, Response } from "express";

import type { WithCorrelation } from "./correlation-id.middleware";

import { FailureKind, classifyFailure } from "../../application/shared/failure-classification";
import {
  DomainRuleViolationError,
  InvalidInputError,
} from "../../domain/shared/domain-error";

/** Quanto o provedor deve esperar antes de reenviar numa falha transitoria. */
const RETRY_AFTER_SECONDS = 2;

interface ErrorBody {
  readonly error: string;
  readonly message: string;
  readonly failureCode?: string;
  readonly retryable: boolean;
}

/**
 * Traducao unica de erro para status. O enunciado exige que a API distinga com
 * clareza payload invalido, conflito, rejeicao de negocio, aceite pendente e
 * falha transitoria — colapsar isso obriga o provedor a ler mensagem de erro
 * para decidir se pode reenviar, o que e a diferenca entre uma integracao que
 * se recupera sozinha e uma que gera ticket.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & Partial<WithCorrelation>>();

    const { status, body } =
      exception instanceof HttpException
        ? {
            // Excecoes do proprio Nest (404 de rota, por exemplo).
            status: exception.getStatus(),
            body: exception.getResponse() as ErrorBody,
          }
        : this.traduz(exception);

    // Fora do `if`: um 503 levantado como ServiceUnavailableException tambem
    // precisa do header que o mapa de status promete.
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    }

    this.registra(status, exception, request);
    response.status(status).json(body);
  }

  /**
   * Um filtro global com `@Catch()` faz o Nest considerar a excecao tratada,
   * entao o `BaseExceptionFilter` — o unico que loga mensagem e stack — nunca
   * roda. Sem este log, **todo 500 e 503 nao deixava diagnostico nenhum**.
   *
   * Erro de cliente (4xx) nao e logado: e ruido, e a resposta ja diz tudo.
   */
  private registra(
    status: number,
    exception: unknown,
    request: Request & Partial<WithCorrelation>,
  ): void {
    if (status < HttpStatus.INTERNAL_SERVER_ERROR && status !== HttpStatus.SERVICE_UNAVAILABLE) {
      return;
    }

    console.error(
      JSON.stringify({
        level: "error",
        msg: "requisicao falhou",
        status,
        method: request.method,
        path: request.url,
        correlationId: request.correlationId,
        error: exception instanceof Error ? exception.name : typeof exception,
        // Sem payload financeiro: a mensagem do erro de dominio e suficiente.
        reason: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      }),
    );
  }

  private traduz(exception: unknown): { status: number; body: ErrorBody } {
    const message = exception instanceof Error ? exception.message : String(exception);

    if (exception instanceof InvalidInputError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { error: "INVALID_PAYLOAD", message, retryable: false },
      };
    }

    if (exception instanceof DomainRuleViolationError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        body: {
          error: "BUSINESS_RULE_VIOLATION",
          message,
          failureCode: exception.failureCode,
          retryable: false,
        },
      };
    }

    if (classifyFailure(exception) === FailureKind.Transient) {
      // Culpa nossa, e reenviar **vai** funcionar.
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: {
          error: "TRANSIENT_FAILURE",
          message: "falha transitoria de infraestrutura",
          retryable: true,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: "INTERNAL_ERROR", message: "erro interno", retryable: false },
    };
  }
}
