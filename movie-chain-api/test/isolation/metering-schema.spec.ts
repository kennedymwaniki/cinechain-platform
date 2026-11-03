/**
 * Step 24: metering is counts per tenant. This rejects any column on
 * platform.metering_usage that could identify a booking or a person, and pins
 * the column set, so adding one is a reviewed change to this test.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const urls = inject('db');
let admin: Client;

const ALLOWED = ['tenant_id', 'period', 'requests', 'storage_bytes', 'hold_seconds', 'bookings', 'tickets', 'updated_at'];
const IDENTIFYING = /email|phone|name|consumer|customer|guest|booking_id|ticket_id|seat|reference|card|token|address|ip/i;

beforeAll(async () => {
  admin = new Client({ connectionString: urls.adminUrl });
  await admin.connect();
});
afterAll(() => admin.end());

describe('metering schema', () => {
  it('holds only reviewed count columns, none of which could identify a booking or a person', async () => {
    const { rows } = await admin.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'metering_usage' ORDER BY column_name`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual([...ALLOWED].sort());
    expect(cols.filter((c) => IDENTIFYING.test(c))).toEqual([]);
    for (const r of rows.filter((x) => !['tenant_id', 'period', 'updated_at'].includes(x.column_name))) expect(r.data_type, r.column_name).toBe('bigint');
  });

  it('the application role cannot touch it, and the control role cannot read bookings', async () => {
    const app = new Client({ connectionString: urls.appUrl });
    const ctl = new Client({ connectionString: urls.controlUrl });
    await Promise.all([app.connect(), ctl.connect()]);
    try {
      await expect(app.query('SELECT 1 FROM platform.metering_usage')).rejects.toMatchObject({ code: '42501' });
      await expect(ctl.query('SELECT 1 FROM platform.metering_usage LIMIT 1')).resolves.toBeTruthy();
      for (const t of ['booking', 'ticket', 'payment', 'tenant_customer']) await expect(ctl.query(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toMatchObject({ code: '42501' });
    } finally {
      await Promise.all([app.end(), ctl.end()]);
    }
  });
});
