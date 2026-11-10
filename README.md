# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas de múltiplos provedores de jogos, por HTTP e por fila, com entrega *at-least-once*.

Desafio técnico Jungle Gaming. As decisões de arquitetura e seus trade-offs estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

> **Estado atual: API HTTP completa.** Domínio, schema, persistência, use cases e API estão prontos. Os workers (consumer SQS, publisher da outbox, reprocessamento de referência) e a autenticação chegam nas fases seguintes — ver `ARCHITECTURE.md`.

## Requisitos

| Ferramenta | Versão |
|---|---|
| [Bun](https://bun.sh) | 1.4+ |
| Docker + Compose | Compose v2+ |

Instalar o Bun: `curl -fsSL https://bun.sh/install | bash`

## Setup

```bash
cp .env.example .env     # os defaults já apontam para o Compose
bun install
bun run compose:up       # build + sobe a stack inteira
```

Conferir que está de pé:

```bash
curl -s localhost:3001/health/ready | jq
curl -s localhost:3002/health/live  | jq
```

Derrubar tudo, inclusive os volumes:

```bash
bun run compose:down
```

## Portas

| Serviço | Porta | Observação |
|---|---|---|
| `api-1` / `api-2` / `api-3` | 3001 / 3002 / 3003 | três instâncias, para exercitar concorrência real |
| PostgreSQL | 5433 | `wagering` / `wagering` / db `wagering`. 5433 no host porque a 5432 costuma estar ocupada; dentro da rede do Compose é 5432 |
| LocalStack (SQS) | 4566 | filas criadas no boot pelo init script |
| Keycloak | 8080 | admin `admin` / `admin`, realm `jungle` |

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | API local em watch mode |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run db up` | aplica as migrations pendentes |
| `bun run db down` | reverte a última migration |
| `bun run db create <nome>` | cria uma migration versionada e vazia |
| `bun run db list` | o que está aplicado e o que está pendente |
| `bun run db fresh --yes` | dropa o schema e reaplica tudo. Destrutivo: exige `--yes` e é bloqueado em produção |
| `bun test` | suíte completa |
| `bun run test:unit` | só unidade — sem container, sem rede |
| `bun run test:integration` | PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | corridas com processos de verdade |
| `bun run test:load` | teste de carga e seu relatório |
| `bun run compose:logs` | logs de todos os serviços |

Os testes de integração e concorrência precisam da stack no ar (`bun run compose:up`).

## API

### Carteiras

```http
POST /wallets
```

```json
{ "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" } }
```

Saldo inicial maior que zero gera uma transação interna `OPENING` com lançamento `CREDIT` **na mesma transação SQL**. `version` fica em `1`: a abertura é a criação, não uma movimentação.

```http
GET  /wallets/:walletId
GET  /wallets/:walletId/ledger?cursor=...&limit=50
POST /wallets/:walletId/reconciliation
```

O `cursor` é opaco e estável sobre `(created_at, id)` — nunca `OFFSET`, que pula ou repete linha quando a tabela recebe insert durante a paginação. `limit` aceita de 1 a 200.

A reconciliação **não corrige** divergência: se os dois lados discordam, não se sabe qual está certo, e corrigir destruiria a evidência do bug. Ela loga, sinaliza `consistent: false` e deixa a decisão para um humano.

### Transações

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
```

```json
{ "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" } }
```

O header `Idempotency-Key` é **obrigatório** — é a fonte da verdade da idempotência, e aceitar sem ele seria aceitar uma operação sem identidade.

```http
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
```

### Mapa de status

| Situação | Status | Corpo |
|---|---|---|
| Aplicada, ou replay da aplicação original | `200` | `transactionId`, `status`, `balance`, `idempotentReplay` |
| Aceita, aguardando a referência chegar | `202` | `status: PENDING_REFERENCE` |
| Carteira criada | `201` | a carteira |
| Payload inválido | `400` | `error: INVALID_PAYLOAD`, `retryable: false` |
| Conflito de idempotência, operação duplicada, carteira duplicada | `409` | `error` nomeando o conflito |
| Rejeição por regra de negócio | `422` | `failureCode` |
| Falha transitória de infraestrutura | `503` + `Retry-After` | `retryable: true` |

O que está em jogo aqui: colapsar essas situações num código só obriga o provedor a interpretar mensagem de erro para decidir se pode reenviar. Essa é a diferença entre uma integração que se recupera sozinha e uma que gera ticket.

`422` e não `400` na rejeição de negócio porque a requisição estava **bem formada e foi compreendida** — foi o domínio que disse não.

### Correlação

Todo endpoint aceita `X-Correlation-Id` e o devolve na resposta. Se o cliente não mandar, um é gerado. O id atravessa HTTP, outbox, SQS e consumer: sem ele, investigar um incidente financeiro é costurar logs de três sistemas sem ligação entre eles.

## Health checks

```http
GET /health/live     # o processo está vivo — não consulta dependência externa
GET /health/ready    # PostgreSQL e SQS alcançáveis, com latência de cada probe
```

Os dois são abertos, sem autenticação: readiness precisa responder mesmo com o Keycloak fora.

`/health/ready` devolve `200` quando tudo responde e `503` quando alguma probe falha, sempre com o detalhe de cada uma:

```json
{
  "status": "ok",
  "probes": [
    { "name": "postgres", "ok": true, "latencyMs": 2 },
    { "name": "sqs",      "ok": true, "latencyMs": 11 }
  ]
}
```

## Consumer SQS

O serviço `consumer` do Compose consome `wager-transactions.fifo` e **reutiliza o mesmo use case da entrada HTTP** — duas implementações da mesma regra financeira divergem na primeira correção aplicada num caminho e esquecida no outro.

| Comportamento | Como |
|---|---|
| Deduplicação | inbox persistente por `(consumerName, messageId)`, usando o `messageId` do **envelope** (identidade no provedor), não o id do broker — que muda quando o provedor reenvia |
| `ack` | **somente após o commit**. Dar ack antes é perder a mensagem se o processo morrer com trabalho não confirmado |
| Erro de negócio | commita a rejeição e dá ack. Reenviar não muda o resultado; manter na fila é loop infinito |
| Erro transitório | sem ack, devolve a visibilidade com espera curta. No limite de entregas, deixa o redrive do broker agir |
| Erro permanente | vai **direto** para a DLQ com o motivo em atributo, em vez de gastar cinco entregas inúteis |
| `SIGTERM` | drena: para de buscar, espera as mensagens em andamento, e devolve a visibilidade das que chegaram depois do pedido de parada |

Ver o drain acontecendo:

```bash
docker compose logs -f consumer &
docker compose stop -t 40 consumer
```

## Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada de operações; `maxReceiveCount` 5 |
| `wager-transactions-dlq.fifo` | dead-letter |

Criadas automaticamente quando o LocalStack fica pronto, por `docker/localstack/init-queues.sh`. O script é idempotente, então reiniciar o container não quebra nada.

## Estrutura

```
src/
  domain/           TypeScript puro — sem NestJS, sem ORM, sem SQS
  application/      casos de uso e portas
  infrastructure/   MikroORM, SQS, HTTP, Keycloak
test/
  unit/             sem infraestrutura
  integration/      PostgreSQL e LocalStack reais em containers
  concurrency/      múltiplos processos, paralelismo real
  load/             teste de carga
```

A fronteira do `src/domain/` é verificável: `grep -rE "@nestjs/|@mikro-orm/" src/domain` precisa voltar vazio.
