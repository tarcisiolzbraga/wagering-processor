import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from "@nestjs/common";

import { CLOCK } from "./application/ports/clock";
import { LOGGER, type Logger } from "./application/ports/logger";
import { MESSAGE_QUEUE, type MessageQueue } from "./application/ports/message-queue";
import { ID_GENERATOR } from "./application/ports/id-generator";
import { RECONCILIATION_ALARM } from "./application/ports/reconciliation-alarm";
import { UNIT_OF_WORK, type UnitOfWork } from "./application/ports/unit-of-work";
import { WagerTransactionConsumer } from "./application/wagering/consume-wager-transactions";
import { SubmitWagerTransaction } from "./application/wagering/submit-wager-transaction";
import { WagerTransactionQueries } from "./application/wagering/wager-transaction-queries";
import { OpenWallet } from "./application/wallets/open-wallet";
import { ReconcileWallet } from "./application/wallets/reconcile-wallet";
import { WalletQueries } from "./application/wallets/wallet-queries";
import { ENV, type Env } from "./config/env";
import { correlationIdMiddleware } from "./infrastructure/http/correlation-id.middleware";
import { HealthController } from "./infrastructure/http/health/health.controller";
import { ReadinessService } from "./infrastructure/http/health/readiness.service";
import { ProvidersController, WageringController } from "./infrastructure/http/wagering.controller";
import { WalletsController } from "./infrastructure/http/wallets.controller";
import { SqsMessageQueue } from "./infrastructure/messaging/sqs-message-queue";
import { ConsoleLogger } from "./infrastructure/observability/console-logger";
import { LoggingReconciliationAlarm } from "./infrastructure/observability/logging-reconciliation-alarm";
import { buildOrmConfig } from "./infrastructure/persistence/mikro-orm.config";
import { MikroUnitOfWork } from "./infrastructure/persistence/unit-of-work";
import { SystemClock, UuidV7Generator } from "./infrastructure/system-clock";

@Module({})
export class AppModule implements NestModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        WalletsController,
        WageringController,
        ProvidersController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        {
          provide: MikroORM,
          useFactory: () => MikroORM.init(buildOrmConfig(env)),
        },
        {
          provide: SQSClient,
          useFactory: () =>
            new SQSClient({
              region: env.AWS_REGION,
              endpoint: env.SQS_ENDPOINT,
              credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              },
            }),
        },
        ReadinessService,

        {
          provide: LOGGER,
          useFactory: () => new ConsoleLogger(env.LOG_LEVEL === "trace" ? "debug" : env.LOG_LEVEL, {
            role: env.APP_ROLE,
            pid: process.pid,
          }),
        },
        {
          provide: MESSAGE_QUEUE,
          useFactory: (client: SQSClient) =>
            new SqsMessageQueue(client, env.SQS_QUEUE_URL, env.SQS_DLQ_URL),
          inject: [SQSClient],
        },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        { provide: RECONCILIATION_ALARM, useClass: LoggingReconciliationAlarm },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM) => new MikroUnitOfWork(orm),
          inject: [MikroORM],
        },

        {
          provide: SubmitWagerTransaction,
          useFactory: (uow: UnitOfWork, clock, ids) =>
            new SubmitWagerTransaction(uow, clock, ids),
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
        },
        {
          provide: OpenWallet,
          useFactory: (uow: UnitOfWork, clock, ids) => new OpenWallet(uow, clock, ids),
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
        },
        {
          provide: WalletQueries,
          useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: WagerTransactionQueries,
          useFactory: (uow: UnitOfWork) => new WagerTransactionQueries(uow),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: WagerTransactionConsumer,
          useFactory: (queue: MessageQueue, submit: SubmitWagerTransaction, logger: Logger) =>
            new WagerTransactionConsumer(queue, submit, logger),
          inject: [MESSAGE_QUEUE, SubmitWagerTransaction, LOGGER],
        },
        {
          provide: ReconcileWallet,
          useFactory: (uow: UnitOfWork, alarm) => new ReconcileWallet(uow, alarm),
          inject: [UNIT_OF_WORK, RECONCILIATION_ALARM],
        },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationIdMiddleware).forRoutes("*");
  }
}
