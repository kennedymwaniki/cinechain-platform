import { defineConfig } from 'drizzle-kit';

// The hand-written SQL in src/db/migrations is the source of truth: RLS, roles
// and grants cannot be expressed in drizzle-kit. `db:generate` only drafts SQL
// for new tables into drizzle/draft/, which you then copy into a numbered
// migration and review.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle/draft',
});
