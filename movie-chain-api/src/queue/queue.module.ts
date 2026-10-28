import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export const QUEUE_PREFIX = 'cinechain';
export const SYSTEM_QUEUE = 'system';

function connectionFrom(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    // BullMQ requires this for its blocking worker connections.
    maxRetriesPerRequest: null,
  };
}

/** Used only to prove the queue connection is live. No jobs are ever added. */
@Injectable()
export class QueueHealth {
  constructor(@InjectQueue(SYSTEM_QUEUE) private readonly queue: Queue) {}

  /** A real round trip through BullMQ's own connection, not the app's. */
  async ping(): Promise<void> {
    await this.queue.getJobCounts('waiting');
  }
}

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        connection: connectionFrom(cfg.redis.url),
        prefix: QUEUE_PREFIX,
      }),
    }),
    BullModule.registerQueue({ name: SYSTEM_QUEUE }),
  ],
  providers: [QueueHealth],
  exports: [BullModule, QueueHealth],
})
export class QueueModule {}
