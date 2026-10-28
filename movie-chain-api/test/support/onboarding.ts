import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** Polls the control-plane status endpoint until the run reaches one of `want`. */
export async function waitForStatus(app: INestApplication, token: string, tenantId: string, want: string[], ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    const res = await request(app.getHttpServer()).get(`/admin/tenants/${tenantId}/status`).set('authorization', `Bearer ${token}`);
    if (want.includes(res.body.status)) return res.body;
    if (Date.now() > until) throw new Error(`status stuck at ${res.body.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
