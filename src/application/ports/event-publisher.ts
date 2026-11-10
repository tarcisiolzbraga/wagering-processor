import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface PublishOutcome {
  readonly publishedIds: readonly string[];
  readonly failures: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

/**
 * Publica eventos de integracao. Resultado **parcial** de proposito: um lote
 * pode ter sucesso em algumas mensagens e falhar em outras, e tratar o lote
 * como tudo-ou-nada republicaria o que ja saiu.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome>;
}

export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");
