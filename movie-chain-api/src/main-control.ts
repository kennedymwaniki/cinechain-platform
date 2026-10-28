import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigValidationError, loadConfig } from './config/app-config';
import { ControlAppModule } from './control/control-app.module';
import { setupControlSwagger } from './common/swagger';

/** The control plane: a separate process, on :3001, as cinechain_control. */
async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.db.controlUrl) throw new ConfigValidationError('Invalid environment configuration:\n  - CONTROL_DATABASE_URL: required for the control plane');
  const app = await NestFactory.create(ControlAppModule, { logger: [cfg.logLevel, 'error', 'warn', 'fatal'] });
  app.enableShutdownHooks();
  if (cfg.env !== 'production') setupControlSwagger(app);
  await app.listen(cfg.controlPort, '127.0.0.1'); // never exposed publicly
  new Logger('bootstrap').log(`control plane listening on 127.0.0.1:${cfg.controlPort}`);
}

bootstrap().catch((err: unknown) => {
  console.error(err instanceof ConfigValidationError ? err.message : err);
  process.exit(1);
});
