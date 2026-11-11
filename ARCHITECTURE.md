# Arquitetura e decisões

O que foi decidido, por quê, e o que se perdeu em troca. Setup e comandos estão no [`README.md`](./README.md).

**Estado:** implementação completa, 547 testes — unidade, integração contra PostgreSQL e LocalStack reais, e concorrência com múltiplos processos.

---

## 1. As quatro invariantes

1. Não duplicar crédito.
2. Não duplicar débito.
3. Não perder evento confirmado.
4. Não permitir saldo negativo.

Todo o resto existe para sustentá-las. Onde duas decisões conflitaram, o critério de desempate foi **qual falha de forma mais segura**.

---

## 2. As decisões, em uma página

| # | Decisão | Por quê | O que custou |
|---|---|---|---|
| 1 | Dinheiro como **string decimal** de escala 2, `Decimal` dentro de `Money` | `0.1 + 0.2 !== 0.3` em IEEE-754, e `JSON.parse` perde precisão antes do nosso código rodar | Conversão explícita em toda fronteira |
| 2 | Coluna `numeric` **sem escala declarada** + `CHECK (scale ≤ 2)` | `numeric(20,2)` **arredonda** 3 casas em vez de rejeitar; arredondar dinheiro em silêncio é inventar valor | Um `CHECK` a mais para recuperar a garantia de capacidade |
| 3 | **Pessimistic lock** (`SELECT … FOR UPDATE`) por carteira | Latência previsível em vez de retry storm na carteira quente, com a decisão de negócio no domínio | Operações na mesma carteira serializam: ~186 ops/s contra ~900 em carteiras distintas |
| 4 | **Insert-first** na idempotência (`ON CONFLICT DO NOTHING`) | `SELECT`-depois-`INSERT` tem janela; o índice único serializa as duplicatas de graça | A perdedora espera o tempo da vencedora |
| 5 | **Travar a carteira antes** de inserir a transação | O FK composto toma `FOR KEY SHARE` na carteira; a ordem inversa é upgrade de lock e deadlock | Replay duplicado passa pelo lock antes de ser detectado |
| 6 | **Outbox transacional** em vez de publicar direto | Postgres e SQS não compartilham transação: publicar antes do commit anuncia dinheiro que pode sofrer rollback; depois, perde o evento se o processo morrer | Entrega vira at-least-once; o consumidor deduplica |
| 7 | **Inbox persistente** mesmo com SQS FIFO | A janela de dedup do FIFO é de 5 min e não cobre redelivery por visibility timeout | Uma tabela e um insert por mensagem |
| 8 | **Um use case** para HTTP e fila | Duas implementações da mesma regra financeira divergem na primeira correção esquecida num dos lados | As bordas ficam mais espessas |
| 9 | **MikroORM com `EntitySchema`**, entidades de persistência separadas dos agregados | Mantém decorator de ORM fora do domínio e deixa `FOR UPDATE`, `ON CONFLICT` e ordem de statements sob controle | Mappers explícitos entre domínio e persistência |
| 10 | Unicidade, imutabilidade e não-negatividade **no schema** | Código erra; constraint não. É a rede que vale mesmo com bug de aplicação | Menos flexibilidade para corrigir dado à mão |
| 11 | **Keycloak** para autenticação | Familiaridade, dentro de um timebox em que autenticação vale zero ponto | Um container a mais no Compose |
| 12 | Papéis `api`/`consumer`/`outbox`/`reference` **no mesmo binário** | Um domínio, quatro escalas independentes | A imagem carrega código que o papel não usa |

---

## 3. Camadas e papéis

| Camada | Conhece | Não conhece |
|---|---|---|
| `src/domain/` | TypeScript puro, `decimal.js` | NestJS, MikroORM, SQS, HTTP |
| `src/application/` | domínio e portas | implementações concretas |
| `src/infrastructure/` | MikroORM, SQS, HTTP, Keycloak | — |

As regras financeiras precisam ser testáveis sem container e sem bootstrap de framework — senão escrevo menos testes do que deveria. A fronteira é verificável: `grep -rE "@nestjs/|@mikro-orm/|@aws-sdk/" src/domain` volta vazio, e `decimal.js` só aparece dentro de `Money`.

O mesmo processo sobe como `api`, `consumer`, `outbox` ou `reference`, escolhido por `APP_ROLE`. Os três papéis de worker expõem **só** `/metrics` e os health checks: métrica que existe apenas na API deixa cego o lado onde a falha é silenciosa, e um endpoint de negócio atendido pelo publisher aceitaria tráfego num processo fora do balanceador.

Toda configuração passa por um schema `zod` e o processo **não sobe** com env inválida. Falhar no boot é barato; falhar no meio de uma transação financeira não é.

**ORM.** MikroORM 6 com `EntitySchema` (sem decorators) e descoberta dinâmica desligada — boot determinístico e sem o atrito conhecido entre descoberta por glob e Bun. Os agregados **não** são gerenciados pelo ORM: `Money` são duas colunas, e os caminhos críticos (`FOR UPDATE`, `ON CONFLICT`, `SKIP LOCKED`, ordem de statements) exigem controle que o Unit of Work atrapalharia ao reordenar no flush. Nenhum repositório chama `flush()`. O que o MikroORM dá, e é por isso que está aqui: `em.transactional()`, `LockMode.PESSIMISTIC_WRITE`, `PESSIMISTIC_PARTIAL_WRITE` (o `SKIP LOCKED` da outbox), `onConflict().ignore()` e o `Type` customizado do dinheiro.

---

## 4. Dinheiro

**Decisão.** `amount` atravessa toda fronteira como string decimal de escala 2 (`"25.00"`); internamente é um `Decimal` encapsulado em `Money`; na persistência são duas colunas, `*_amount numeric` e `*_currency char(3)`.

**Por que não `number`.** `0.1 + 0.2 !== 0.3`, e num ledger isso soma erro até o saldo divergir. Pior: `JSON.parse` de um número grande perde precisão **antes** de o nosso código rodar, então validar depois não resolve.

