import { WagerTransactionSource } from "../../domain/wagering/wager-transaction-kind";
import type { Logger } from "../ports/logger";
import type { MessageQueue, QueueMessage } from "../ports/message-queue";
import { FailureKind, classifyFailure } from "../shared/failure-classification";
import {
  SubmitOutcome,
  type SubmitWagerTransaction,
} from "./submit-wager-transaction";
import { parseWagerTransactionEnvelope } from "./wager-transaction-message";

export interface ConsumerOptions {
  readonly consumerName: string;
  readonly batchSize: number;
  readonly waitSeconds: number;
  /** Entregas antes de considerar que o retry nao esta ajudando. */
  readonly maxReceiveCount: number;
  /** Segundos de espera ao devolver uma mensagem por falha transitoria. */
  readonly retryVisibilitySeconds: number;
  /**
   * Pausa quando o poll volta vazio.
   *
   * Nao e so economia de chamada: sem ela, um `receive` que responde vazio de
   * imediato — long polling desligado, broker que nao o honra, ou fila vazia
   * com `waitSeconds` baixo — transforma o laco numa espera ativa de
   * microtasks que **starva o event loop**. Nesse estado nem o `setTimeout`
   * nem o handler de SIGTERM chegam a rodar: o processo fica surdo.
   */
  readonly idleDelayMs: number;
}

/** Resultados que significam que a operacao nao foi aplicada. */
const DESCARTADOS: ReadonlySet<SubmitOutcome> = new Set([
  SubmitOutcome.IdempotencyConflict,
  SubmitOutcome.DuplicateExternalTransaction,
]);

export const DEFAULT_CONSUMER_OPTIONS: ConsumerOptions = {
  consumerName: "wager-transactions",
  batchSize: 10,
  waitSeconds: 20,
  maxReceiveCount: 5,
  retryVisibilitySeconds: 5,
  idleDelayMs: 50,
};

/**
 * Consumidor da fila de operacoes.
 *
 * Reutiliza **o mesmo** use case da entrada HTTP: duas implementacoes da mesma
 * regra financeira divergem na primeira correcao aplicada num caminho e
 * esquecida no outro. O que e proprio deste canal — inbox, ack, classificacao
 * de erro — fica aqui, na borda.
 *
 * O `ack` acontece **somente depois do commit**. Dar ack antes e perder a
 * mensagem se o processo morrer com trabalho nao confirmado.
 */
export class WagerTransactionConsumer {
  private rodando = false;
  private drenando = false;
  private emVoo = new Set<Promise<void>>();
  /** Ciclo de poll em curso — `stop()` espera por ele antes de encerrar. */
  private ciclo: Promise<void> | undefined;

  constructor(
    private readonly queue: MessageQueue,
    private readonly submit: SubmitWagerTransaction,
    private readonly logger: Logger,
    private readonly options: ConsumerOptions = DEFAULT_CONSUMER_OPTIONS,
  ) {}

  get running(): boolean {
    return this.rodando;
  }

  /** Loop de long polling. Resolve quando `stop()` termina o dreno. */
  async start(): Promise<void> {
    this.rodando = true;
    // Resetado aqui: sem isso, religar depois de um stop() devolveria toda
    // mensagem para sempre, sem processar nenhuma.
    this.drenando = false;
    this.logger.info("consumer iniciado", { consumerName: this.options.consumerName });

    while (this.rodando) {
      this.ciclo = this.pollOnce().catch((erro: unknown) => {
        // Falha ao buscar da fila nao derruba o consumer: a fila pode voltar.
        this.logger.error("falha ao consultar a fila", {
          reason: erro instanceof Error ? erro.message : String(erro),
        });
        return this.espera(1_000);
      });
      await this.ciclo;
    }

    await this.aguardaEmVoo();
    this.logger.info("consumer encerrado");
  }

