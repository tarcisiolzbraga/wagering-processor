/**
 * Extrai o nome da constraint de uma violacao de unicidade (SQLSTATE 23505).
 *
 * O MikroORM embrulha o erro do driver, e o original fica em `previous` ou
 * `cause` dependendo do caminho. Olhar os tres niveis evita depender da forma
 * exata do embrulho, que e detalhe interno da biblioteca.
 */
export function uniqueViolationConstraint(error: unknown): string | undefined {
  const candidatos: unknown[] = [
    error,
    (error as { previous?: unknown } | null)?.previous,
    (error as { cause?: unknown } | null)?.cause,
  ];

  for (const candidato of candidatos) {
    const e = candidato as { code?: unknown; constraint?: unknown } | null | undefined;
    if (e?.code === "23505" && typeof e.constraint === "string") {
      return e.constraint;
    }
  }
  return undefined;
}