**Por que `numeric` sem escala e não `numeric(20,2)`.** O tipo com escala declarada **arredonda** `"10.999"` para `11.00` sem reclamar — comprovado contra o banco real em [`test/integration/bootstrap.spec.ts`](test/integration/bootstrap.spec.ts), e foi isso que mudou a decisão. Com `CHECK (scale(x) <= 2)` o banco **recusa**, e um `CHECK` de magnitude (`< 10^18`) devolve a garantia de capacidade que o `(20,2)` dava. A validação de escala vive em dois lugares, `Money` na entrada e `CHECK` no schema, porque confiar só no tipo da coluna arredondaria em silêncio.

**Por que duas colunas e não um tipo composto.** Permite `CHECK` e índice direto sobre o valor, e mantém as queries de reconciliação legíveis em SQL puro.

`Money` é imutável, rejeita `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas e negativo em contrato de entrada, e lança em operação entre moedas diferentes. O sinal é decisão do domínio (a direção do lançamento), nunca do provedor.

**Multi-moeda.** O modelo é multi-moeda de ponta a ponta; o desafio roda com `BRL`. Remover a dimensão e readicioná-la depois exigiria migrar o ledger histórico.

---

## 5. Concorrência

A unidade é a `walletId`. A estratégia é lock pessimista de linha, com duas redes independentes atrás dela.

| Camada | Papel |
|---|---|
| `SELECT … FOR UPDATE` na carteira | **previne** a corrida |
| `UPDATE … WHERE version = $antiga` | **detecta** um caminho que esqueceu o lock |
| `CHECK (balance >= 0)` | **impede** o dano, mesmo com bug ou escrita manual |

### Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Optimistic lock puro com retry | Em carteira quente — o caso real de iGaming — vira retry storm: a latência explode sob a carga que mais importa |
| `UPDATE … WHERE balance >= x` atômico | Preciso de `balanceBefore`/`balanceAfter` para o ledger e de **decidir** entre `failureCode`s. Empurraria regra de negócio para dentro do SQL, fora do alcance do teste unitário |
| `pg_advisory_xact_lock(hash(id))` | Colisão de hash faria carteiras diferentes disputarem o mesmo lock |
| `SERIALIZABLE` | Aborta com serialization failure, exigindo retry em todo caminho de escrita |

**Trade-off assumido.** Operações na mesma carteira serializam por construção — se escalassem, o saldo estaria errado. Medido: ~186 ops/s numa carteira contra ~900 em carteiras distintas, com **zero** deadlock e zero violação de versão. A latência sob contenção é fila, não lentidão: 32 clientes dividindo 186 ops/s dão 172 ms de permanência média por Little's law, e o p50 medido foi 170 ms. A seção crítica custa ~5,4 ms, e é ela que define o teto de uma carteira. Números completos no [`README.md`](README.md).

**Deadlock.** Cada transação trava exatamente uma carteira, então não há ciclo. Se o escopo crescesse para transferência entre carteiras, a regra seria adquirir os locks em ordem determinística de `id`.

---

## 6. Idempotência

`Idempotency-Key` é a fonte da verdade — header obrigatório, default `"{providerId}:{externalTransactionId}"`.

**Insert-first.** O par `SELECT`/`INSERT` tem janela: duas requisições paralelas não acham nada e ambas inserem. Como uma vai falhar na unicidade de qualquer forma, o próprio insert **é** o teste de existência. Enquanto a transação A tem a chave inserida e não commitada, a B bloqueia no índice único — as duplicatas são serializadas pelo mecanismo que o Postgres já tem.

**`payloadHash`.** `sha256(hex)` sobre JSON canônico (chaves ordenadas recursivamente, sem espaço, `undefined` omitido) de:

```
providerId, externalTransactionId, playerId, walletId, roundId, gameId,
kind, money.amount, money.currency, referenceExternalTransactionId
```

Fora: header, `messageId`, `occurredAt` e a própria chave — metadados de transporte, e dois envios da mesma operação têm `messageId` diferente por definição. Canônico porque o mesmo pedido serializado em ordem diferente tem que gerar o mesmo hash, senão o provedor trocar de biblioteca HTTP viraria "conflito de idempotência". Duas normalizações pelo mesmo motivo: o valor passa por `Money` (`"25"`, `"25.0"` e `"25.00"` são o mesmo dinheiro) e a referência vazia é tratada como ausente. Um teste **golden** fixa o hash do payload de referência: se mudar, a mudança foi deliberada e quebra a detecção de replay de todo provedor em voo.

**Mesma chave com payload diferente é conflito, não replay** — devolver o resultado antigo faria a operação nova desaparecer sem rastro. **Replay devolve o saldo da época**, guardado em `observed_balance_amount` na própria transação: recalcular devolveria o saldo atual, e um provedor que concilia por ele acusaria divergência.

---

## 7. Atomicidade: inbox, ledger e outbox

Persistência da transação, alteração de saldo, lançamento no ledger, registro de inbox e evento de integração participam da **mesma transação SQL**. O `UnitOfWork.run` entrega os cinco repositórios ligados ao mesmo `EntityManager`: não existe forma de uma das escritas cair fora da transação.

**Por que outbox.** Postgres e SQS não compartilham transação. Publicar antes do commit pode anunciar dinheiro que sofre rollback; publicar depois, fora da transação, perde o evento se o processo morrer no meio. Com a outbox o evento é gravado junto do dinheiro — ou os dois existem, ou nenhum.

**Por que inbox se o FIFO já deduplica.** A janela do FIFO é de 5 minutos e **não** cobre redelivery por visibility timeout, que é exatamente o caso do processo lento ou morto. FIFO é otimização; a garantia fica no banco. A chave é `(consumerName, messageId)` — com `consumerName` para que uma segunda projeção possa processar a mesma mensagem sem colidir com a dedup da primeira — e o `messageId` é o do **envelope**, não o do broker: o id do broker muda quando o provedor reenvia a mesma operação.

**Leitura.** `read()` roda em REPEATABLE READ, não em autocommit: a reconciliação compara saldo materializado com a soma do ledger em duas consultas, e sem snapshot estável uma aposta commitada no meio produziria divergência falsa. Alarme de inconsistência que não existe é pior que alarme nenhum — ensina a ignorá-lo.

### Eventos

Envelope `IntegrationEvent<T>` abstrato com uma subclasse por evento: `eventType` e `version` vivem no tipo, não em string no call site. Campos: `eventId`, `eventType`, `version`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt` (ISO-8601) e `data`, que carrega `MoneyProps` — string decimal, nunca instância de `Money`.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | rejeição por regra de negócio |
| `WalletBalanceChanged` | **somente** quando o saldo muda |
| `WagerTransactionPendingReference` | referência ausente |