  /**
   * Para de buscar mensagens novas e espera as em andamento concluirem.
   *
   * Em SIGTERM e isso que impede matar uma transacao no meio: a mensagem ou
   * termina de ser processada, ou volta para a fila pela visibilidade.
   */
  async stop(): Promise<void> {
    if (!this.rodando) return;
    this.logger.info("consumer drenando", { emVoo: this.emVoo.size });
    this.rodando = false;
    this.drenando = true;

    // Espera o long poll em curso terminar. Sem isso, com `emVoo` vazio o
    // stop() resolveria na hora e o processo sairia **abandonando um lote
    // recem-recebido** — que ficaria invisivel ate o visibility timeout em vez
    // de voltar para a fila imediatamente. O custo e esperar ate
    // `waitSeconds`, que o stop_grace_period do Compose acomoda.
    await this.ciclo?.catch(() => undefined);
    await this.aguardaEmVoo();
  }

  private async pollOnce(): Promise<void> {
    const mensagens = await this.queue.receive(this.options.batchSize, this.options.waitSeconds);
    if (mensagens.length === 0) {
      await this.espera(this.options.idleDelayMs);
      return;
    }

    if (this.drenando) {
      // Chegaram depois do pedido de parada: devolve na hora em vez de deixar
      // invisiveis ate o timeout expirar.
      await Promise.all(mensagens.map((m) => this.devolve(m, 0)));
      return;
    }

    // O FIFO **entrega varias mensagens do mesmo grupo num mesmo
    // ReceiveMessage**, em ordem. Processar o lote todo em paralelo
    // reordenaria operacoes da mesma carteira — um ROLLBACK poderia ultrapassar
    // a BET que ele reverte e cair em PENDING_REFERENCE sem necessidade.
    //
    // Entao: sequencial **dentro** do grupo, paralelo **entre** grupos. Isso
    // preserva a ordem onde ela tem significado sem serializar carteiras que
    // nao tem relacao nenhuma.
    const porGrupo = new Map<string, QueueMessage[]>();
    for (const mensagem of mensagens) {
      // Sem grupo (fila nao-FIFO), cada mensagem e seu proprio grupo.
      const chave = mensagem.groupId ?? mensagem.brokerMessageId;
      const grupo = porGrupo.get(chave);
      if (grupo) grupo.push(mensagem);
      else porGrupo.set(chave, [mensagem]);
    }

    const trabalhos = [...porGrupo.values()].map((grupo) => {
      const trabalho = this.handleEmOrdem(grupo).finally(() => this.emVoo.delete(trabalho));
      this.emVoo.add(trabalho);
      return trabalho;
    });
    // allSettled: uma falha nao pode parar a espera pelas outras do lote.
    await Promise.allSettled(trabalhos);
  }

  private async handleEmOrdem(grupo: readonly QueueMessage[]): Promise<void> {
    for (const mensagem of grupo) {
      await this.handle(mensagem);
    }
  }

  private async handle(mensagem: QueueMessage): Promise<void> {
    const log = this.logger.child({
      brokerMessageId: mensagem.brokerMessageId,
      receiveCount: mensagem.receiveCount,
    });

    try {
      const envelope = parseWagerTransactionEnvelope(mensagem.body);
      const { data } = envelope;

      const resultado = await this.submit.run({
        idempotencyKey: data.idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        source: WagerTransactionSource.Queue,
        correlationId: data.correlationId ?? envelope.messageId,
        inbox: {
          consumerName: this.options.consumerName,
          messageId: envelope.messageId,
        },
      });

      // Todo resultado de negocio e terminal: ack. Inclui rejeicao e replay —
      // reenviar nao muda o resultado, e manter na fila seria loop infinito.
      //
      // Falhar o ack e seguro: o trabalho esta commitado, a mensagem sera
      // reentregue e a inbox deduplica. Por isso e aviso, nao erro.
      await this.tentaFila(
        () => this.queue.ack(mensagem),
        "nao foi possivel dar ack; a reentrega sera deduplicada pela inbox",
        mensagem,
      );

      const campos = {
        messageId: envelope.messageId,
        outcome: resultado.outcome,
        transactionId: resultado.transactionId,
        failureCode: resultado.failureCode,
        providerId: data.providerId,
        walletId: data.walletId,
        idempotentReplay: resultado.idempotentReplay,
      };

      // Conflito e rejeicao sem linha de transacao sao **operacao descartada**:
      // ficam em warn, porque em info passariam invisiveis ao alerta.
      if (DESCARTADOS.has(resultado.outcome) || resultado.transactionId === undefined) {
        log.warn("operacao descartada", campos);
      } else {
        log.info("mensagem processada", campos);
      }
    } catch (erro: unknown) {
      await this.trataFalha(mensagem, erro, log);
    }
  }

