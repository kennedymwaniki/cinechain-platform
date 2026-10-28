import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { QueueHealth } from '../queue/queue.module';
import { RedisFactory } from '../redis/redis.module';
import { StorageService } from '../storage/storage.service';

type State = 'up' | 'down';
const CHECK_TIMEOUT_MS = 2000;

function withTimeout(p: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
  ]);
}

@ApiTags('health')
@ApiBearerAuth()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: TenantDb,
    private readonly redis: RedisFactory,
    private readonly queue: QueueHealth,
    private readonly storage: StorageService,
  ) {}

  /** Reaches every datastore for real. 503 names whichever one failed. */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const probe = async (fn: () => Promise<unknown>): Promise<State> => {
      try {
        await withTimeout(fn());
        return 'up';
      } catch {
        return 'down';
      }
    };
    const [postgres, redis, queue, storage] = await Promise.all([
      probe(() => this.db.ping()),
      probe(() => this.redis.app.ping()),
      probe(() => this.queue.ping()),
      probe(() => this.storage.ping()),
    ]);
    const components = { postgres, redis, queue, storage };
    const ok = Object.values(components).every((s) => s === 'up');
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', ...components };
  }
}