O `id` da linha da outbox **é** o `eventId`, o que dá ao consumidor uma chave de dedup estável sem inventar um segundo identificador — e serve de `MessageDeduplicationId` no broker.

Todo evento expõe `partitionKey` = `walletId`, usado como `MessageGroupId` no FIFO. Não podia sair do `aggregateId`: ele é `tx.id` em três dos quatro eventos e `wallet.id` só no `WalletBalanceChanged`, o que espalharia eventos da mesma carteira por grupos diferentes.

---

## 8. Garantias que moram no schema

Três migrations versionadas e **reversíveis**:

| Migration | O que traz |
|---|---|
| [`20261110160000`](src/infrastructure/persistence/migrations/Migration20261110160000.ts) | schema inicial: enums nativos, dinheiro em `numeric` com `CHECK` de escala e capacidade, unicidades, FKs compostas, append-only do ledger, gatilho de imutabilidade das transações |
| [`20261111110000`](src/infrastructure/persistence/migrations/Migration20261111110000.ts) | lease da outbox: `locked_until`, `locked_by`, `abandoned_at`, `last_error` e o índice parcial de reivindicação |
| [`20261111150000`](src/infrastructure/persistence/migrations/Migration20261111150000.ts) | `next_reference_attempt_at`, `CHECK` de escopo, índice parcial e a coluna nova na lista de mutáveis do gatilho |

Cada constraint tem um teste que **tenta violá-la** ([`schema-constraints.spec.ts`](test/integration/schema-constraints.spec.ts)) — garantia não verificada não é garantia.

### Reversão única

```sql
create unique index wager_transactions_single_reversal
  on wager_transactions (reference_transaction_id)
  where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
```

**A chave é só a referência, não `(referência, tipo)`.** A regra proíbe reverter duas vezes "pelo mesmo tipo", o que pela letra permitiria um `REFUND` **e** um `ROLLBACK` da mesma `BET` — e uma aposta de 25,00 renderia 50,00 de crédito, violando a invariante de não duplicar crédito, que está acima da regra específica. A cadeia legítima continua possível: o `ROLLBACK` de um `REFUND` aponta para o `REFUND`, outra chave no índice.

**O índice sozinho não protegia nada.** `reference_transaction_id` é nullable e, em PostgreSQL, dois NULL são distintos num índice único — duas reversões com referência não resolvida passariam as duas. A rede é um `CHECK` que torna a coluna obrigatória exatamente onde o índice precisa dela.

### FKs compostas

| FK | Garante |
|---|---|
| `wager_transactions (wallet_id, money_currency) → wallets (id, currency)` | a moeda da operação é a da carteira |
| `wallet_ledger_entries (wallet_id, money_currency) → wallets (id, currency)` | não há lançamento em moeda que a carteira não tem |
| `wallet_ledger_entries (transaction_id, wallet_id, money_currency) → wager_transactions (…)` | o lançamento é da carteira da **sua própria** transação |

Com FKs de coluna única, um lançamento podia cair em carteira ou moeda diferente da transação — e o ledger é append-only, então a linha **nunca poderia ser corrigida**.

### Imutabilidade e o que o FK não alcança

O ledger tem trigger contra `UPDATE`, `DELETE` **e `TRUNCATE`** — trigger de linha não cobre `TRUNCATE`, e sem o de statement o append-only ficava pela metade. A transação tem guarda equivalente: sem ela, uma linha `PROCESSED` podia ser reescrita para `PENDING` com outro valor, divergindo de um lançamento que não pode ser corrigido. A comparação usa `to_jsonb(old) - mutáveis <> to_jsonb(new) - mutáveis`, que tem uma propriedade útil: **coluna nova nasce imutável por default**, o lado seguro. Os triggers valem para o owner da tabela, não só para roles restritos — há teste disso.

Regras que FK e `CHECK` não expressam (`LOSS` não gera lançamento; transação não processada não gera lançamento; o valor do lançamento é o da transação) ficam num **constraint trigger `deferrable initially deferred`**: o status final só existe no fim da transação, porque o use case grava o lançamento e marca `PROCESSED` na mesma unidade de trabalho.

**Índices parciais** em `single_reversal`, `pending_reference` e `outbox_claimable`: a tabela cresce monotonicamente, mas só o pendente interessa ao worker — mantém a busca O(pendentes) em vez de O(histórico). O teste verifica a **definição** do índice, não o plano: com tabela pequena o planner escolhe Seq Scan e o teste mediria a ausência de `ANALYZE`.

---

## 9. Transações: estados e recusas

### Como os agregados protegem as invariantes

Todo agregado e value object tem construtor **privado** e nasce por factory estática — não existe, em nenhum ponto do processo, instância em estado inválido, nem "criar e depois preencher".

**Saldo e ledger andam juntos por construção:** `debit` e `credit` **devolvem** o lançamento correspondente, então não há caminho de código em que o saldo muda sem lançamento. Vale também para a abertura — `Wallet.open` devolve `{ wallet, openingEntry }`. Uma primeira versão gravava o saldo inicial direto, o que tornava `balance == ledger` falso para toda carteira com saldo e convidava o use case a creditar de novo.

`Wallet.debit` **lança** se o saldo não cobre, porque chegar lá é bug: quem chama deveria ter consultado `hasSufficientBalance()`. A consulta é separada justamente porque só quem chama sabe qual código emitir — uma aposta sem saldo é `INSUFFICIENT_FUNDS`, uma reversão que não cabe é `REVERSAL_WOULD_OVERDRAW`. Ensinar essa diferença ao agregado o faria conhecer o fluxo de reversão, que não é assunto dele.

### Máquina de estados

