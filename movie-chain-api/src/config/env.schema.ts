import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const duration = z.coerce.number().int().positive();
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),
    CONTROL_PORT: port.default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'log', 'debug', 'verbose']).default('log'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    APP_PUBLIC_URL: z.url().default('http://localhost:3000'),
    // Staff sign in at <slug>.<TENANT_BASE_DOMAIN>; without a subdomain they send tenant_slug.
    TENANT_BASE_DOMAIN: z.string().min(3).default('cinechain.app'),

    // Application-plane connection. From step 2 this is the cinechain_app role.
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    // The identity plane: the only role granted on platform.* (step 5).
    IDENTITY_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    // The control plane (main-control.ts) only. Required there, unused by the API.
    CONTROL_DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^postgres(ql)?$/ }).optional()),
    ONBOARDING_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_BUCKET: z.string().min(3),

    JWT_KEYS_DIR: z.string().min(1).default('./keys'),
    JWT_ISSUER: z.string().min(1).default('cinechain'),
    JWT_ACCESS_TTL_STAFF: duration.default(600), // seconds
    JWT_ACCESS_TTL_CONSUMER: duration.default(900),
    JWT_ACCESS_TTL_CONTROL: duration.default(600),
    JWT_REFRESH_TTL: duration.default(60 * 60 * 24 * 30),

    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_CALLBACK_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  })
  .superRefine((env, ctx) => {
    // The Google trio is all-or-nothing: a half-configured provider fails at
    // the first real sign-in, which is far worse than failing at boot.
    const google = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL];
    const set = google.filter((v) => v !== undefined).length;
    if (set !== 0 && set !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_ID'],
        message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL must be set together',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
