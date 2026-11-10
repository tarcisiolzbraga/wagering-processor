/**
 * Gerador de identificadores. A implementacao usa UUIDv7, que e ordenado no
 * tempo: ids sequenciais reduzem fragmentacao de indice e fazem o cursor
 * `(created_at, id)` desempatar na ordem natural de criacao.
 */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol("ID_GENERATOR");
