import { Migration } from "@mikro-orm/migrations";

/**
 * Lease e abandono na outbox.
 *
 * A alternativa ao lease seria manter a transacao SQL aberta durante o envio ao
 * SQS: o `FOR UPDATE SKIP LOCKED` seguraria a linha do inicio ao fim e nao
 * haveria publicacao duplicada. Mas isso amarra o tempo de vida de um lock e de
 * uma conexao de banco a latencia de um terceiro — uma chamada pendurada ao SQS
 * vira uma transacao pendurada, que atrasa vacuum e consome pool.
 *
 * Com lease: reivindicacao em transacao curta, publicacao fora de transacao,
 * marcacao em outra transacao curta. Um publisher que morre entre publicar e
 * marcar deixa o lease expirar e outro assume — publicacao duplicada, que o
 * enunciado tolera e o consumidor deduplica pelo eventId.
 *
 * `abandoned_at` e a saida para o evento que **nunca** vai publicar (corpo
 * acima do limite do broker, fila errada). Sem ele, essa linha seria
 * reivindicada para sempre e fixaria a metrica de outbox lag no teto,
 * mascarando um publisher realmente travado.
 */
export class Migration20261111110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table outbox_messages
      add column locked_until timestamptz,
      add column locked_by    text,
      add column abandoned_at timestamptz,
      add column last_error   text`);

    this.addSql(`alter table outbox_messages
      add constraint outbox_messages_lease_consistent
      check ((locked_until is null) = (locked_by is null))`);

    // Abandonada nao pode estar publicada: sao destinos mutuamente exclusivos.
    this.addSql(`alter table outbox_messages
      add constraint outbox_messages_abandoned_not_published
      check (abandoned_at is null or published_at is null)`);

    // O indice de reivindicacao passa a excluir tambem as abandonadas.
    // `locked_until` fica fora dele de proposito: a condicao do claim e
    // `locked_until is null or locked_until <= now()`, e um OR assim nao
    // aproveita indice parcial — incluir a coluna so adicionaria escrita.
    this.addSql(`drop index if exists outbox_messages_claimable`);
    this.addSql(`create index outbox_messages_claimable
      on outbox_messages (next_attempt_at nulls first, occurred_at, id)
      where published_at is null and abandoned_at is null`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists outbox_messages_claimable`);
    this.addSql(`create index outbox_messages_claimable
      on outbox_messages (next_attempt_at nulls first, occurred_at)
      where published_at is null`);
    this.addSql(`alter table outbox_messages
      drop constraint if exists outbox_messages_abandoned_not_published,
      drop constraint if exists outbox_messages_lease_consistent`);
    this.addSql(`alter table outbox_messages
      drop column if exists last_error,
      drop column if exists abandoned_at,
      drop column if exists locked_by,
      drop column if exists locked_until`);
  }
}
