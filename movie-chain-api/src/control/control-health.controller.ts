import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { QueueHealth } from '../queue/queue.module';
import { ControlDb } from '../tenancy/control-db.provider';
import { ControlPublic } from './auth/operator-auth';

@ApiTags('health')
@ApiBearerAuth()
@Controller('admin/health')
export class ControlHealthController {
  constructor(
    private readonly db: ControlDb,
    private readonly queue: QueueHealth,
  ) {}

  @ControlPublic()
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const probe = (p: Promise<unknown>) => p.then(() => 'up' as const, () => 'down' as const);
    const [postgres, queue] = await Promise.all([probe(this.db.ping()), probe(this.queue.ping())]);
    const ok = postgres === 'up' && queue === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', postgres, queue };
  }
}