| De | Para |
|---|---|
| `PENDING` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED` / `REJECTED` / `FAILED` | — terminal |

`PENDING_REFERENCE → PENDING_REFERENCE` é permitido de propósito: o worker re-marca a cada tentativa que ainda não encontra a referência. Transicionar de um estado terminal é bug de programação, não caminho de negócio, e lança.

### Regras por kind

| Kind | Saldo | Ledger | Regra |
|---|---|---|---|
| `OPENING` | crédito | 1 `CREDIT` | interno, não submissível pela API |
| `BET` | débito | 1 `DEBIT` | rejeita se o saldo não cobre |
| `WIN` | crédito | 1 `CREDIT` | pode referenciar a `BET` da rodada |
| `LOSS` | nenhum | nenhum | registra resultado sem mover saldo |
| `REFUND` | crédito | 1 `CREDIT` | reverte uma `BET` `PROCESSED`, uma única vez |
| `ROLLBACK` | inverso | 1 invertido | reverte `BET`, `WIN` ou `REFUND` `PROCESSED`, uma única vez |

Referência resolvida por `(providerId, referenceExternalTransactionId)`, exigindo mesmo provedor, jogador, carteira, moeda e rodada, com valor igual — reversão parcial está fora de escopo.

### Taxonomia de `failureCode`

O provedor é um programa: precisa decidir sozinho entre reenviar, corrigir o payload ou desistir, e parsear texto de mensagem quebra no dia em que alguém melhora o texto. Definidos em [`failure-code.ts`](src/domain/shared/failure-code.ts).

| `failureCode` | Quando | Status | O provedor deve |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | 422 | desistir; é operação normal |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria saldo negativo | 422 | **abrir incidente**: há divergência entre nós e ele |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da carteira | 422 | corrigir o payload |
| `WALLET_NOT_FOUND` | `walletId` não existe | 422 | corrigir o payload |
| `PLAYER_MISMATCH` | a carteira é de outro jogador | 422 | corrigir o payload |
| `MISSING_REFERENCE` | reversão sem referência | 422 | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do TTL | 422 | conciliar: a operação referenciada nunca chegou |
| `REFERENCE_NOT_PROCESSED` | referência existe mas não está `PROCESSED` | 422 | esperar e reenviar |
| `REFERENCE_KIND_NOT_REVERSIBLE` | tentou reverter `LOSS` ou `OPENING` | 422 | desistir |
| `REFERENCE_ALREADY_REVERSED` | já revertida | 422 | desistir; reverter duas vezes criaria dinheiro |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência | 422 | corrigir; reversão parcial fora de escopo |
| `REFERENCE_SCOPE_MISMATCH` | referência de outro provedor/jogador/carteira/moeda/rodada | 422 | corrigir o payload |
| `AMOUNT_OVERFLOW` | valor computado estoura a capacidade | 422 | corrigir o payload |
| `IDEMPOTENCY_KEY_CONFLICT` | mesma chave, payload diferente | 409 | **corrigir a geração de chaves** |
| `INTERNAL_KIND_NOT_SUBMITTABLE` | tentou submeter `OPENING` | 422 | desistir; é tipo interno |

Três distinções deliberadas: `INSUFFICIENT_FUNDS` alimenta dashboard enquanto `REVERSAL_WOULD_OVERDRAW` acorda alguém; `REFERENCE_NOT_FOUND` é terminal e `REFERENCE_NOT_PROCESSED` pode mudar sozinho em dez segundos; `REFERENCE_ALREADY_REVERSED` e `IDEMPOTENCY_KEY_CONFLICT` parecem iguais e exigem correções opostas.

**Duas classes de rejeição.** As que o schema torna impossíveis de persistir (`WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `MISSING_REFERENCE`, `INTERNAL_KIND_NOT_SUBMITTABLE`) são auditadas por log e métrica; as demais viram linha `REJECTED` com o código, e `GET /wagering/transactions/:id` devolve o motivo depois. Recusa sem rastro obriga o provedor a adivinhar.

### Três classes de erro

| Erro | Significa | Vira |
|---|---|---|
| `InvalidInputError` | entrada que não chega a virar objeto de domínio | 400 |
| `DomainRuleViolationError` | requisição bem formada que o domínio recusou; carrega `FailureCode` | 422 |
| `InvariantViolationError` | invariante de agregado violada — bug, não caminho de negócio | 500 e alerta |

É essa distinção que permite ao provedor decidir entre corrigir o JSON e aceitar que o jogador não tem saldo.

---

## 10. O use case central

Um único `SubmitWagerTransaction`, usado pelo controller HTTP **e** pelo consumer. O que é próprio de cada canal — inbox, ack, status HTTP — fica nas bordas.

```
BEGIN
 1. (só fila) INSERT inbox já processada — uma escrita, sem estado ambíguo
 2. SELECT … FOR UPDATE na carteira      ← ANTES de qualquer outra escrita
 3. valida existência e moeda
 4. INSERT transação ON CONFLICT (idempotency_key) DO NOTHING
       0 linhas + hash igual     ⇒ replay com o saldo da época
       0 linhas + hash diferente ⇒ 409, nada aplicado
 5. valida player
 6. resolve e valida a referência
 7. LOSS: PROCESSED, sem lançamento, sem WalletBalanceChanged
 8. debita ou credita, grava lançamento, UPDATE saldo WHERE version = $antiga
 9. INSERT outbox — grava, nunca publica
COMMIT
```

**O passo 2 estava no lugar errado, e isso era grave.** A primeira versão inseria a transação antes de travar a carteira, com a justificativa de filtrar duplicatas sem disputar o lock. Mas o `INSERT` dispara a checagem do FK `(wallet_id, money_currency)`, que toma **`FOR KEY SHARE`** na carteira; pedir `FOR UPDATE` depois é upgrade de lock, e duas operações concorrentes formam ciclo. Medido antes da correção: **28 deadlocks em 30 execuções** do cenário obrigatório. Depois: 0 em 30, e a suíte caiu de 82 s para 1 s.

A lição generalizável: **uma constraint de integridade referencial é também uma política de lock.** O FK não aparece no código do use case, mas define a ordem de aquisição.

