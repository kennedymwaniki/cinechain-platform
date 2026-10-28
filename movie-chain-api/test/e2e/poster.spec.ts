import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { addStaff, asAdmin, createTenant, TEST_PASSWORD } from '../support/seed';
import { bootTestApp } from '../support/test-app';

const urls = inject('db');
const s3 = inject('s3');
let app: INestApplication;
let tenantId: string;
let token: string;
// a real 1×1 PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f4a3d60000000049454e44ae426082',
  'hex',
);

beforeAll(async () => {
  const t = await asAdmin(urls.adminUrl, async (c) => {
    const x = await createTenant(c);
    await addStaff(c, x.id, 'admin@poster.test');
    return x;
  });
  tenantId = t.id;
  app = await bootTestApp(urls, {
    env: { S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey, S3_BUCKET: s3.bucket },
  });
  token = (await request(app.getHttpServer()).post('/api/v1/auth/staff/login').send({ email: 'admin@poster.test', password: TEST_PASSWORD, tenant_slug: t.slug }))
    .body.access_token;
});
afterAll(() => app.close());

describe('film posters in object storage', () => {
  it('stores under t/<tenant>/films/<film>/, serves a short-lived signed URL, and the object is private', async () => {
    const f = await request(app.getHttpServer()).post('/api/v1/films').set('authorization', `Bearer ${token}`).send({ title: 'Poster', runtime_min: 90 }).expect(201);
    const up = await request(app.getHttpServer())
      .post(`/api/v1/films/${f.body.id}/poster`)
      .set('authorization', `Bearer ${token}`)
      .attach('poster', PNG, { filename: 'p.png', contentType: 'application/octet-stream' })
      .expect(201);
    const url = new URL(up.body.poster_url);
    expect(url.pathname).toMatch(new RegExp(`^/${s3.bucket}/t/${tenantId}/films/${f.body.id}/poster-[0-9a-f]{16}\\.png$`));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');

    const signed = await fetch(up.body.poster_url);
    expect(signed.status).toBe(200);
    expect(Buffer.from(await signed.arrayBuffer()).equals(PNG)).toBe(true);
    expect(signed.headers.get('content-type')).toBe('image/png'); // from the bytes, not the upload header

    const anonymous = await fetch(`${url.origin}${url.pathname}`);
    expect(anonymous.status).toBe(403);
  });
});
