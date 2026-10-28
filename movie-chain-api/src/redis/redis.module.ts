import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/**
 * Hands out DEDICATED ioredis connections by name. BullMQ issues blocking
 * commands and the Socket.IO adapter holds a subscriber connection; sharing
 * either with the cache stalls the others (step 21). One name, one client.
 */
@Injectable()
export class RedisFactory implements OnApplicationShutdown {
  private readonly log = new Logger(RedisFactory.name);
  private readonly clients = new Map<string, Redis>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  get(name: string, extra: RedisOptions = {}): Redis {
    let client = this.clients.get(name);
    if (!client) {
      const options: RedisOptions = {
        connectionName: `cinechain:${name}`,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        ...extra,
      };
      // ioredis' overloads are not written for exactOptionalPropertyTypes;
      // RedisOptions is the documented type of this argument.
      client = new Redis(this.cfg.redis.url, options as never);
      client.on('error', (e: Error) => this.log.warn(`redis[${name}] ${e.message}`));
      this.clients.set(name, client);
    }
    return client;
  }

  /** The general-purpose app connection: cache, locks, rate limits. */
  get app(): Redis {
    return this.get('app');
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.quit()));
  }
}

@Global()
@Module({ providers: [RedisFactory], exports: [RedisFactory] })
export class RedisModule {}
