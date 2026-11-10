import { InvariantViolationError } from "../shared/domain-error";

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date | undefined;
}

/**
 * Deduplicacao persistente de mensagem consumida, por (consumerName, messageId).
 *
 * `consumerName` faz parte da chave de proposito: permite que um segundo
 * consumidor (projecao, auditoria) processe a mesma mensagem sem colidir com a
 * deduplicacao do primeiro.
 *
 * A dedup do SQS FIFO nao substitui isto: a janela dela e de 5 minutos e nao
 * cobre redelivery por visibility timeout, que e exatamente o caso do processo
 * lento ou morto.
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt?: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const [campo, valor] of Object.entries({
      messageId: props.messageId,
      consumerName: props.consumerName,
      payloadHash: props.payloadHash,
    })) {
      if (typeof valor !== "string" || valor.trim().length === 0) {
        throw new InvariantViolationError(`inbox sem ${campo}`);
      }
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  /** Reconstrucao a partir da persistencia — nao revalida. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      // Marcar duas vezes significa que a dedup falhou antes de chegar aqui.
      throw new InvariantViolationError(
        `mensagem ${this.consumerName}/${this.messageId} ja estava processada`,
      );
    }
    this._processedAt = at;
  }
}