**Savepoint em volta do insert.** Violação de unicidade aborta a transação SQL inteira no PostgreSQL — capturar o `23505` e seguir fazia o `COMMIT` virar `ROLLBACK` em silêncio, levando junto a linha de inbox e quebrando exatamente a atomicidade que ela existe para garantir.

**Reversão única resolvida sob o lock.** Duas reversões da mesma referência tocam a mesma carteira por definição, então o `FOR UPDATE` já as serializa e a segunda vê a primeira. Isso não é redundante com o índice parcial: atingir o índice **aborta a transação**, e aí não haveria como gravar a rejeição. O índice é a barreira para um caminho que esqueceu o lock; a checagem é o caminho normal.

---

## 11. Entradas: HTTP e fila

### Mapa de status

| Situação | Status |
|---|---|
| Aplicada, ou replay | 200 |
| Aguardando referência | 202 |
| Carteira criada | 201 |
| Payload inválido | 400 |
| Conflito de idempotência, operação ou carteira duplicada | 409 |
| Rejeição por regra de negócio | 422 + `failureCode` |
| Falha transitória | 503 + `Retry-After` |

A tradução acontece num **único** filtro: levantar exceções HTTP direto nos controllers daria dois contratos de erro diferentes para o mesmo provedor. Reconciliação responde 200, não o 201 que o Nest dá por default em `POST` — ela não cria recurso.

O schema `zod` valida **forma**; escala, notação e sinal do valor são decididos por `Money`. Duplicar as regras monetárias no DTO criaria duas fontes da mesma verdade. `OPENING` passa pela validação de forma de propósito: recusar ali daria 400, e o provedor precisa do 422 com `INTERNAL_KIND_NOT_SUBMITTABLE` para saber **por quê**.

Todo endpoint aceita e devolve `X-Correlation-Id`, gerando um quando o cliente não manda. O id atravessa HTTP, outbox, SQS e consumer.

### Classificação de falha, usada pelos dois canais

`classifyFailure` devolve `BUSINESS`, `TRANSIENT` ou `PERMANENT`. A API traduz para status; o consumer decide entre ack, retry e DLQ.

| Classe | Ação no consumer | Por quê |
|---|---|---|
| Negócio | commita a rejeição e dá **ack** | Não é falha; reenviar não muda o resultado e manter na fila é loop infinito |
| Transitório | sem ack, devolve a visibilidade com espera curta | Vai funcionar depois |
| Permanente | **direto para a DLQ**, com o motivo em atributo | Retry nunca resolve; mandar já evita cinco entregas inúteis |

Erro desconhecido cai em transitório: dar retry a algo que talvez funcione é preferível a descartar algo que talvez importasse, e o limite de entregas impede o loop.

`ack` acontece **somente depois do commit**. Falhar o ack é seguro — o trabalho está commitado, a mensagem volta e a inbox deduplica —, por isso é registrado como aviso.

### Ordem dentro do grupo, paralelo entre grupos

O lote é agrupado por `MessageGroupId` (que é a `walletId`): **sequencial dentro do grupo, paralelo entre grupos**. A premissa de que "o FIFO não entrega duas mensagens do mesmo grupo ao mesmo tempo" é falsa — ele entrega várias, em ordem, e é o consumidor que precisa preservá-la. Em paralelo, um `ROLLBACK` podia ultrapassar a `BET` que reverte e cair em `PENDING_REFERENCE` sem necessidade.

### Encerramento

Em `SIGTERM` o consumer **drena**: para de buscar, espera o long poll em curso, conclui o que está em voo e devolve a visibilidade do resto. `stop()` esperar o poll importa — sem isso, um lote recém-recebido ficaria invisível até o visibility timeout em vez de voltar para a fila na hora. O `stop_grace_period: 40s` do Compose acomoda a espera.

---

## 12. Workers: outbox e referência ausente

### Publisher da outbox

Ciclo em três etapas, com a publicação **fora** de transação: reivindica com `FOR UPDATE SKIP LOCKED` gravando lease e contando a tentativa; publica; marca publicada, agenda retry ou desiste.

**Por que lease e não manter a transação aberta.** Segurar a transação durante o envio amarraria o tempo de vida de um lock e de uma conexão à latência de um terceiro — uma chamada pendurada ao SQS vira transação pendurada, que atrasa vacuum e consome pool. Morrer entre publicar e marcar deixa o lease expirar e outro publisher assume; a publicação duplicada resultante é tolerada por desenho, e o consumidor deduplica pelo `eventId`.

**O relógio é o do banco.** Todas as comparações que cruzam workers — expiração de lease, `next_attempt_at` — usam `now()` no SQL. Com relógio de processo e três instâncias, o skew quebra nas duas direções: adiantado, o worker reivindica linha que um publisher vivo está publicando; atrasado, o lease de um worker morto parece válido e o evento fica preso.

**A tentativa é contada na reivindicação**, não na falha: um publisher que morre entre publicar e marcar nunca registraria a tentativa, e a linha seria reenviada a cada expiração de lease com o backoff congelado em zero.

**Abandono.** O que nunca vai publicar — corpo acima do limite, fila errada — seria reenviado para sempre e fixaria o outbox lag no teto, mascarando um publisher realmente travado. `abandoned_at` tira a linha da fila e da métrica, com `last_error` guardado e log em `error`.

**Limite de 20 tentativas**, derivado do horizonte pretendido e não do gosto: com backoff dobrando de 1 s e teto de 5 min, 10 tentativas cobririam 8,5 min e o teto nunca entraria em jogo — seria decoração, e quinze minutos de broker fora custariam o evento. Com 20, o horizonte vai a ~58 min e o teto passa a valer. Há teste amarrando as duas constantes.

A recarga ordena por `(occurred_at, id)`: o `occurred_at` empata entre os dois eventos da mesma transação, e sem desempate a ordem dentro do grupo seria a que o Postgres devolvesse. O `id` é UUIDv7, ordenado no tempo.

### Worker de referência ausente

Referência ausente **não é rejeição**. Com entrega at-least-once e sem ordenação garantida, um `ROLLBACK` chegar antes da `BET` é normal; rejeitar deixaria o provedor achando que reverteu enquanto nosso saldo diz que não.

