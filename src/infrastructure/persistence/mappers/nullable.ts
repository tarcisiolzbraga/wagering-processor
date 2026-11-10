/**
 * O MikroORM devolve `null` para coluna nullable, nao `undefined`, enquanto o
 * dominio modela ausencia com `undefined`. A traducao fica aqui, num lugar so:
 * sem ela, uma checagem `=== undefined` passa batido em cima de um `null` e o
 * valor segue adiante como se existisse.
 */
export const toUndefined = <T>(value: T | null | undefined): T | undefined =>
  value ?? undefined;

export const toNull = <T>(value: T | null | undefined): T | null => value ?? null;
