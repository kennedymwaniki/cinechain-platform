/** e2e: the same migrated Postgres as the other suites, plus a real Redis for BullMQ. */
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import pgSetup from './global-setup';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
    s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string };
  }
}

let redis: StartedTestContainer | undefined;
let minio: StartedTestContainer | undefined;

export default async function setup(project: TestProject) {
  const stopPg = await pgSetup(project);
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  project.provide('redisUrl', `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);

  // The same minimal image as docker-compose.yml; the bucket is created with its bundled `mc`.
  minio = await new GenericContainer('cgr.dev/chainguard/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_USER: 'test',
      MINIO_ROOT_PASSWORD: 'test-minio-secret',
      MC_HOST_local: 'http://test:test-minio-secret@localhost:9000',
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  const mb = await minio.exec(['mc', 'mb', 'local/test-media']);
  if (mb.exitCode !== 0) throw new Error(`could not create test bucket: ${mb.output}`);
  project.provide('s3', {
    endpoint: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
    accessKey: 'test',
    secretKey: 'test-minio-secret',
    bucket: 'test-media',
  });

  return async () => {
    await minio?.stop();
    await redis?.stop();
    await stopPg();
  };
}
