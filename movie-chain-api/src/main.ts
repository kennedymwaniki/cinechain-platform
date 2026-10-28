import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './common/swagger';
import { ConfigValidationError, loadConfig } from './config/app-config';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  // Validate before Nest starts, so a bad env is one clear error, not a DI stack trace.
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: [cfg.logLevel, 'error', 'warn', 'fatal'] });
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: cfg.corsOrigins, credentials: true });
  app.useWebSocketAdapter(new RedisIoAdapter(app, cfg.corsOrigins));
  app.enableShutdownHooks();
  if (cfg.env !== 'production') setupSwagger(app);
  await app.listen(cfg.port);
  new Logger('bootstrap').log(`application plane listening on :${cfg.port}`);
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigValidationError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
