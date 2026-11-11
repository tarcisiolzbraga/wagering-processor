import { Migration } from "@mikro-orm/migrations";

/**
 * Agendamento do reprocessamento de referencia ausente.
 *
 * Sem uma coluna de "proxima tentativa", o worker varreria todas as
 * PENDING_REFERENCE a cada ciclo e tentaria de novo imediatamente — o backoff
 * exponencial nao existiria na pratica, e uma referencia que vai demorar horas
 * para chegar consumiria as 15 tentativas em segundos.
 */
export class Migration20261111150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions
      add column next_reference_attempt_at timestamptz`);

    // A coluna so faz sentido enquanto a transacao aguarda referencia.
    this.addSql(`alter table wager_transactions
      add constraint wager_transactions_next_reference_attempt_scope
      check (status = 'PENDING_REFERENCE' or next_reference_attempt_at is null)`);

    // A coluna nova precisa entrar na lista de mutaveis do trigger de
    // imutabilidade. O default dele e tratar coluna desconhecida como
    // imutavel — o lado seguro — e foi isso que barrou a primeira versao
    // desta fase, corretamente.
    this.addSql(`create or replace function reject_wager_transaction_rewrite()
      returns trigger as $$
      declare mutaveis text[] := array[
        'status', 'failure_code', 'observed_balance_amount',
        'reference_transaction_id', 'reference_attempts',
        'pending_reference_since', 'next_reference_attempt_at', 'processed_at'
      ];
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception 'wager_transactions e append-only: % recusado', tg_op
            using errcode = 'restrict_violation';
        end if;

        if (to_jsonb(old) - mutaveis) <> (to_jsonb(new) - mutaveis) then
          raise exception
            'colunas de identidade da transacao % sao imutaveis', old.id
            using errcode = 'restrict_violation';
        end if;

        if old.status in ('PROCESSED','REJECTED','FAILED')
           and new.status <> old.status then
          raise exception
            'status terminal % da transacao % nao muda mais', old.status, old.id
            using errcode = 'restrict_violation';
        end if;

        return new;
      end;
      $$ language plpgsql`);

    // Substitui o indice antigo: a fila do worker e o que esta **vencido**,
    // nao tudo que aguarda.
    this.addSql(`drop index if exists wager_transactions_pending_reference`);
    this.addSql(`create index wager_transactions_pending_reference
      on wager_transactions (next_reference_attempt_at nulls first, pending_reference_since)
      where status = 'PENDING_REFERENCE'`);
  }

  override async down(): Promise<void> {
    // Volta a lista de mutaveis sem a coluna nova.
    this.addSql(`create or replace function reject_wager_transaction_rewrite()
      returns trigger as $$
      declare mutaveis text[] := array[
        'status', 'failure_code', 'observed_balance_amount',
        'reference_transaction_id', 'reference_attempts',
        'pending_reference_since', 'processed_at'
      ];
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception 'wager_transactions e append-only: % recusado', tg_op
            using errcode = 'restrict_violation';
        end if;

        if (to_jsonb(old) - mutaveis) <> (to_jsonb(new) - mutaveis) then
          raise exception
            'colunas de identidade da transacao % sao imutaveis', old.id
            using errcode = 'restrict_violation';
        end if;

        if old.status in ('PROCESSED','REJECTED','FAILED')
           and new.status <> old.status then
          raise exception
            'status terminal % da transacao % nao muda mais', old.status, old.id
            using errcode = 'restrict_violation';
        end if;

        return new;
      end;
      $$ language plpgsql`);

    this.addSql(`drop index if exists wager_transactions_pending_reference`);
    this.addSql(`create index wager_transactions_pending_reference
      on wager_transactions (pending_reference_since)
      where status = 'PENDING_REFERENCE'`);
    this.addSql(`alter table wager_transactions
      drop constraint if exists wager_transactions_next_reference_attempt_scope`);
    this.addSql(`alter table wager_transactions
      drop column if exists next_reference_attempt_at`);
  }
}
