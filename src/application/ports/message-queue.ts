export interface QueueMessage {
  /** Identificador do broker, usado para dar ack. */
  readonly receiptHandle: string;
  /** Id atribuido pelo broker. Nao e o messageId do envelope. */
  readonly brokerMessageId: string;
  readonly body: string;
  /** Quantas vezes esta mensagem foi entregue. */
  readonly receiveCount: number;
  /**
   * Grupo de ordenacao do broker — a `walletId`, no nosso caso.
   *
   * O FIFO do SQS **entrega varias mensagens do mesmo grupo num mesmo
   * ReceiveMessage**, em ordem. Quem consome e que precisa preservar essa
   * ordem: processar o lote todo em paralelo reordenaria operacoes da mesma
   * carteira.
   */
  readonly groupId: string | undefined;
}

export interface MessageQueue {
  /** Long polling: devolve ate `max` mensagens, esperando ate `waitSeconds`. */
  receive(max: number, waitSeconds: number): Promise<readonly QueueMessage[]>;

  /** Remove a mensagem da fila. Chamado **somente depois do commit**. */
  ack(message: QueueMessage): Promise<void>;

  /**
   * Devolve a mensagem para a fila agora, em vez de esperar o visibility
   * timeout expirar. Usado no shutdown e no retry de falha transitoria.
   */
  releaseVisibility(message: QueueMessage, seconds: number): Promise<void>;

  /**
   * Encaminha para a dead-letter e dá ack na original.
   *
   * Erro permanente nao melhora com retry: mandar direto evita cinco entregas
   * inuteis antes de o `maxReceiveCount` fazer o mesmo.
   */
  sendToDeadLetter(message: QueueMessage, reason: string): Promise<void>;
}

export const MESSAGE_QUEUE = Symbol("MESSAGE_QUEUE");
