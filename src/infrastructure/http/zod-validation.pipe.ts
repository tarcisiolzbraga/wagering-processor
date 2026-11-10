import { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

import { InvalidInputError } from "../../domain/shared/domain-error";

/**
 * Converte falha de schema em `InvalidInputError`, que o filtro traduz para
 * 400. Nao usa `BadRequestException` direto para que exista **um** caminho de
 * traducao de erro, e nao dois com formatos de resposta diferentes.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;

    const detalhe = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
      .join("; ");
    throw new InvalidInputError(`payload invalido — ${detalhe}`);
  }
}