  private async trataFalha(
    mensagem: QueueMessage,
    erro: unknown,
    log: Logger,
  ): Promise<void> {
    const classe = classifyFailure(erro);
    const reason = erro instanceof Error ? erro.message : String(erro);

    if (classe === FailureKind.Business) {
      // Regra de negocio recusou algo que nem virou linha. Terminal.
      await this.tentaFila(
        () => this.queue.ack(mensagem),
        "nao foi possivel dar ack na recusa de negocio",
        mensagem,
      );
      log.warn("mensagem recusada por regra de negocio", { reason });
      return;
    }

    if (classe === FailureKind.Permanent) {
      // Se o envio para a DLQ falhar, a mensagem fica na fila e o redrive do
      // broker a levara depois do limite de entregas. Nao se perde.
      await this.tentaFila(
        () => this.queue.sendToDeadLetter(mensagem, reason),
        "nao foi possivel enviar para a DLQ; o redrive do broker assumira",
        mensagem,
      );
      log.error("mensagem enviada para a DLQ", { reason, failureKind: classe });
      return;
    }

    // Transitoria: nao da ack. Devolve para a fila com espera curta.
    if (mensagem.receiveCount >= this.options.maxReceiveCount) {
      // O redrive do broker faria isso de qualquer forma; registrar aqui deixa
      // explicito que o limite foi atingido, e nao que a mensagem sumiu.
      log.error("limite de entregas atingido; o redrive levara para a DLQ", {
        reason,
        receiveCount: mensagem.receiveCount,
      });
      return;
    }

    await this.devolve(mensagem, this.options.retryVisibilitySeconds);
    log.warn("falha transitoria; mensagem devolvida para a fila", { reason });
  }

  private devolve(mensagem: QueueMessage, segundos: number): Promise<void> {
    // Se nao der para devolver, o visibility timeout resolve sozinho.
    return this.tentaFila(
      () => this.queue.releaseVisibility(mensagem, segundos),
      "nao foi possivel devolver a visibilidade",
      mensagem,
    );
  }

  /**
   * Operacao de fila que nao pode derrubar o tratamento da mensagem.
   *
   * Sem isso, um `ReceiptHandleIsInvalid` ou um throttle no ack escapava do
   * `handle`, engolia o log daquela mensagem e reaparecia la em cima como
   * "falha ao consultar a fila" — diagnostico enganoso.
   */
  private async tentaFila(
    operacao: () => Promise<void>,
    aviso: string,
    mensagem: QueueMessage,
  ): Promise<void> {
    try {
      await operacao();
    } catch (erro: unknown) {
      this.logger.warn(aviso, {
        brokerMessageId: mensagem.brokerMessageId,
        reason: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  private async aguardaEmVoo(): Promise<void> {
    while (this.emVoo.size > 0) {
      // allSettled: uma mensagem que falhou nao pode interromper a espera
      // pelas outras — seria encerrar o processo com trabalho em andamento.
      await Promise.allSettled([...this.emVoo]);
    }
  }

  private espera(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
