/**
 * Starts ONE real postgres:17-alpine container per test run (never a mock,
 * never sqlite), runs the full migration set into it, and hands the
 * connection URLs to the tests via `inject('db')`.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../tools/db-migrate';

export const PASSWORDS = {
  DB_APP_PASSWORD: 'test-app-password',
  DB_IDENTITY_PASSWORD: 'test-identity-password',
  DB_CONTROL_PASSWORD: 'test-control-password',
  DB_SWEEPER_PASSWORD: 'test-sweeper-password',
} as const;

declare module 'vitest' {
  export interface ProvidedContext {
    db: { adminUrl: string; appUrl: string; identityUrl: string; controlUrl: string; sweeperUrl: string };
  }
}

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('cinechain')
    .withUsername('cinechain_admin')
    .withPassword('cinechain_admin')
    .start();
  const host = container.getHost();
  const port = container.getPort();
  const url = (user: string, pw: string) => `postgres://${user}:${pw}@${host}:${port}/cinechain`;
  const adminUrl = url('cinechain_admin', 'cinechain_admin');

  await migrate({ DATABASE_ADMIN_URL: adminUrl, ...PASSWORDS }, () => {});

  project.provide('db', {
    adminUrl,
    appUrl: url('cinechain_app', PASSWORDS.DB_APP_PASSWORD),
    identityUrl: url('cinechain_identity', PASSWORDS.DB_IDENTITY_PASSWORD),
    controlUrl: url('cinechain_control', PASSWORDS.DB_CONTROL_PASSWORD),
    sweeperUrl: url('cinechain_sweeper', PASSWORDS.DB_SWEEPER_PASSWORD),
  });

  return async () => {
    await container?.stop();
  };
}
