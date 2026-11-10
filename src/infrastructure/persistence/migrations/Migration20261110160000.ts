import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e nao-negatividade
 * vivem aqui, nao apenas no codigo da aplicacao: o banco e o unico componente
 * por onde toda escrita obrigatoriamente passa. Instancias da aplicacao sao
 * multiplas, reiniciam, tem versoes diferentes durante um deploy e podem ser
 * contornadas por um script. O PostgreSQL nao.
 *
 * Constraint de aplicacao e ergonomia: devolve erro bom e rapido.
 * Constraint de banco e garantia.
 */
export class Migration20261110160000 extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- enums
    // Enum nativo em vez de text + CHECK: o banco passa a recusar valor fora
    // do vocabulario do dominio. O custo e ALTER TYPE para adicionar valor,
    // aceitavel num vocabulario fechado como este.
    this.addSql(`create type wager_transaction_kind as enum
      ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')`);
    this.addSql(`create type wager_transaction_source as enum
      ('INTERNAL','API','QUEUE')`);
    this.addSql(`create type wager_transaction_status as enum
      ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')`);
    this.addSql(`create type ledger_direction as enum ('DEBIT','CREDIT')`);

    // -------------------------------------------------------------- wallets
    //
    // Dinheiro em `numeric` SEM escala declarada, com CHECK de escala.
    //
    // numeric(20,2) parece a escolha obvia, mas ele **arredonda** uma entrada
    // de 3 casas em vez de rejeitar: "10.999" entra como 11.00 sem reclamar.
    // Arredondar dinheiro em silencio e inventar valor. Com `numeric` puro +
    // CHECK (scale(x) <= 2) o banco **recusa** a escala errada, e um CHECK de
    // magnitude recupera a garantia de capacidade que o (20,2) dava.
    this.addSql(`create table wallets (
      id              uuid        not null,
      player_id       uuid        not null,
      currency        char(3)     not null,
      balance_amount  numeric     not null,
      version         integer     not null,
      created_at      timestamptz not null,
      updated_at      timestamptz not null,
      constraint wallets_pkey primary key (id),
      constraint wallets_player_currency_unique unique (player_id, currency),
      -- Alvo do FK composto do ledger: amarra a moeda do lancamento a moeda
      -- da carteira de forma declarativa, sem trigger.
      constraint wallets_id_currency_unique unique (id, currency),
      constraint wallets_balance_non_negative check (balance_amount >= 0),
      constraint wallets_balance_scale check (scale(balance_amount) <= 2),
      constraint wallets_balance_capacity
        check (balance_amount < 1000000000000000000),
      constraint wallets_currency_shape check (currency ~ '^[A-Z]{3}$'),
      constraint wallets_version_positive check (version >= 1)
    )`);

    // --------------------------------------------------- wager_transactions
    this.addSql(`create table wager_transactions (
      id                                uuid                     not null,
      provider_id                       text                     not null,
      external_transaction_id           text                     not null,
      idempotency_key                   text                     not null,
      payload_hash                      text                     not null,
      wallet_id                         uuid                     not null,
      player_id                         uuid                     not null,
      round_id                          text                     not null,
      game_id                           text                     not null,
      kind                              wager_transaction_kind   not null,
      source                            wager_transaction_source not null,
      money_amount                      numeric                  not null,
      money_currency                    char(3)                  not null,
      reference_external_transaction_id text,
      reference_transaction_id          uuid,
      status                            wager_transaction_status not null,
      failure_code                      text,
      observed_balance_amount           numeric,
      reference_attempts                integer                  not null default 0,
      pending_reference_since           timestamptz,
      created_at                        timestamptz              not null,
      processed_at                      timestamptz,

      constraint wager_transactions_pkey primary key (id),
      -- FK composto: a moeda da operacao tem que ser a moeda da carteira.
      -- Com um FK so em (wallet_id), uma transacao em USD poderia apontar
      -- para uma carteira em BRL, e o conflito de moeda ficaria dependendo
      -- apenas da checagem em codigo.
      constraint wager_transactions_wallet_fkey
        foreign key (wallet_id, money_currency) references wallets (id, currency),
      constraint wager_transactions_reference_fkey
        foreign key (reference_transaction_id) references wager_transactions (id),

      -- Base da idempotencia. O insert-first usa esta constraint como teste de
      -- existencia, e o bloqueio no indice serializa as duplicatas paralelas.
      constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
      constraint wager_transactions_provider_external_unique
        unique (provider_id, external_transaction_id),
      -- Alvo do FK composto do ledger: o lancamento so pode apontar para a
      -- transacao se concordar com a wallet e a moeda dela.
      constraint wager_transactions_id_wallet_currency_unique
        unique (id, wallet_id, money_currency),

      -- OPENING e interno: nao pode ser submetido pela API nem pela fila.
      constraint wager_transactions_opening_is_internal
        check (kind <> 'OPENING' or source = 'INTERNAL'),

      -- REFUND e ROLLBACK exigem referencia; BET, LOSS e OPENING nao aceitam.
      constraint wager_transactions_reference_required
        check (kind not in ('REFUND','ROLLBACK')
               or reference_external_transaction_id is not null),
      constraint wager_transactions_reference_forbidden
        check (kind not in ('BET','LOSS','OPENING')
               or reference_external_transaction_id is null),

      constraint wager_transactions_money_positive check (money_amount > 0),
      constraint wager_transactions_money_scale check (scale(money_amount) <= 2),
      constraint wager_transactions_money_capacity
        check (money_amount < 1000000000000000000),
      constraint wager_transactions_currency_shape
        check (money_currency ~ '^[A-Z]{3}$'),

      -- scale('NaN') e NULL, entao a checagem de escala sozinha aceitava NaN.
      -- O limite de capacidade recusa NaN, porque NaN e maior que tudo em
      -- numeric. O >= 0 recusa saldo observado negativo.
      constraint wager_transactions_observed_balance_sane check (
        observed_balance_amount is null or (
          scale(observed_balance_amount) <= 2 and
          observed_balance_amount >= 0 and
          observed_balance_amount < 1000000000000000000
        )
      ),
      -- Replay de transacao processada devolve o saldo da epoca (regra 7.7):
      -- sem ele gravado, a resposta do replay seria impossivel de reproduzir.
      constraint wager_transactions_processed_has_observed_balance
        check (status <> 'PROCESSED' or observed_balance_amount is not null),

      -- failure_code existe exatamente nos estados de recusa.
      constraint wager_transactions_failure_code_matches_status
        check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
      -- processed_at existe exatamente nos estados terminais.
      constraint wager_transactions_processed_at_matches_status
        check ((status in ('PROCESSED','REJECTED','FAILED'))
               = (processed_at is not null)),
      -- A ancora do TTL existe enquanto a transacao aguarda referencia.
      constraint wager_transactions_pending_since_present
        check (status <> 'PENDING_REFERENCE' or pending_reference_since is not null),
      constraint wager_transactions_reference_attempts_non_negative
        check (reference_attempts >= 0),

      -- Identificador nunca vazio nem com espaco em volta: tx-9 e tx-9 com
      -- espaco seriam duas linhas distintas sob UNIQUE (idempotency_key),
      -- ou seja um debito duplicado sem concorrencia nenhuma envolvida.
      -- btrim() sozinho so remove espaco, deixando passar tab, newline e CR.
      -- A classe POSIX [[:space:]] cobre todos, igualando trim() do JS.
      constraint wager_transactions_identifiers_trimmed check (
        provider_id !~ '^[[:space:]]' and provider_id !~ '[[:space:]]$'
          and char_length(provider_id) > 0 and
        external_transaction_id !~ '^[[:space:]]'
          and external_transaction_id !~ '[[:space:]]$'
          and char_length(external_transaction_id) > 0 and
        idempotency_key !~ '^[[:space:]]' and idempotency_key !~ '[[:space:]]$'
          and char_length(idempotency_key) > 0 and
        payload_hash !~ '^[[:space:]]' and payload_hash !~ '[[:space:]]$'
          and char_length(payload_hash) > 0 and
        round_id !~ '^[[:space:]]' and round_id !~ '[[:space:]]$'
          and char_length(round_id) > 0 and
        game_id !~ '^[[:space:]]' and game_id !~ '[[:space:]]$'
          and char_length(game_id) > 0
      ),
      -- Uma transacao nao referencia a si mesma.
      constraint wager_transactions_no_self_reference
        check (reference_transaction_id is null or reference_transaction_id <> id),

      -- Sem isto o indice de reversao unica nao protege nada: em PostgreSQL
      -- dois NULL sao distintos num indice unico, entao duas reversoes
      -- PROCESSED com reference_transaction_id nulo passariam as duas —
      -- credito duplicado, sem erro do banco.
      constraint wager_transactions_processed_reversal_is_resolved
        check (status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK')
               or reference_transaction_id is not null)
    )`);

    // Uma referencia e revertida **no maximo uma vez**, por qualquer tipo.
    //
    // O enunciado proibe reverter duas vezes "pelo mesmo tipo de operacao", o
    // que pela letra permitiria um REFUND e um ROLLBACK da mesma BET. Mas aí
    // uma aposta de 25,00 renderia +50,00 de credito, violando a invariante
    // global de nao duplicar credito — que esta acima da regra especifica.
    // Entao a chave e so a referencia. A cadeia legitima continua possivel:
    // o ROLLBACK de um REFUND aponta para o REFUND, nao para a BET.
    //
    // E a regra mais facil de quebrar sob concorrencia: duas reversoes da
    // mesma referencia chegando juntas passam as duas pela validacao em
    // codigo, porque nenhuma ve a outra ainda nao commitada. O indice parcial
    // decide a corrida no unico lugar onde ela e decidivel.
    this.addSql(`create unique index wager_transactions_single_reversal
      on wager_transactions (reference_transaction_id)
      where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`);

    // Fila do worker de referencia ausente: indice parcial so do que importa.
    this.addSql(`create index wager_transactions_pending_reference
      on wager_transactions (pending_reference_since)
      where status = 'PENDING_REFERENCE'`);

    this.addSql(`create index wager_transactions_wallet_history
      on wager_transactions (wallet_id, created_at desc, id desc)`);

    // ----------------------------------------------- wallet_ledger_entries
    this.addSql(`create table wallet_ledger_entries (
      id                    uuid             not null,
      wallet_id             uuid             not null,
      transaction_id        uuid             not null,
      direction             ledger_direction not null,
      money_amount          numeric          not null,
      money_currency        char(3)          not null,
      balance_before_amount numeric          not null,
      balance_after_amount  numeric          not null,
      created_at            timestamptz      not null,

      constraint wallet_ledger_entries_pkey primary key (id),

      -- FK composto, nao simples: um FK em (wallet_id) sozinho deixaria
      -- lancar numa carteira diferente da carteira da transacao, ou em moeda
      -- diferente da moeda da carteira. E o ledger e append-only, ou seja uma
      -- linha dessas nunca poderia ser corrigida.
      constraint wallet_ledger_entries_wallet_fkey
        foreign key (wallet_id, money_currency) references wallets (id, currency),
      constraint wallet_ledger_entries_transaction_fkey
        foreign key (transaction_id, wallet_id, money_currency)
          references wager_transactions (id, wallet_id, money_currency),

      -- No maximo um lancamento por wallet por transacao.
      constraint wallet_ledger_entries_one_per_wallet_tx
        unique (transaction_id, wallet_id),

      -- O sinal e a direction, nunca o valor.
      constraint wallet_ledger_entries_amount_positive check (money_amount > 0),
      constraint wallet_ledger_entries_balances_non_negative
        check (balance_before_amount >= 0 and balance_after_amount >= 0),

      -- balanceBefore ± money === balanceAfter, verificado pelo banco.
      constraint wallet_ledger_entries_arithmetic check (
        balance_after_amount = balance_before_amount + case direction
          when 'CREDIT' then money_amount
          else -money_amount
        end
      ),

      constraint wallet_ledger_entries_scale check (
        scale(money_amount) <= 2 and
        scale(balance_before_amount) <= 2 and
        scale(balance_after_amount) <= 2
      ),
      constraint wallet_ledger_entries_capacity
        check (balance_after_amount < 1000000000000000000),
      constraint wallet_ledger_entries_currency_shape
        check (money_currency ~ '^[A-Z]{3}$')
    )`);

    // Paginacao do extrato por cursor estavel: (created_at, id) e totalmente
    // ordenado, ao contrario de OFFSET, que pula ou repete linha quando a
    // tabela recebe insert durante a paginacao.
    this.addSql(`create index wallet_ledger_entries_cursor
      on wallet_ledger_entries (wallet_id, created_at desc, id desc)`);

    // Imutabilidade estrutural: "nao altere isso" e um comentario que ninguem
    // le sob pressao. O trigger dispara para qualquer role, inclusive o owner.
    this.addSql(`create or replace function reject_ledger_mutation()
      returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries e append-only: % recusado', tg_op
          using errcode = 'restrict_violation';
      end;
      $$ language plpgsql`);

    this.addSql(`create trigger wallet_ledger_entries_append_only
      before update or delete on wallet_ledger_entries
      for each row execute function reject_ledger_mutation()`);

    // TRUNCATE nao dispara trigger de linha. Sem este, um unico TRUNCATE
    // esvaziaria o ledger inteiro sem violar nada — append-only pela metade.
    this.addSql(`create trigger wallet_ledger_entries_no_truncate
      before truncate on wallet_ledger_entries
      for each statement execute function reject_ledger_mutation()`);

    // O que o FK composto nao alcanca: LOSS nao gera lancamento, transacao
    // rejeitada nao gera lancamento, e o valor do lancamento e o valor da
    // transacao.
    //
    // E um constraint trigger DIFERIDO porque o status final da transacao so
    // existe no fim da transacao SQL: o use case grava o lancamento e marca a
    // transacao como PROCESSED na mesma unidade de trabalho. Validar no
    // momento do INSERT amarraria a ordem de escrita ao trigger.
    this.addSql(`create or replace function assert_ledger_matches_transaction()
      returns trigger as $$
      declare tx record;
      begin
        select kind, status, money_amount
          into tx
          from wager_transactions
         where id = new.transaction_id;

        if not found then
          raise exception
            'lancamento % referencia transacao inexistente %',
            new.id, new.transaction_id
            using errcode = 'foreign_key_violation';
        end if;

        if tx.kind = 'LOSS' then
          raise exception
            'LOSS nao gera lancamento no ledger (transacao %)', new.transaction_id
            using errcode = 'restrict_violation';
        end if;

        if tx.status <> 'PROCESSED' then
          raise exception
            'lancamento exige transacao PROCESSED, mas % esta em %',
            new.transaction_id, tx.status
            using errcode = 'restrict_violation';
        end if;

        if tx.money_amount <> new.money_amount then
          raise exception
            'valor do lancamento (%) difere do valor da transacao (%)',
            new.money_amount, tx.money_amount
            using errcode = 'restrict_violation';
        end if;

        return null;
      end;
      $$ language plpgsql`);

    this.addSql(`create constraint trigger wallet_ledger_entries_matches_transaction
      after insert on wallet_ledger_entries
      deferrable initially deferred
      for each row execute function assert_ledger_matches_transaction()`);

    // --------------------------------- imutabilidade das transacoes
    //
    // O ledger e append-only, mas sem isto uma transacao PROCESSED podia ser
    // reescrita para PENDING com outro valor e outra idempotency key — e aí
    // ela divergiria do proprio lancamento, que nao pode ser corrigido.
    //
    // A comparacao via to_jsonb menos as colunas mutaveis tem uma propriedade
    // util: coluna nova nasce imutavel por default, que e o lado seguro.
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

    this.addSql(`create trigger wager_transactions_identity_immutable
      before update on wager_transactions
      for each row execute function reject_wager_transaction_rewrite()`);

    this.addSql(`create trigger wager_transactions_no_delete
      before delete on wager_transactions
      for each row execute function reject_wager_transaction_rewrite()`);

    this.addSql(`create trigger wager_transactions_no_truncate
      before truncate on wager_transactions
      for each statement execute function reject_wager_transaction_rewrite()`);

    // -------------------------------------------------------- inbox_messages
    // A deduplicacao e a propria chave primaria.
    this.addSql(`create table inbox_messages (
      consumer_name text        not null,
      message_id    text        not null,
      payload_hash  text        not null,
      received_at   timestamptz not null,
      processed_at   timestamptz,
      constraint inbox_messages_pkey primary key (consumer_name, message_id),
      constraint inbox_messages_identifiers_trimmed check (
        consumer_name = btrim(consumer_name) and char_length(consumer_name) > 0 and
        message_id = btrim(message_id) and char_length(message_id) > 0
      )
    )`);

    // ------------------------------------------------------- outbox_messages
    this.addSql(`create table outbox_messages (
      id              uuid        not null,
      aggregate_id    uuid        not null,
      event_type      text        not null,
      partition_key   text        not null,
      payload         jsonb       not null,
      occurred_at     timestamptz not null,
      attempts        integer     not null default 0,
      next_attempt_at timestamptz,
      published_at    timestamptz,
      constraint outbox_messages_pkey primary key (id),
      constraint outbox_messages_attempts_non_negative check (attempts >= 0),
      constraint outbox_messages_identifiers_trimmed check (
        event_type = btrim(event_type) and char_length(event_type) > 0 and
        partition_key = btrim(partition_key) and char_length(partition_key) > 0
      )
    )`);

    // Indice parcial: a tabela cresce monotonicamente, mas so o que esta
    // pendente interessa ao publisher. Mantem a busca O(pendentes) em vez de
    // O(historico).
    this.addSql(`create index outbox_messages_claimable
      on outbox_messages (next_attempt_at nulls first, occurred_at)
      where published_at is null`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists wager_transactions_no_truncate
      on wager_transactions`);
    this.addSql(`drop trigger if exists wager_transactions_no_delete
      on wager_transactions`);
    this.addSql(`drop trigger if exists wager_transactions_identity_immutable
      on wager_transactions`);
    this.addSql(`drop function if exists reject_wager_transaction_rewrite()`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_matches_transaction
      on wallet_ledger_entries`);
    this.addSql(`drop function if exists assert_ledger_matches_transaction()`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_no_truncate
      on wallet_ledger_entries`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_append_only
      on wallet_ledger_entries`);
    this.addSql(`drop function if exists reject_ledger_mutation()`);
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
    this.addSql(`drop type if exists ledger_direction`);
    this.addSql(`drop type if exists wager_transaction_status`);
    this.addSql(`drop type if exists wager_transaction_source`);
    this.addSql(`drop type if exists wager_transaction_kind`);
  }
}