| Parâmetro | Valor |
|---|---|
| Backoff | 1s, 2s, 4s… saturando em 15 min |
| Tentativas | 120 |
| TTL | 24h — **é ele que decide** |

Os dois limites precisam ser coerentes. A primeira versão tinha 15 tentativas com teto de 5 min, que esgotam em ~38 minutos: o TTL de 24h era decorativo, e a transação morreria por esgotar tentativas numa tarde em vez de esgotar o prazo. Com 120 tentativas e teto de 15 min o horizonte vai a 27,8h, e há teste somando os atrasos para exigir que passem do TTL. Esgotado, o worker rejeita com `REFERENCE_NOT_FOUND` e publica o evento.

O trecho pós-lock é compartilhado com o use case (`WagerTransactionApplier`), que recebe a transação já persistida e a carteira já travada — é a lógica que move dinheiro, e duas cópias divergiriam.

**Ordem de lock, e a consequência dela.** O worker trava a carteira antes da transação, a mesma ordem do use case. Isso impede reivindicar a transação com `SKIP LOCKED`, que exigiria travá-la primeiro. Então a fila é lida sem claim, e o que serializa réplicas é a **releitura sob o lock da carteira**, conferindo estado *e vencimento* com o relógio do banco. Checar só o status fazia duas réplicas consumirem uma tentativa cada, matando o backoff — há teste com réplicas simultâneas exigindo que apenas uma tentativa seja consumida.

**Falha de uma linha não para o ciclo.** Sem `try/catch` por linha, uma linha que estoura aborta o ciclo e, como o rollback desfaz o adiamento, continua vencida na mesma posição, starvando tudo que vem depois. Cada linha é isolada e adiada em transação própria. Uma linha que falha em **todo** ciclo permanece pendente com alarme em vez de ser rejeitada: rejeitar uma transação financeira porque o nosso código está quebrado é pior que deixá-la visível.

---

## 13. Autenticação

**Decisão.** Keycloak (OIDC) no Compose, JWT validado por JWKS com `jose`. **Justificativa: é a ferramenta em que tenho mais familiaridade** — dentro de um timebox em que autenticação vale zero ponto, usar o que domino sobra tempo para o núcleo financeiro. Autenticação artesanal reinventaria, com menos segurança, o que um IdP já resolve: rotação de chave, revogação, client credentials, expiração.

O guard é aplicado **por controller**, não globalmente com allowlist de caminhos: uma lista de caminhos liberados é uma segunda fonte de verdade que envelhece, e endpoint novo nasceria aberto em silêncio. Health e `/metrics` simplesmente não recebem o guard.

### Autenticar não é autorizar

Validar o token prova apenas que quem chama tem *algum* token válido. Sem mais nada, `provider-b` submeteria uma aposta dizendo-se `provider-a` e debitaria a carteira de um jogador que não é cliente dele.

- `providerId` do corpo ≠ claim do token → **403 `PROVIDER_MISMATCH`**, antes de chamar o use case;
- `Idempotency-Key` fora do espaço do provedor → **403 `IDEMPOTENCY_KEY_NOT_OWNED`**. A unicidade da chave é global no schema e a chave vem do cliente: sem o vínculo, `provider-b` ocuparia `provider-a:TX123` com uma aposta legítima dele, e a transação real de `provider-a` colidiria com payload diferente, recebendo **409 para sempre**;
- recurso de outro provedor → **404, não 403**: um 403 confirmaria que o recurso existe, e um provedor poderia varrer ids para medir o volume do concorrente.

### Verificação do token

| Decisão | Por quê |
|---|---|
| Allowlist de algoritmos (`RS*`, `ES*`) | Sem ela, `alg: none` ou `HS256` assinado com a **chave pública** do JWKS como segredo passariam |
| Issuer e audience obrigatórios | Token de outro realm, ou emitido para outro serviço, é token de outro mundo |
| `exp` obrigatório | `jwtVerify` aceita token sem expiração, e credencial que não expira vaza para sempre |
| Claim `providerId` obrigatória | Sem ela, seguir significaria aceitar o `providerId` que o corpo mandar |
| JWKS em cache (10 min) com cooldown de 30 s | Buscar por requisição poria o login na latência do IdP; sem cooldown, tokens com `kid` inventado forçariam uma busca cada |
| Motivo da recusa só no log | Distinguir "assinatura inválida" de "audience errada" daria ao atacante um oráculo |

`KEYCLOAK_ISSUER_URL` e `KEYCLOAK_JWKS_URL` são separados porque o `iss` do token é o que o Keycloak anuncia a quem pediu (`localhost:8080` para quem pede do host), enquanto a API dentro do Compose alcança o IdP por outro nome.

**Limitações assumidas.** Os segredos no `realm-jungle.json` são credenciais de desenvolvimento, para o Compose subir sozinho. `AUTH_ENABLED=false` é o default, decisão explícita de configuração para o avaliador exercitar a API sem obter token. O consumidor da fila não tem autenticação equivalente: quem publica já está dentro do perímetro.

---

## 14. Observabilidade

### Health checks

`/health/live` responde "me reinicia?" e não consulta dependência externa. `/health/ready` responde "me manda tráfego?" e checa três coisas com a latência de cada uma: PostgreSQL alcançável, **schema aplicado** e SQS alcançável. Separados porque, juntos, uma indisponibilidade momentânea do banco causaria restart loop.

**Banco alcançável não é banco pronto.** Com `select 1` sozinho, uma instância apontada para um banco sem migrations respondia `200 ready` e só falhava na primeira operação de negócio, com 500. A probe pergunta ao migrator se há migration pendente e falha nomeando quais. O par disso no Compose é o serviço `migrate`, que aplica as migrations e sai, com os demais serviços dependendo da conclusão dele — serviço próprio porque três réplicas subindo juntas disputariam a mesma migration.

Os dois ficam abertos, sem autenticação: readiness precisa responder com o IdP fora.

### Métricas

