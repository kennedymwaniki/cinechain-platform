/**
 * Steps 13–14 against real Postgres AND real Redis: the guest hold path, the
 * hold token's boundaries, seat-gap prevention end to end, and the durable
 * row as the guarantee (including with Redis unavailable).
 */
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { HoldRepository } from '../../src/inventory/hold.repository';
import { RedisLocks, lockKey } from '../../src/inventory/redis-locks';
import { addStaff, asAdmin, createTenant, TEST_PASSWORD } from '../support/seed';
import { lockSeat, seedScreening } from '../support/seed-screening';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
let app: INestApplication;
let downApp: INestApplication; // same database, Redis unreachable
let redis: Redis;
let A: { tenantId: string; s: Awaited<ReturnType<typeof seedScreening>> };
let B: { tenantId: string; s: Awaited<ReturnType<typeof seedScreening>> };

async function seedTenant(seats = 10, tenantCols = '') {
  return asAdmin(urls.adminUrl, async (c) => {
    const tenantId = (await createTenant(c)).id;
    if (tenantCols) await c.query(`UPDATE tenant SET ${tenantCols} WHERE id = $1`, [tenantId]);
    const s = await seedScreening(c, tenantId, { seats });
    await c.query(`INSERT INTO pricing_rule (tenant_id, seat_class, price_minor, currency, effective_from) VALUES ($1, 'standard', 80000, 'KES', now() - interval '1 day')`, [tenantId]);
    return { tenantId, s };
  });
}

const hold = (a: INestApplication, screeningId: string, seatIds: string[]) =>
  request(a.getHttpServer()).post(`/api/v1/screenings/${screeningId}/holds`).send({ seat_ids: seatIds });

beforeAll(async () => {
  A = await seedTenant();
  B = await seedTenant();
  app = await bootTestApp(urls, { env: { REDIS_URL: inject('redisUrl') } });
  downApp = await bootTestApp(urls, { env: { REDIS_URL: 'redis://127.0.0.1:1' } });
  redis = new Redis(inject('redisUrl'));
});
afterAll(async () => {
  redis.disconnect();
  await Promise.all([app.close(), downApp.close()]);
});

describe('guest holds (step 13)', () => {
  it('a guest with NO Authorization header gets a priced hold; an overlapping request holds nothing', async () => {
    const [a, b, c] = A.s.seatIds;
    const first = await hold(app, A.s.screeningId, [a!, b!]).expect(201);
    expect(first.body).toMatchObject({
      hold_id: expect.any(String),
      hold_token: expect.any(String),
      expires_at: expect.any(String),
      total: { amount_minor: 160000, currency: 'KES' },
    });
    expect(first.body.seats.map((s: { price: unknown }) => s.price)).toEqual([
      { amount_minor: 80000, currency: 'KES' },
      { amount_minor: 80000, currency: 'KES' },
    ]);

    const second = await hold(app, A.s.screeningId, [b!, c!]).expect(409);
    expect(second.body).toEqual({ error: 'seats_unavailable', message: expect.any(String), unavailable_seat_ids: [b] });
    expect(await redis.exists(lockKey(A.tenantId, A.s.screeningId, c!))).toBe(0);
    const { rows } = await asAdmin(urls.adminUrl, (cl) => cl.query('SELECT 1 FROM seat_lock WHERE seat_id = $1', [c]));
    expect(rows).toHaveLength(0);
  });

  it('TTL comes from tenant.hold_seconds; the seat cap from max_seats_per_booking', async () => {
    const t = await seedTenant(6, 'hold_seconds = 120, max_seats_per_booking = 2');
    const res = await hold(app, t.s.screeningId, [t.s.seatIds[0]!]).expect(201);
    const ttl = (Date.parse(res.body.expires_at) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(115);
    expect(ttl).toBeLessThanOrEqual(121);
    const pttl = await redis.pttl(lockKey(t.tenantId, t.s.screeningId, t.s.seatIds[0]!));
    expect(pttl).toBeGreaterThan(115_000);
    expect(pttl).toBeLessThanOrEqual(120_000);

    const many = await hold(app, t.s.screeningId, t.s.seatIds.slice(1, 4)).expect(422);
    expect(many.body).toMatchObject({ error: 'too_many_seats', max_seats: 2 });
  });

  it('a caller-supplied tenant_id is a 400, not an ignored field', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/screenings/${A.s.screeningId}/holds`)
      .send({ seat_ids: [A.s.seatIds[5]], tenant_id: B.tenantId })
      .expect(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it("a token minted for tenant A's screening fails against tenant B's with 401 hold_token_invalid", async () => {
    const h = await hold(app, A.s.screeningId, [A.s.seatIds[6]!]).expect(201);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/screenings/${B.s.screeningId}/seatmap`)
      .set('hold-token', h.body.hold_token)
      .expect(401);
    expect(res.body.error).toBe('hold_token_invalid');
    // and on its own screening it marks the seat "yours"
    const own = await request(app.getHttpServer()).get(`/api/v1/screenings/${A.s.screeningId}/seatmap`).set('hold-token', h.body.hold_token).expect(200);
    expect(own.body.seats.find((s: { id: string }) => s.id === A.s.seatIds[6]).state).toBe('yours');
  });

  it('a hold token is not a bearer credential', async () => {
    const h = await hold(app, A.s.screeningId, [A.s.seatIds[7]!]).expect(201);
    await request(app.getHttpServer()).get('/api/v1/me').set('authorization', `Bearer ${h.body.hold_token}`).expect(403);
    await request(app.getHttpServer()).get('/api/v1/theatres').set('authorization', `Bearer ${h.body.hold_token}`).expect(401);
  });

  it('two tenants with identical screening and seat UUIDs both acquire (the keys differ)', async () => {
    const locks = app.get(RedisLocks);
    const screeningId = crypto.randomUUID();
    const seatIds = [crypto.randomUUID(), crypto.randomUUID()];
    const a = await locks.acquire({ tenantId: A.tenantId, screeningId, holdId: crypto.randomUUID(), seatIds }, 5_000, {});
    const b = await locks.acquire({ tenantId: B.tenantId, screeningId, holdId: crypto.randomUUID(), seatIds }, 5_000, {});
    expect([a.ok, b.ok]).toEqual([true, true]);
  });
});

