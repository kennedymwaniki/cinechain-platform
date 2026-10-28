import { z } from 'zod';

/** Configuration for db:migrate / db:reset only. Never loaded by the app. */
const schema = z.object({
  DATABASE_ADMIN_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_APP_PASSWORD: z.string().min(12),
  DB_IDENTITY_PASSWORD: z.string().min(12),
  DB_CONTROL_PASSWORD: z.string().min(12),
  DB_SWEEPER_PASSWORD: z.string().min(12),
});

export type MigrateConfig = z.infer<typeof schema>;

export function loadMigrateConfig(): MigrateConfig {
  try {
    process.loadEnvFile('.env');
  } catch {
    // rely on the real environment
  }
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid migration configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
