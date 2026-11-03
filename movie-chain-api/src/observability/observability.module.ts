import { Global, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { MetricsModule } from './metrics.module';
import { RequestSignalsMiddleware } from './request-signals.middleware';

/**
 * Tenant-attributed signals (PRD §14.1). Logs: PinoLogger (installed in
 * main.ts). Metrics: MetricsModule. Traces: initTracing (main.ts) + the root
 * span opened here for every request.
 */
@Global()
@Module({ imports: [MetricsModule], providers: [RequestSignalsMiddleware], exports: [MetricsModule] })
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestSignalsMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