describe('seat-gap prevention end to end (FR-47)', () => {
  it('rejects a gap-creating choice on a busy screening with a suggestion; a clerk may override, audited', async () => {
    const t = await seedTenant(10);
    const ids = t.s.seatIds;
    // Sell A1, A2, A6..A10: 70 % occupied. Choosing A4 strands A3 and A5.
    await asAdmin(urls.adminUrl, async (c) => {
      for (const i of [0, 1, 5, 6, 7, 8, 9]) await lockSeat(c, t.tenantId, t.s.screeningId, ids[i]!, 'sold');
    });
    const res = await hold(app, t.s.screeningId, [ids[3]!]).expect(409);
    expect(res.body).toMatchObject({ error: 'seat_gap', gap_seat_ids: [ids[2], ids[4]].sort(), suggested_seat_ids: [ids[2]] });

    const staffId = await asAdmin(urls.adminUrl, (c) => addStaff(c, t.tenantId, `clerk-${t.tenantId.slice(0, 6)}@x.test`, 'box_office'));
    const slug = (await asAdmin(urls.adminUrl, (c) => c.query('SELECT slug FROM tenant WHERE id = $1', [t.tenantId]))).rows[0].slug;
    const tok = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/staff/login')
        .send({ email: `clerk-${t.tenantId.slice(0, 6)}@x.test`, password: TEST_PASSWORD, tenant_slug: slug })
    ).body.access_token;
    const bo = await request(app.getHttpServer())
      .post('/api/v1/box-office/holds')
      .set('authorization', `Bearer ${tok}`)
      .send({ screening_id: t.s.screeningId, seat_ids: [ids[3]], gap_override_reason: 'customer wants an aisle-adjacent seat' })
      .expect(201);
    const ttl = (Date.parse(bo.body.expires_at) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(85);
    expect(ttl).toBeLessThanOrEqual(91);
    const rows = await asAdmin(urls.adminUrl, async (c) => ({
      lock: (await c.query('SELECT held_by_staff FROM seat_lock WHERE seat_id = $1', [ids[3]])).rows[0],
      audit: (await c.query(`SELECT actor_id, detail FROM audit_event WHERE tenant_id = $1 AND action = 'hold.seat_gap_override'`, [t.tenantId])).rows,
    }));
    expect(rows.lock.held_by_staff).toBe(staffId);
    expect(rows.audit).toEqual([{ actor_id: staffId, detail: { reason: 'customer wants an aisle-adjacent seat', seat_ids: [ids[3]] } }]);
  });
});

