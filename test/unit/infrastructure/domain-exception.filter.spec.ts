import { afterEach, describe, expect, it } from "bun:test";
import { HttpStatus, ServiceUnavailableException, NotFoundException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";

import {
  DomainRuleViolationError,
  InvalidInputError,
  InvariantViolationError,
} from "../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { DomainExceptionFilter } from "../../../src/infrastructure/http/domain-exception.filter";

interface RespostaFake {
  statusCode?: number;
  corpo?: unknown;
  headers: Record<string, string>;
}

function hostFake(): { host: ArgumentsHost; res: RespostaFake } {
  const res: RespostaFake = { headers: {} };
  const response = {
    status(codigo: number) {
      res.statusCode = codigo;
      return this;
    },
    json(corpo: unknown) {
      res.corpo = corpo;
      return this;
    },
    setHeader(chave: string, valor: string) {
      res.headers[chave] = valor;
    },
  };
  const request = { method: "POST", url: "/wagering/transactions", correlationId: "corr-1" };

  return {
    host: {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as unknown as ArgumentsHost,
    res,
  };
}

const original = console.error;
afterEach(() => {
  console.error = original;
});

function capturaLogs(): string[] {
  const linhas: string[] = [];
  console.error = (...args: unknown[]) => {
    linhas.push(args.map(String).join(" "));
  };
  return linhas;
}

const filtro = new DomainExceptionFilter();

describe("traducao de erro para status", () => {
  it("InvalidInputError vira 400 nao-retentavel", () => {
    const { host, res } = hostFake();
    capturaLogs();
    filtro.catch(new InvalidInputError("escala errada"), host);

    expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(res.corpo).toMatchObject({ error: "INVALID_PAYLOAD", retryable: false });
  });

  it("DomainRuleViolationError vira 422 com failureCode", () => {
    const { host, res } = hostFake();
    capturaLogs();
    filtro.catch(
      new DomainRuleViolationError(FailureCode.InsufficientFunds, "sem saldo"),
      host,
    );

    expect(res.statusCode).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(res.corpo).toMatchObject({
      error: "BUSINESS_RULE_VIOLATION",
      failureCode: FailureCode.InsufficientFunds,
      retryable: false,
    });
  });

  it("falha transitoria vira 503 com Retry-After", () => {
    const { host, res } = hostFake();
    capturaLogs();
    filtro.catch(Object.assign(new Error("deadlock"), { code: "40P01" }), host);

    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.headers["Retry-After"]).toBe("2");
    expect(res.corpo).toMatchObject({ error: "TRANSIENT_FAILURE", retryable: true });
  });

  it("invariante violada vira 500 sem vazar detalhe interno", () => {
    const { host, res } = hostFake();
    capturaLogs();
    filtro.catch(new InvariantViolationError("saldo mudou sob o lock"), host);

    expect(res.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(res.corpo)).not.toContain("saldo mudou sob o lock");
  });

  it("HttpException do Nest passa com o proprio status", () => {
    const { host, res } = hostFake();
    capturaLogs();
    filtro.catch(new NotFoundException({ error: "WALLET_NOT_FOUND" }), host);

    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(res.corpo).toMatchObject({ error: "WALLET_NOT_FOUND" });
  });

  it("503 levantado como HttpException tambem leva Retry-After", () => {
    // O short-circuit de HttpException saía antes de setar o header, e o mapa
    // de status do README promete o Retry-After em todo 503.
    const { host, res } = hostFake();
    capturaLogs();
    filtro.catch(new ServiceUnavailableException({ error: "NOT_READY" }), host);

    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.headers["Retry-After"]).toBe("2");
  });
});

describe("diagnostico", () => {
  // Um filtro global com @Catch() faz o Nest considerar a excecao tratada,
  // entao o BaseExceptionFilter — o unico que loga stack — nunca roda. Sem log
  // proprio, todo 500 e 503 ficava sem diagnostico nenhum.
  it("loga 500 com correlationId, caminho e stack", () => {
    const { host } = hostFake();
    const linhas = capturaLogs();
    filtro.catch(new InvariantViolationError("bug interno"), host);

    expect(linhas).toHaveLength(1);
    const registro = JSON.parse(linhas[0]!) as Record<string, unknown>;
    expect(registro["status"]).toBe(500);
    expect(registro["correlationId"]).toBe("corr-1");
    expect(registro["path"]).toBe("/wagering/transactions");
    expect(registro["stack"]).toBeTypeOf("string");
  });

  it("loga 503 tambem", () => {
    const { host } = hostFake();
    const linhas = capturaLogs();
    filtro.catch(Object.assign(new Error("conexao caiu"), { code: "EPIPE" }), host);
    expect(linhas).toHaveLength(1);
  });

  it("nao loga erro de cliente: seria ruido", () => {
    const { host } = hostFake();
    const linhas = capturaLogs();
    filtro.catch(new InvalidInputError("payload ruim"), host);
    filtro.catch(new DomainRuleViolationError(FailureCode.InsufficientFunds, "sem saldo"), host);
    expect(linhas).toHaveLength(0);
  });
});
