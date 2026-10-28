import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { idempotencyKey } from '../../db/schema/audit';
import { currentTenant, db } from '../../tenancy/tenant-context';
import { badRequest, conflict, unprocessable } from '../errors/api-error';

const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/**
 * Runs INSIDE the tenant transaction opened by TenantInterceptor (method-level
 * interceptors run after global ones). That makes the protocol simple and
 * race-free: the INSERT of the key takes a row lock on its primary key, so a
 * concurrent duplicate waits for the first to COMMIT and then sees the stored
 * response; if the handler fails, the key rolls back with everything else and
 * the client may retry.
 *
 * Handlers that call external services (bookings, step 18) do NOT use this:
 * they need the key committed as `in_progress` BEFORE the capture.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return from(this.run(req, res, next));
  }

  private async run(req: Request, res: Response, next: CallHandler): Promise<unknown> {
    const key = req.header('idempotency-key');
    if (!key) throw badRequest('idempotency_key_required', 'This endpoint requires an Idempotency-Key header');
    if (!KEY_RE.test(key)) throw badRequest('idempotency_key_invalid', 'Idempotency-Key must be 1–200 URL-safe characters');

    const endpoint = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    const requestHash = createHash('sha256')
      .update(stableStringify({ params: req.params, query: req.query, body: req.body }))
      .digest('hex');
    const { tenantId } = currentTenant();

    const [claimed] = await db()
      .insert(idempotencyKey)
      .values({ tenantId, key, endpoint, requestHash, expiresAt: new Date(Date.now() + 24 * 3600_000) })
      .onConflictDoNothing()
      .returning({ key: idempotencyKey.key });

    if (!claimed) {
      // RLS scopes this to the current tenant; the WHERE names only the key.
      const [prior] = await db()
        .select()
        .from(idempotencyKey)
        .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.endpoint, endpoint)));
      if (!prior) throw conflict('idempotency_in_progress', 'A request with this key is still in progress');
      if (prior.requestHash !== requestHash)
        throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request');
      if (prior.status !== 'completed')
        throw conflict('idempotency_in_progress', 'A request with this key is still in progress');
      res.status(prior.responseStatus ?? 200);
      res.setHeader('Idempotent-Replayed', 'true');
      return prior.responseBody;
    }

    const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
    await db()
      .update(idempotencyKey)
      .set({ status: 'completed', responseStatus: res.statusCode, responseBody: body ?? null })
      .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.endpoint, endpoint)));
    return body;
  }
}
