import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { RedisFactory } from '../redis/redis.module';

/**
 * Socket.IO across API instances via Redis pub/sub, on two DEDICATED clients:
 * a subscriber connection cannot issue normal commands, and sharing one with
 * BullMQ's blocking commands would stall broadcasts.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly adapter: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext, corsOrigins: string[]) {
    super(app);
    const redis = app.get(RedisFactory);
    // The adapter needs an offline queue: it subscribes before the socket is up.
    const pub = redis.get('socketio:pub', { enableOfflineQueue: true });
    const sub = redis.get('socketio:sub', { enableOfflineQueue: true });
    this.adapter = createAdapter(pub, sub, { key: 'cinechain:sio' });
    this.corsOrigins = corsOrigins;
  }

  private readonly corsOrigins: string[];

  override createIOServer(port: number, options?: ServerOptions): Server {
    // Nest passes a partial object typed as the full ServerOptions.
    const merged = { ...options, cors: { origin: this.corsOrigins, credentials: true } } as ServerOptions;
    const server = super.createIOServer(port, merged) as Server;
    server.adapter(this.adapter);
    return server;
  }
}
