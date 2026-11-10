import { Type } from "@mikro-orm/core";

/**
 * Mapeia a coluna `numeric` como **string decimal exata**, nunca como number.
 *
 * O driver do PostgreSQL ja devolve numeric como string justamente para nao
 * perder precisao. Este tipo torna isso explicito e **falha alto** se algum dia
 * chegar um number: nesse ponto a precisao ja foi perdida em silencio, e um
 * ledger que arredonda sem avisar e pior que um que estoura.
 *
 * A coluna e `numeric` sem escala declarada de proposito — ver ARCHITECTURE.md
 * secao 6: numeric(20,2) arredondaria 3 casas em vez de rejeitar. A escala e
 * garantida por CHECK no schema e por `Money` na entrada.
 */
export class MoneyAmountType extends Type<string | undefined, string | undefined> {
  override getColumnType(): string {
    return "numeric";
  }

  /** Comparacao do Unit of Work em string: exata, sem conversao intermediaria. */
  override compareAsType(): string {
    return "string";
  }

  override convertToDatabaseValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      throw new TypeError(
        `valor monetario deve chegar a persistencia como string decimal, recebido ${typeof value}`,
      );
    }
    return value;
  }

  override convertToJSValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "number") {
      throw new TypeError(
        `coluna numeric chegou como number (${value}): a precisao ja foi perdida antes desta camada`,
      );
    }
    return String(value);
  }
}
