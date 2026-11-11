import { sortKeys } from "../shared/canonical-json";
export interface IntegrationEventProps<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
  readonly data: T;
}

/** O que a borda injeta: identidade do evento e rastro de correlacao. */
export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
}

export interface SerializedIntegrationEvent<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: string; // ISO-8601
  readonly version: number;
  readonly data: T;
}

/**
 * Envelope de evento de integracao. `eventType` e `version` ficam **no tipo**,
 * nao em string solta no call site: errar o nome do evento passa a ser erro de
 * compilacao em vez de bug de producao.
 *
 * `data` carrega sempre MoneyProps (string decimal), nunca instancia de Money —
 * o payload precisa ser JSON estavel e versionavel.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  /**
   * Chave de particionamento da publicacao — e a `walletId`, porque a unidade
   * de concorrencia e a wallet. Vira MessageGroupId no SQS FIFO, mantendo a
   * ordem relativa dos eventos de uma mesma carteira. Ordenacao no broker e
   * otimizacao, nao garantia: a garantia continua no banco.
   */
  abstract get partitionKey(): string;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  /**
   * Envelope serializado, gravado no payload da outbox.
   *
   * Chaves ordenadas: dois publicadores que reivindiquem o mesmo evento
   * produzem bytes identicos, e quem compara payloads do outro lado nao ve
   * diferenca que nao existe.
   */
  toJSON(): SerializedIntegrationEvent<T> {
    return sortKeys({
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    });
  }
}
