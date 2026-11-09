import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Module, type DynamicModule } from "@nestjs/common";

import { ENV, type Env } from "./config/env";
import { HealthController } from "./infrastructure/http/health/health.controller";
import { ReadinessService } from "./infrastructure/http/health/readiness.service";
import { buildOrmConfig } from "./infrastructure/persistence/mikro-orm.config";

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
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
      ],
    };
  }
}
