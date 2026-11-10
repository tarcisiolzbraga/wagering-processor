# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas de múltiplos provedores de jogos, por HTTP e por fila, com entrega *at-least-once*.

Desafio técnico Jungle Gaming. As decisões de arquitetura e seus trade-offs estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

> **Estado atual: Fase 0 (fundação).** Sobem PostgreSQL, LocalStack (SQS), Keycloak e três instâncias da API com health checks. O domínio financeiro, a API de transações e os workers chegam nas fases seguintes — ver `ARCHITECTURE.md`.

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
