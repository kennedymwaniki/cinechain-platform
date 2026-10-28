/**
 * Boots the real HTTP stack (guards, interceptor, controllers) against the
 * Testcontainers database, without Redis/MinIO: those are not on the auth or
 * tenancy path. Signing keys are generated into a temp dir per run.
 */
import { type INestApplication, Module, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditModule } from '../../src/audit/audit.module';
import { AuthModule } from '../../src/auth/auth.module';
import { CatalogueModule } from '../../src/catalogue/catalogue.module';
import { PublicDiscoveryModule } from '../../src/discovery/discovery.module';
import { InventoryModule } from '../../src/inventory/inventory.module';
import { RedisModule } from '../../src/redis/redis.module';
import { SchedulingModule } from '../../src/scheduling/scheduling.module';
import { StorageModule } from '../../src/storage/storage.module';
import { CommonModule } from '../../src/common/common.module';
import { AUDIENCES } from '../../src/auth/key-store';
import { APP_CONFIG, loadConfig } from '../../src/config/app-config';
import { ConfigModule } from '../../src/config/config.module';
import { ControlAppModule } from '../../src/control/control-app.module';
import { IdentityModule } from '../../src/identity/identity.module';
import { StaffModule } from '../../src/staff/staff.module';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { VenueModule } from '../../src/venue/venue.module';

let keysDir: string | undefined;

/** One key set per test process, so tokens from one booted app verify in another. */
export function testKeysDir(): string {
  if (keysDir) return keysDir;
  const dir = (keysDir = mkdtempSync(join(tmpdir(), 'cinechain-keys-')));
  for (const kid of AUDIENCES) {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(dir, `${kid}.pem`), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  return dir;
}

export function testConfig(urls: { appUrl: string; identityUrl: string }, extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.appUrl,
    IDENTITY_DATABASE_URL: urls.identityUrl,
    REDIS_URL: 'redis://127.0.0.1:1', // unused on these paths
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_ACCESS_KEY: 'unused',
    S3_SECRET_KEY: 'unused',
    S3_BUCKET: 'unused',
    JWT_KEYS_DIR: testKeysDir(),
    LOG_LEVEL: 'error',
    ...extra,
  });
}

export async function bootTestApp(
  urls: { appUrl: string; identityUrl: string },
  opts: { modules?: Type[]; env?: Record<string, string> } = {},
): Promise<INestApplication> {
  @Module({ imports: [ConfigModule, TenancyModule, AuditModule, CommonModule, AuthModule, IdentityModule, StaffModule, VenueModule, CatalogueModule, SchedulingModule, InventoryModule, PublicDiscoveryModule, StorageModule, RedisModule, ...(opts.modules ?? [])] })
  class TestAppModule {}

  const ref = await Test.createTestingModule({ imports: [TestAppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig(urls, opts.env))
    .compile();
  const app = ref.createNestApplication({ logger: ['error'] });
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

/** Boots the control-plane module in-process against the test containers. */
export async function bootControlApp(
  urls: { appUrl: string; identityUrl: string; controlUrl: string },
  redisUrl: string,
  env: Record<string, string> = {},
): Promise<INestApplication> {
  const ref = await Test.createTestingModule({ imports: [ControlAppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig(urls, { CONTROL_DATABASE_URL: urls.controlUrl, REDIS_URL: redisUrl, ...env }))
    .compile();
  const app = ref.createNestApplication({ logger: ['error'] });
  await app.init();
  return app;
}