| Série | Para responder |
|---|---|
| `wager_transactions_total{outcome,kind,source,failure_code}` | quantas aplicadas, quantas recusadas e por qual código |
| `wager_transaction_duration_seconds{outcome,source}` | p50/p95/p99 do caminho financeiro, por canal |
| `wager_duplicates_total{kind}` | repetição por idempotency key, external id e inbox |
| `wager_retries_total{subject}` | pressão de retry em fila, outbox e referência |
| `wager_dead_letter_total{reason}` | o que o sistema desistiu de processar |
| `wager_lock_conflicts_total{reason}` | contenção: `deadlock`, `serialization`, `version_mismatch` |
| `wager_outbox_lag_seconds` | idade da pendência mais antiga — o sinal de publisher parado |
| `wager_reconciliation_divergences_total` | saldo contra ledger; **nunca** deveria incrementar |

`role` é label default: três instâncias de API agregam sem ambiguidade.

Quatro decisões que valem registro:

- **`version_mismatch` separado de `deadlock`.** Deadlock é carga, o retry resolve. `version_mismatch` significa que alguém alterou a carteira **sem** o lock: é bug, e misturar esconderia o bug atrás do ruído.
- **Replay não reconta a transação.** Um provedor que reapresenta a mesma aposta cinco vezes tem um débito no ledger; somar as cinco poria a métrica em desacordo com o livro, e dashboard que discorda do ledger é pior que nenhum. O replay conta em `wager_duplicates_total`.
- **Erro do cliente não é erro do sistema.** Payload inválido conta como `outcome="INVALID"`; contado como `ERROR`, um provedor com payload errado ficaria indistinguível de um Postgres fora do ar.
- **O gauge de atraso nasce na primeira observação**, não no construtor: registrado, ele exportaria zero constante nos papéis que nunca publicam, e um alerta em `avg` sobre publisher parado leria ~0 por causa deles.

### Logs

JSON estruturado com `correlationId`, `transactionId`, `walletId`, `providerId`, `externalTransactionId`, `messageId`, `kind`, `source`, `outcome`, `failureCode`, `durationMs` — uma linha por submissão. É o registro que liga uma reclamação de provedor a um `transactionId`, e dele ao ledger.

**Valor monetário não entra em log nem em métrica.** Onze campos são redigidos, na raiz e um nível abaixo; as duas listas cobrem o mesmo conjunto, porque campo coberto na raiz e exposto um nível abaixo é pior que nenhuma redação. A redação age sobre **campo**, não sobre texto dentro de string — e era por aí que o valor escapava: `Money` lança "escala maior que 2: 25.123", então `erro.message` devolveria o valor por uma porta que a redação não cobre. Para erro de domínio a mensagem fica fora e a pilha vai sem a primeira linha; o nome da classe e o `failureCode` dizem o que aconteceu.

Rejeição de negócio é `warn`, não `error`: aposta sem saldo é operação normal, e poluir `error` treina quem opera a ignorar o nível.

**Toda linha do processo é JSON**, inclusive as do Nest e do MikroORM, que por default escrevem prosa com ANSI — metade do stream fora do formato não é log estruturado, o agregador perde essa metade. Cada linha leva `hostname` (em container, o id), sem o qual as três réplicas logavam `role=api, pid=1` e eram indistinguíveis.

---

## 15. Testes

| Nível | O que cobre | Infra |
|---|---|---|
| Unidade | `Money`, invariantes da carteira, regras por kind, máquina de estados, `payloadHash`, envelope | nenhuma |
| Integração | migrations e constraints, atomicidade, inbox/redelivery, outbox com retry e DLQ, API | PostgreSQL e LocalStack **reais** |
| Concorrência | 10 cenários com **processos Bun independentes** | processos de verdade |

**Por que processos e não `Promise.all`.** Um único event loop compartilha pool de conexão e cache do ORM; correção nessas condições não diz nada sobre correção com três réplicas, que é o que o enunciado exige. Cada filho monta o `AppModule` de produção — um harness que montasse as dependências à mão testaria o harness.

**Barreira de largada.** Subir Bun, conectar no Postgres e inicializar o ORM custa centenas de milissegundos, e esse custo varia entre os filhos: sem sincronização, o primeiro commita antes de o último abrir conexão, não há corrida, e o teste passa com código errado. A barreira é um socket TCP local — não `LISTEN/NOTIFY`, porque o banco é o objeto do teste e a sincronização não deve compartilhar nada com o que está sendo medido. Tem prazo, e no estouro libera a largada antes de esperar: quem já anunciou está bloqueado e nunca terminaria.

**Crash com `SIGKILL`, não exceção.** Exceção roda handlers de cleanup; o cenário que interessa é aquele em que nada é limpo — nem ack, nem devolução de visibilidade. A decoração que mata o processo vive **no harness**, não em produção: hook de crash atrás de env no caminho do dinheiro é caminho de falha morando onde não pode haver nenhum.

**Invariante que fecha todo teste:** `wallet.balance == saldo reconstruído somando o ledger`, pela reconciliação real. Pega duplicação, perda e lost update de uma vez, sem depender de o teste ter adivinhado onde estaria o bug.

---

## 16. Interpretações adotadas

O enunciado pede que interpretações adicionais sejam documentadas.

| Interpretação | Racional |
|---|---|
| `Money.from` aceita até 2 casas e **normaliza** (`"25"` → `"25.00"`) | A regra proíbe *mais* de 2 casas; aceitar menos é tolerante sem perder exatidão |
| Teto de 18 dígitos inteiros, verificado também em valores **computados** | Sem isso uma soma morreria no `INSERT` com `22003`, que o consumer leria como falha transitória e levaria à DLQ |
| `Money.from` rejeita negativo; `subtract`/`negate` produzem negativo | Em contrato de entrada o sinal é decisão do domínio, nunca do provedor |
| `equals` nunca lança; `isLessThan` lança em moedas diferentes | Ordenar moedas distintas não tem significado; perguntar se são iguais tem |
| `BET`, `LOSS` e `OPENING` com referência são **recusados** | Receber o campo num kind que não referencia nada indica bug do provedor; ignorar em silêncio é como bugs se escondem |
| Valor estritamente positivo em todos os kinds, inclusive `LOSS` | Uma `LOSS` de zero é operação malformada |
| `ROLLBACK` não referencia outro `ROLLBACK` | A regra lista `BET`, `WIN` e `REFUND`; reverter uma reversão seria ambíguo |
| Identificador com espaço em volta é **recusado**, não aparado | Seriam duas linhas distintas sob `UNIQUE (idempotency_key)`; aparar alteraria em silêncio o dado do provedor |
| Referência **vazia** é `MISSING_REFERENCE` (422), não identificador malformado (400) | Para o provedor, referência vazia é "falta referência", que é regra de negócio |
| `version` continua 1 depois da abertura | A abertura *é* a criação, não uma movimentação posterior |
| `rehydrate` não revalida transições | `create` representa um fato novo; `rehydrate`, um fato que já aconteceu. Se revalidasse, mudar uma regra tornaria impossível carregar registros legítimos |
| Enum desconhecido vindo do banco lança `InvariantViolationError` | Um `TypeError` seria classificado como transitório e iria para a DLQ, mascarando dado inconsistente como problema de infraestrutura |

