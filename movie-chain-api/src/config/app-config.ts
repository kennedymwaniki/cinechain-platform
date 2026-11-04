import { envSchema, type Env } from './env.schema';

export interface AppConfig {
  env: Env['NODE_ENV'];
  port: number;
  controlPort: number;
  logLevel: Env['LOG_LEVEL'];
  logFile: { api: string | null; control: string | null };
  corsOrigins: string[];
  publicUrl: string;
  tenantBaseDomain: string;
  db: { url: string; poolMax: number; reportingPoolMax: number; identityUrl: string; controlUrl: string | null; sweeperUrl: string | null };
  onboarding: { attempts: number };
  redis: { url: string };
  payments: { mpesaWebhookSecret: string; cardWebhookSecret: string };
  tickets: { codeSecret: string };
  metricsToken: string | null;
  rateLimit: { perAddressRps: number };
  otlpTracesUrl: string | null;
  storage: { endpoint: string; region: string; accessKey: string; secretKey: string; bucket: string };
  auth: {
    keysDir: string;
    issuer: string;
    accessTtl: { staff: number; consumer: number; control: number };
    refreshTtl: number;
    google: { clientId: string; clientSecret: string; callbackUrl: string } | null;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigValidationError extends Error {}

/**
 * The ONLY place in the codebase that reads process.env (enforced by lint).
 * `.env` is loaded without overriding variables already set in the shell,
 * so `DATABASE_URL= pnpm start` really does run with an empty value.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (source === process.env) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // no .env file: rely on the real environment
    }
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigValidationError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    controlPort: e.CONTROL_PORT,
    logLevel: e.LOG_LEVEL,
    logFile: { api: e.LOG_FILE ?? null, control: e.LOG_FILE_CONTROL ?? null },
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: e.APP_PUBLIC_URL,
    tenantBaseDomain: e.TENANT_BASE_DOMAIN,
    db: {
      url: e.DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
      reportingPoolMax: e.DATABASE_REPORTING_POOL_MAX,
      identityUrl: e.IDENTITY_DATABASE_URL,
      controlUrl: e.CONTROL_DATABASE_URL ?? null,
      sweeperUrl: e.SWEEPER_DATABASE_URL ?? null,
    },
    onboarding: { attempts: e.ONBOARDING_ATTEMPTS },
    redis: { url: e.REDIS_URL },
    payments: {
      // Development defaults only; production refuses to boot without real secrets (env.schema).
      mpesaWebhookSecret: e.PAYMENT_WEBHOOK_SECRET_MPESA ?? 'dev-only-mpesa-webhook-secret',
      cardWebhookSecret: e.PAYMENT_WEBHOOK_SECRET_CARD ?? 'dev-only-card-webhook-secret',
    },
    tickets: { codeSecret: e.TICKET_CODE_SECRET ?? 'dev-only-ticket-code-secret' },
    metricsToken: e.METRICS_TOKEN ?? null,
    rateLimit: { perAddressRps: e.RATE_LIMIT_PER_ADDRESS_RPS },
    otlpTracesUrl: e.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? null,
    storage: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      accessKey: e.S3_ACCESS_KEY,
      secretKey: e.S3_SECRET_KEY,
      bucket: e.S3_BUCKET,
    },
    auth: {
      keysDir: e.JWT_KEYS_DIR,
      issuer: e.JWT_ISSUER,
      accessTtl: {
        staff: e.JWT_ACCESS_TTL_STAFF,
        consumer: e.JWT_ACCESS_TTL_CONSUMER,
        control: e.JWT_ACCESS_TTL_CONTROL,
      },
      refreshTtl: e.JWT_REFRESH_TTL,
      google:
        e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.GOOGLE_CALLBACK_URL
          ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, callbackUrl: e.GOOGLE_CALLBACK_URL }
          : null,
    },
  };
}
