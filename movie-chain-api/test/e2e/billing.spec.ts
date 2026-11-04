/**
 * Step 26: metering becomes money. A month of synthetic usage, a period
 * close, and invoices that reconcile to metering_usage to the minor unit.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DunningService, FINAL_NOTICE_DAYS } from '../../src/control/billing/dunning.service';
import { addOperator, asAdmin, createTenant, TEST_PASSWORD } from '../support/seed';
import { seedScreening } from '../support/seed-screening';
import { bootControlApp } from '../support/test-app';

const urls = inject('db');
let control: INestApplication;
let op: string;
const PERIOD = '2026-09';
const DAY = 86_400_000;
const http = () => request(control.getHttpServer());
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await asAdmin(urls.adminUrl, (c) => c.query(sql, p))).rows as T[];
const auth = () => ({ authorization: `Bearer ${op}` });

/** A tenant on a plan, subscribed before PERIOD, with that month's usage. */
async function billedTenant(planCode: string, usage: { requests: number; bookings: number; tickets: number; hold_seconds: number; storage_bytes: number }, opts: { trialDays?: number } = {}) {
  const t = await asAdmin(urls.adminUrl, (c) => createTenant(c));
  await http().post(`/admin/tenants/${t.id}/subscription`).set(auth()).send({ plan_code: planCode, trial_days: opts.trialDays ?? 0, payment_method_ref: 'pm_test_card' }).expect(201);
  // backdate: subscribed in August, so September is a full billing period (and a long trial covers it)
  await q(
    `UPDATE platform.subscription SET created_at = '2026-08-15', trial_ends_at = CASE WHEN trial_ends_at IS NULL THEN NULL ELSE '2026-10-15'::timestamptz END WHERE tenant_id = $1`,
    [t.id],
  );
  await q(
    `INSERT INTO platform.metering_usage (tenant_id, period, requests, bookings, tickets, hold_seconds, storage_bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [t.id, PERIOD, usage.requests, usage.bookings, usage.tickets, usage.hold_seconds, usage.storage_bytes],
  );
  return t;
}

/** Every number in a JSON body is an integer: no float anywhere in a billing path. */
function assertIntegers(v: unknown, path = '$'): void {
  if (typeof v === 'number') expect(Number.isInteger(v), `${path} = ${v}`).toBe(true);
  else if (Array.isArray(v)) v.forEach((x, i) => assertIntegers(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertIntegers(x, `${path}.${k}`);
}

let heavy: { id: string };
let light: { id: string };
let trial: { id: string };

beforeAll(async () => {
  control = await bootControlApp(urls, inject('redisUrl'));
  await asAdmin(urls.adminUrl, (c) => addOperator(c, 'ops@billing.test'));
  op = (await http().post('/admin/auth/login').send({ email: 'ops@billing.test', password: TEST_PASSWORD }).expect(200)).body.access_token;
  heavy = await billedTenant('basic-kes', { requests: 1_250_500, bookings: 2_010, tickets: 4_000, hold_seconds: 2_007_200, storage_bytes: 6 * 1024 ** 3 + 1 });
  light = await billedTenant('standard-kes', { requests: 10_000, bookings: 40, tickets: 90, hold_seconds: 30_000, storage_bytes: 1024 });
  trial = await billedTenant('basic-kes', { requests: 500, bookings: 1, tickets: 2, hold_seconds: 300, storage_bytes: 0 }, { trialDays: 60 });
  await http().post(`/admin/billing/periods/${PERIOD}/close`).set(auth()).expect(200);
});
afterAll(() => control.close());

const invoicesOf = async (tenantId: string) => (await http().get(`/admin/tenants/${tenantId}/invoices`).set(auth()).expect(200)).body;

describe('invoices (period close)', () => {
  it('lines reconcile to metering_usage and the total matches to the minor unit', async () => {
    const [inv] = await invoicesOf(heavy.id);
    const lines = Object.fromEntries(inv.lines.map((l: { kind: string }) => [l.kind, l]));
    // Basic-KES: KES 15 000.00 base; overage per 1 000 requests 50, per booking 2 000, per hour of holds 200, per GiB 5 000.
    expect(lines.requests).toMatchObject({ meteredQuantity: 1_250_500, billableUnits: 251, amountMinor: 12_550 });
    expect(lines.bookings).toMatchObject({ meteredQuantity: 2_010, billableUnits: 10, amountMinor: 20_000 });
    expect(lines.tickets).toMatchObject({ meteredQuantity: 4_000, amountMinor: 0 });
    expect(lines.hold_seconds).toMatchObject({ meteredQuantity: 2_007_200, billableUnits: 2, amountMinor: 400 });
    expect(lines.storage_bytes).toMatchObject({ meteredQuantity: 6 * 1024 ** 3 + 1, billableUnits: 2, amountMinor: 10_000 });
    expect(inv).toMatchObject({ period: PERIOD, currency: 'KES', status: 'open', totalMinor: 1_500_000 + 12_550 + 20_000 + 400 + 10_000 });
    expect(inv.lines.reduce((s: number, l: { amountMinor: number }) => s + l.amountMinor, 0)).toBe(inv.totalMinor);
    const rec = await http().get(`/admin/invoices/${inv.id}/reconciliation`).set(auth()).expect(200);
    expect(rec.body).toEqual({ reconciles: true, mismatches: [] });
    assertIntegers(await invoicesOf(heavy.id));
  });

  it('a deliberate mismatch fails reconciliation — and the database refuses a doctored line outright', async () => {
    const [inv] = await invoicesOf(light.id);
    expect((await http().get(`/admin/invoices/${inv.id}/reconciliation`).set(auth())).body.reconciles).toBe(true);
    await q(`UPDATE platform.metering_usage SET requests = requests + 1 WHERE tenant_id = $1 AND period = $2`, [light.id, PERIOD]);
    const rec = (await http().get(`/admin/invoices/${inv.id}/reconciliation`).set(auth())).body;
    expect(rec.reconciles).toBe(false);
    expect(rec.mismatches).toEqual([expect.objectContaining({ line: 'requests', problem: 'metered 10000 on the invoice, 10001 in metering_usage' })]);
    await q(`UPDATE platform.metering_usage SET requests = requests - 1 WHERE tenant_id = $1 AND period = $2`, [light.id, PERIOD]);
    await expect(q(`UPDATE platform.invoice_line SET amount_minor = amount_minor + 1 WHERE invoice_id = $1 AND kind = 'requests'`, [inv.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('a trial covering the period is invoiced at zero, with the waived fee shown', async () => {
    const [inv] = await invoicesOf(trial.id);
    expect(inv).toMatchObject({ totalMinor: 0, status: 'paid' });
    expect(inv.lines.find((l: { kind: string }) => l.kind === 'trial_credit')).toMatchObject({ amountMinor: -1_500_000 });
  });

  it('closing the same period again issues nothing new', async () => {
    const again = await http().post(`/admin/billing/periods/${PERIOD}/close`).set(auth()).expect(200);
    expect(again.body.issued).toBe(0);
    expect(await invoicesOf(heavy.id)).toHaveLength(1);
  });
});

describe('cost per tenant', () => {
  it('apportions the infrastructure bill by consumption, summing to the bill exactly', async () => {
    await http().put(`/admin/billing/infra-cost/${PERIOD}`).set(auth()).send({ currency: 'KES', total_minor: 100_000_003, source: 'synthetic cloud bill' }).expect(200);
    const res = await http().get('/admin/billing/cost-per-tenant').query({ period: PERIOD }).set(auth()).expect(200);
    expect(res.body).toMatchObject({ total_minor: 100_000_003, unallocated_minor: 0, model: { sum_tolerance_minor: 0 } });
    const mine = res.body.tenants.filter((t: { tenant_id: string }) => [heavy.id, light.id, trial.id].includes(t.tenant_id));
    const byId = Object.fromEntries(mine.map((t: { tenant_id: string }) => [t.tenant_id, t]));
    expect(byId[heavy.id].allocated_minor).toBeGreaterThan(byId[light.id].allocated_minor);
    expect(byId[light.id].allocated_minor).toBeGreaterThan(byId[trial.id].allocated_minor);
    expect(res.body.tenants.reduce((s: number, t: { allocated_minor: number }) => s + t.allocated_minor, 0)).toBe(100_000_003);
    assertIntegers(res.body);
  });
});

describe('dunning (trial → active → past_due → suspended → active)', () => {
  it('suspends only after the grace period, and paying restores the tenant with every row intact', async () => {
    const t = await billedTenant('basic-kes', { requests: 0, bookings: 0, tickets: 0, hold_seconds: 0, storage_bytes: 0 });
    await asAdmin(urls.adminUrl, (c) => seedScreening(c, t.id)); // data the tenant must not lose
    const rowsBefore = await q(`SELECT (SELECT count(*)::int FROM theatre WHERE tenant_id = $1) AS theatres, (SELECT count(*)::int FROM seat WHERE tenant_id = $1) AS seats`, [t.id]);
    await http().post(`/admin/billing/periods/${PERIOD}/close`).set(auth()).expect(200);
    const [inv] = await invoicesOf(t.id);
    const due = new Date(inv.dueAt).getTime();
    const dunning = control.get(DunningService);
    const sub = async () => (await q<{ status: string }>(`SELECT status FROM platform.subscription WHERE tenant_id = $1`, [t.id]))[0]!.status;
    const tenantStatus = async () => (await q<{ status: string }>(`SELECT status::text FROM tenant WHERE id = $1`, [t.id]))[0]!.status;

    dunning.gateway.next = 'decline';
    expect(await dunning.step(inv.id, new Date(due))).toBe('failed');
    expect(await sub()).toBe('past_due');
    for (const day of [1, 3, 7]) {
      dunning.gateway.next = 'decline';
      expect(await dunning.step(inv.id, new Date(due + day * DAY))).toBe('failed');
    }
    // the last day of grace: a final notice, still NOT suspended
    expect(await dunning.step(inv.id, new Date(due + (14 - 1) * DAY))).toBe('retry_later');
    expect([await sub(), await tenantStatus()]).toEqual(['past_due', 'active']);
    // grace elapsed: suspended — logins blocked, data kept
    expect(await dunning.step(inv.id, new Date(due + 14 * DAY))).toBe('suspended');
    expect([await sub(), await tenantStatus()]).toEqual(['suspended', 'suspended']);

    // the customer updates their card; the operator collects
    const paid = await http().post(`/admin/invoices/${inv.id}/collect`).set(auth()).expect(200);
    expect(paid.body.result).toBe('paid');
    expect([await sub(), await tenantStatus()]).toEqual(['active', 'active']);
    expect(await q(`SELECT (SELECT count(*)::int FROM theatre WHERE tenant_id = $1) AS theatres, (SELECT count(*)::int FROM seat WHERE tenant_id = $1) AS seats`, [t.id])).toEqual(rowsBefore);

    const stages = (await q<{ stage: string }>(`SELECT stage FROM platform.dunning_notice WHERE invoice_id = $1 ORDER BY sent_at, stage`, [inv.id])).map((r) => r.stage);
    expect(new Set(stages)).toEqual(new Set(['payment_failed', 'retry_scheduled', 'final_notice', 'suspended', 'reactivated']));
    expect(stages.filter((s) => s === 'suspended')).toHaveLength(1);
    expect(FINAL_NOTICE_DAYS).toBeLessThan(14);
  });

  it('subscription payments use their own idempotency namespace and never touch ticket payments', async () => {
    const keys = await q<{ k: string }>(`SELECT idempotency_key AS k FROM platform.subscription_payment`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((r) => r.k.startsWith('sub:'))).toBe(true);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM payment WHERE idempotency_key LIKE 'sub:%'`))[0]!.n).toBe(0);
  });
});
