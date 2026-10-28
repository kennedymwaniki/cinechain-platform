/** Races run against real Postgres AND real Redis (step 16): never an in-memory Redis, never a mocked pg. */
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import pgSetup from './global-setup';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

let redis: StartedTestContainer | undefined;

export default async function setup(project: TestProject) {
  const stopPg = await pgSetup(project);
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  project.provide('redisUrl', `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);
  return async () => {
    await redis?.stop();
    await stopPg();
  };
}