---

## 17. O que quebrou no caminho

Erros reais encontrados em revisão ou em teste, com a lição que sobrou. Estão aqui porque explicam decisões que de outro modo pareceriam arbitrárias.

| O que quebrou | Lição |
|---|---|
| `INSERT` antes do `FOR UPDATE` → 28 deadlocks em 30 execuções | Um FK é também uma política de lock |
| Índice único sobre coluna nullable não protegia nada | Em PostgreSQL dois NULL são distintos num índice único |
| `btrim` só remove espaço, não tab nem newline | Quando o banco normaliza, a aplicação tem que normalizar igual antes de comparar |
| UUID em maiúsculas comparado cru contra o banco | A mesma lição, com dinheiro em jogo: gerava `PLAYER_MISMATCH`, gravava `REJECTED`, e a correção do provedor batia em 409 para sempre |
| `EPIPE` tem 5 caracteres e passava por SQLSTATE | Socket caindo virava erro "permanente" e ia para a DLQ em vez de retry |
| 15 tentativas com teto de 5 min contra um TTL de 24h | Dois limites que se contradizem: um deles é decoração |
| Lease comparado com o relógio do processo | Tempo que cruza processos vem do banco |
| Tentativa contada na falha, não na reivindicação | Um crash loop nunca registrava tentativa e o backoff ficava congelado |
| `Promise.all` no lote do consumer | O FIFO entrega várias mensagens do mesmo grupo; preservar a ordem é do consumidor |
| Poll vazio sem pausa | Espera ativa de microtasks deixa o processo surdo a `setTimeout` e a `SIGTERM` |
| Readiness com `select 1` sozinho | Banco alcançável não é banco pronto |
| Replay recontado em `wager_transactions_total` | Métrica que discorda do ledger é pior que métrica nenhuma |

---

## 18. Limitações conhecidas

Declaradas de propósito — desenho honesto vale mais que escopo inflado.

| Limitação | Por que ficou fora |
|---|---|
| Reversão parcial | Fora do escopo: o valor da reversão é igual ao da referência |
| Ledger de partidas dobradas | Diferencial opcional; o esforço rende mais em concorrência |
| Reconciliação O(n) no ledger | Carteira com milhões de lançamentos precisaria de snapshot incremental |
| Outbox cresce indefinidamente | Falta job de arquivamento das linhas publicadas |
| Roda com `BRL` | O modelo é multi-moeda e o conflito é testado, mas não há conversão |
| Sem particionamento do ledger | Em volume real, particionaria por mês |
| Endpoints de carteira sem escopo de provedor | Ver abaixo |
| `correlationId` original não persiste no reprocessamento | O evento liga tudo pelo `aggregateId`, mas o rastro de log não atravessa da submissão até a resolução |

**Carteira sem escopo de provedor.** `GET /wallets/:id`, o ledger e a reconciliação exigem token, mas qualquer provedor autenticado que conheça o `walletId` — e precisa conhecer, para submeter suas operações — lê o extrato completo, incluindo lançamentos de outros provedores. É consequência do modelo: a carteira é do **jogador** e compartilhada, então o extrato contém operações de vários, e filtrar por provedor devolveria um extrato que não fecha com o saldo — contradizendo a invariante central. A resposta certa não é filtrar a listagem, é mudar quem pede: token com contexto de jogador, ou uma API administrativa. Mudar o agregado central no fim do timebox, sem a mesma bateria de teste que o resto recebeu, seria pior que registrar a limitação.

**Replay adquire o lock da carteira.** A checagem de idempotência acontece depois do lock para que exista uma única seção crítica — inverter essa ordem foi o que produziu a classe de deadlock da §10. Custo medido: 290 ops/s no replay contra 186 na escrita, na mesma carteira.

**O publisher não acompanha o pico de escrita no default.** A ~900 ops/s, cada uma enfileirando dois eventos, dois publishers com lote de 10 acumulam ~12 s de atraso; a 186 ops/s ficam em 0,2 s. Nada se perde, mas a propagação atrasa. É ajuste de configuração, e o `SKIP LOCKED` com lease existe para permitir isso sem coordenação.

**Redrive nativo do SQS fora da métrica.** Se o broker mover a mensagem sem o processo passar pelo caminho de DLQ, a contagem não vê. O sinal complementar seria a profundidade da DLQ, lida da fila.

**A medição de carga roda na mesma máquina do sistema medido.** O gerador disputa CPU com os dez containers: o teto é piso, não teto, e varia ~17% entre execuções no perfil limitado por CPU contra ~2% nos limitados por lock.

---

## 19. Com mais tempo

1. **Replay sem lock** — responder repetição pelo `observed_balance` já gravado, antes de adquirir o lock. Liberaria da seção crítica o caminho mais comum em produção.
2. **Snapshot periódico de saldo** — reconciliação O(1) em vez de O(histórico).
3. **OpenTelemetry** atravessando HTTP → outbox → SQS → consumer; hoje a correlação é por log.
4. **Carga sob falha injetada** — derrubar Postgres e SQS no meio da carga. O harness já mata processo com `SIGKILL`; falta fazer isso sob carga sustentada.
5. **Autoescala do publisher** com o próprio `wager_outbox_lag_seconds` como sinal.
6. **Partidas dobradas** e **particionamento do ledger por mês**.
