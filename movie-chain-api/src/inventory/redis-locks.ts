import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { RedisFactory } from '../redis/redis.module';

/**
 * Both tenant AND screening inside ONE hash tag (correction 3): every key a
 * script touches lands in the same cluster slot, and two tenants can never
 * collide even if their screening and seat ids were identical.
 */
export const holdTag = (tenantId: string, screeningId: string) => `{t:${tenantId}:scr:${screeningId}}`;
export const lockKey = (tenantId: string, screeningId: string, seatId: string) =>
  `lock:${holdTag(tenantId, screeningId)}:seat:${seatId}`;
export const manifestKey = (tenantId: string, screeningId: string, holdId: string) =>
  `hold:${holdTag(tenantId, screeningId)}:${holdId}`;
export const contestedKey = (tenantId: string, screeningId: string, holdId: string) =>
  `${manifestKey(tenantId, screeningId, holdId)}:contested`;
export const versionKey = (tenantId: string, screeningId: string) => `seatver:${holdTag(tenantId, screeningId)}`;

interface Script {
  name: string;
  body: string;
  sha: string;
}

function load(name: string): Script {
  const body = readFileSync(join(__dirname, 'scripts', `${name}.lua`), 'utf8');
  return { name, body, sha: createHash('sha1').update(body).digest('hex') };
}

export type AcquireResult = { ok: true; ttlMs: number; version: number } | { ok: false; conflictSeatIds: string[] };

export interface HoldRef {
  tenantId: string;
  screeningId: string;
  holdId: string;
  seatIds: readonly string[];
}

/**
 * The Redis fast path. Every state change is ONE script: there is no
 * EXISTS-then-SET anywhere in TypeScript. Errors propagate; the caller runs
 * these through the RedisHealthBreaker and falls back to Postgres alone.
 */
@Injectable()
export class RedisLocks implements OnModuleInit {
  private readonly log = new Logger(RedisLocks.name);
  private readonly scripts = { acquire: load('acquire'), release: load('release'), extend: load('extend') };

  constructor(private readonly redis: RedisFactory) {}

  private get client(): Redis {
    return this.redis.get('locks');
  }

  /** SCRIPT LOAD once at boot. If Redis is down now, the first EVALSHA loads it later. */
  async onModuleInit(): Promise<void> {
    try {
      const c = this.client;
      if (c.status !== 'ready')
        await new Promise<void>((ok, fail) => {
          const t = setTimeout(() => fail(new Error('redis not ready within 3s')), 3000);
          c.once('ready', () => (clearTimeout(t), ok()));
        });
      for (const s of Object.values(this.scripts)) await c.script('LOAD', s.body);
    } catch (e) {
      this.log.warn(`could not preload hold scripts (${(e as Error).message}); will load on first use`);
    }
  }

  private async run(s: Script, keys: string[], args: (string | number)[]): Promise<unknown> {
    try {
      return await this.client.evalsha(s.sha, keys.length, ...keys, ...args);
    } catch (e) {
      if (!String((e as Error).message).includes('NOSCRIPT')) throw e;
      await this.client.script('LOAD', s.body); // Redis restarted and lost its script cache
      return this.client.evalsha(s.sha, keys.length, ...keys, ...args);
    }
  }

  async acquire(h: HoldRef, ttlMs: number, manifest: object): Promise<AcquireResult> {
    const keys = [
      ...h.seatIds.map((s) => lockKey(h.tenantId, h.screeningId, s)),
      manifestKey(h.tenantId, h.screeningId, h.holdId),
      versionKey(h.tenantId, h.screeningId),
    ];
    const out = (await this.run(this.scripts.acquire, keys, [
      h.holdId,
      ttlMs,
      JSON.stringify(manifest),
      h.seatIds.length,
      `hold:${holdTag(h.tenantId, h.screeningId)}:`,
      ':contested',
    ])) as number[];
    if (out[0] === 1) return { ok: true, ttlMs: out[1]!, version: out[2]! };
    return { ok: false, conflictSeatIds: out.slice(1).map((i) => h.seatIds[i - 1]!) };
  }

  async release(h: HoldRef): Promise<{ released: number; version: number }> {
    const keys = [
      ...h.seatIds.map((s) => lockKey(h.tenantId, h.screeningId, s)),
      manifestKey(h.tenantId, h.screeningId, h.holdId),
      versionKey(h.tenantId, h.screeningId),
    ];
    const [released, version] = (await this.run(this.scripts.release, keys, [h.holdId, h.seatIds.length])) as number[];
    return { released: released!, version: version! };
  }

  /** Returns the number of seats now held by someone else (0 = fully re-armed). */
  async extend(h: HoldRef, ttlMs: number): Promise<number> {
    const keys = [...h.seatIds.map((s) => lockKey(h.tenantId, h.screeningId, s)), manifestKey(h.tenantId, h.screeningId, h.holdId)];
    return (await this.run(this.scripts.extend, keys, [h.holdId, ttlMs, h.seatIds.length])) as number;
  }

  async isContested(h: Omit<HoldRef, 'seatIds'>): Promise<boolean> {
    return (await this.client.exists(contestedKey(h.tenantId, h.screeningId, h.holdId))) === 1;
  }

  async currentVersion(tenantId: string, screeningId: string): Promise<number> {
    return Number((await this.client.get(versionKey(tenantId, screeningId))) ?? 0);
  }

  /** Seat-map version for clients to detect a missed update (step 21). */
  async bumpVersion(tenantId: string, screeningId: string): Promise<number> {
    return this.client.incr(versionKey(tenantId, screeningId));
  }
}