describe('the durable row (step 14)', () => {
  it('a failure between the Redis write and the Postgres insert strands no key', async () => {
    const seat = A.s.seatIds[8]!;
    const spy = vi.spyOn(app.get(HoldRepository), 'insertHeld').mockRejectedValueOnce(new Error('injected crash'));
    await hold(app, A.s.screeningId, [seat]).expect(500);
    spy.mockRestore();
    expect(await redis.exists(lockKey(A.tenantId, A.s.screeningId, seat))).toBe(0);
    await hold(app, A.s.screeningId, [seat]).expect(201);
  });

  it('an expired hold is taken over immediately, without waiting for the sweeper; a sold seat never is', async () => {
    const t = await seedTenant(3);
    await asAdmin(urls.adminUrl, async (c) => {
      await lockSeat(c, t.tenantId, t.s.screeningId, t.s.seatIds[0]!, 'expired', crypto.randomUUID());
      await lockSeat(c, t.tenantId, t.s.screeningId, t.s.seatIds[1]!, 'sold');
    });
    await hold(app, t.s.screeningId, [t.s.seatIds[0]!]).expect(201);
    const sold = await hold(app, t.s.screeningId, [t.s.seatIds[1]!, t.s.seatIds[2]!]).expect(409);
    expect(sold.body.unavailable_seat_ids).toEqual([t.s.seatIds[1]]);
    // the free seat in the same request was not left held, in Redis or Postgres
    expect(await redis.exists(lockKey(t.tenantId, t.s.screeningId, t.s.seatIds[2]!))).toBe(0);
    await hold(app, t.s.screeningId, [t.s.seatIds[2]!]).expect(201);
  });

  it('release deletes the Redis keys and the durable rows together; a stranger’s key survives', async () => {
    const t = await seedTenant(3);
    const h = await hold(app, t.s.screeningId, [t.s.seatIds[0]!, t.s.seatIds[1]!]).expect(201);
    // Simulate: seat 1's key expired and someone else took it in Redis.
    await redis.set(lockKey(t.tenantId, t.s.screeningId, t.s.seatIds[1]!), 'someone-else', 'PX', 60_000);
    await request(app.getHttpServer()).delete(`/api/v1/holds/${h.body.hold_id}`).set('hold-token', h.body.hold_token).expect(204);
    expect(await redis.exists(lockKey(t.tenantId, t.s.screeningId, t.s.seatIds[0]!))).toBe(0);
    expect(await redis.get(lockKey(t.tenantId, t.s.screeningId, t.s.seatIds[1]!))).toBe('someone-else');
    const { rows } = await asAdmin(urls.adminUrl, (c) => c.query('SELECT 1 FROM seat_lock WHERE hold_id = $1', [h.body.hold_id]));
    expect(rows).toHaveLength(0);
    // release needs the token for THAT hold
    const other = await hold(app, t.s.screeningId, [t.s.seatIds[2]!]).expect(201);
    await request(app.getHttpServer()).delete(`/api/v1/holds/${h.body.hold_id}`).set('hold-token', other.body.hold_token).expect(401);
    await request(app.getHttpServer()).delete(`/api/v1/holds/${other.body.hold_id}`).expect(401);
  });

  it('extends once, by 120 s, when uncontested; never twice', async () => {
    const t = await seedTenant(3);
    const h = await hold(app, t.s.screeningId, [t.s.seatIds[0]!]).expect(201);
    const ext = await request(app.getHttpServer()).post(`/api/v1/holds/${h.body.hold_id}/extend`).set('hold-token', h.body.hold_token).expect(200);
    expect(Date.parse(ext.body.expires_at) - Date.parse(h.body.expires_at)).toBe(120_000);
    expect(await redis.pttl(lockKey(t.tenantId, t.s.screeningId, t.s.seatIds[0]!))).toBeGreaterThan(400_000);
    const again = await request(app.getHttpServer()).post(`/api/v1/holds/${h.body.hold_id}/extend`).set('hold-token', ext.body.hold_token).expect(409);
    expect(again.body.error).toBe('hold_not_extendable');
  });

  it('with Redis unreachable: first 201, second 409, and the response shape is identical', async () => {
    const t = await seedTenant(3);
    const fast = await hold(app, t.s.screeningId, [t.s.seatIds[0]!]).expect(201);
    const slow = await hold(downApp, t.s.screeningId, [t.s.seatIds[1]!]).expect(201);
    await hold(downApp, t.s.screeningId, [t.s.seatIds[1]!]).expect(409);
    await hold(downApp, t.s.screeningId, [t.s.seatIds[0]!]).expect(409); // held via the fast path; Postgres knows
    const shape = (b: Record<string, unknown>) => Object.keys(b).sort();
    expect(shape(slow.body)).toEqual(shape(fast.body));
    expect(Object.keys(slow.body.seats[0]).sort()).toEqual(Object.keys(fast.body.seats[0]).sort());
  });
});
