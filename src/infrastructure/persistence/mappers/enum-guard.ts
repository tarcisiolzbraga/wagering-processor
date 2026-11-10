import { InvariantViolationError } from "../../../domain/shared/domain-error";

/**
 * Converte string vinda do banco em membro de enum, falhando com erro de
 * dominio se o valor for desconhecido.
 *
 * O dominio ja falha de forma segura diante de um enum que nao conhece, mas
 * validar na fronteira de leitura da uma mensagem precisa — qual coluna, qual
 * valor, qual registro — em vez de um erro generico tres camadas adiante.
 */
export function asEnum<T extends Record<string, string>>(
  enumObj: T,
  value: string,
  field: string,
  recordId: string,
): T[keyof T] {
  const valores = Object.values(enumObj) as string[];
  if (!valores.includes(value)) {
    throw new InvariantViolationError(
      `valor desconhecido na coluna ${field} do registro ${recordId}: ${JSON.stringify(value)} (esperado um de ${valores.join(", ")})`,
    );
  }
  return value as T[keyof T];
}
