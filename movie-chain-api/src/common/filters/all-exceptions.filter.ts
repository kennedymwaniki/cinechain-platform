import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject, Logger, Optional } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SecurityEvents } from '../../audit/security-event.service';
import { maybeCurrentTenant } from '../../tenancy/tenant-context';
import { DomainError, NotFoundError, STATUS_BY_CLASS, TenantMismatchError } from '../errors/domain-errors';

interface Body {
  error: string;
  message: string;
  [k: string]: unknown;
}

const NOT_FOUND: Body = { error: 'not_found', message: 'Resource not found' };

/** Postgres SQLSTATEs with a meaning in the API (PRD §8.4). */
/** Exclusion constraints, by NAME: one SQLSTATE, different meanings. */
const BY_CONSTRAINT: Record<string, Body> = {
  no_screen_overlap: {
    error: 'screening_overlap',
    message: 'This screening overlaps another on the same screen, including the turnaround time',
  },
  pricing_rule_no_overlap: { error: 'price_overlap', message: 'A price for this seat class already covers that time' },
};

const PG: Record<string, { status: number; body: Body } | 'tenant_mismatch'> = {
  '23505': { status: 409, body: { error: 'already_exists', message: 'A resource with these values already exists' } },
  // A foreign key to a parent that does not exist IN THIS TENANT (composite FKs, convention 11).
  '23503': { status: 404, body: NOT_FOUND },
  '23P01': { status: 409, body: { error: 'overlap', message: 'This overlaps an existing entry' } },
  // RLS WITH CHECK: a write tried to land in another tenant. Never a 403.
  '42501': 'tenant_mismatch',
};

function pgConstraint(e: unknown): string | undefined {
  for (let cur = e as { constraint?: unknown; cause?: unknown } | undefined, i = 0; cur && i < 4; cur = cur.cause as typeof cur, i++)
    if (typeof cur.constraint === 'string') return cur.constraint;
  return undefined;
}

function pgCode(e: unknown): string | undefined {
  for (let cur = e as { code?: unknown; cause?: unknown } | undefined, i = 0; cur && i < 4; cur = cur.cause as typeof cur, i++)
    if (typeof cur.code === 'string' && /^[0-9A-Z]{5}$/.test(cur.code)) return cur.code;
  return undefined;
}

function statusOf(e: DomainError): number {
  for (let p = Object.getPrototypeOf(e); p && p !== Error.prototype; p = Object.getPrototypeOf(p)) {
    const s = STATUS_BY_CLASS.get(p.constructor as abstract new (...args: never[]) => DomainError);
    if (s) return s;
  }
  return 500;
}

const snake = (s: string) => s.replace(/Exception$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * The ONE place an error becomes an HTTP status. Domain errors map by class,
 * Postgres errors by SQLSTATE, framework HttpExceptions are normalised into
 * the same `{ error, message }` shape, and anything else is a 500 that leaks
 * nothing.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  // `security` is null in the control plane, which has no identity connection.
  private readonly log = new Logger(AllExceptionsFilter.name);

  constructor(@Optional() @Inject(SecurityEvents) private readonly security: SecurityEvents | null) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    if (host.getType() !== 'http') throw exception;
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = await this.render(exception, req);
    if (res.headersSent) return;
    res.status(status).json(body);
  }

  private async render(e: unknown, req: Request): Promise<{ status: number; body: Body }> {
    if (e instanceof TenantMismatchError) return this.mismatch(req, e.detail);
    if (e instanceof NotFoundError) return { status: 404, body: NOT_FOUND };
    if (e instanceof DomainError) return { status: statusOf(e), body: { error: e.code, message: e.message, ...e.extra } };

    if (e instanceof HttpException) {
      const status = e.getStatus();
      if (status === 404) return { status, body: NOT_FOUND };
      const r = e.getResponse();
      // Pass through only bodies WE built. Nest's own exceptions carry
      // { statusCode, error: 'Payload Too Large', … }: normalise those to a code.
      if (
        typeof r === 'object' && r && !('statusCode' in r) &&
        typeof (r as Body).error === 'string' && typeof (r as Body).message === 'string'
      )
        return { status, body: r as Body };
      const message = typeof r === 'string' ? r : ((r as { message?: unknown }).message ?? e.message);
      return {
        status,
        body: { error: status === 401 ? 'unauthorized' : snake(e.name), message: Array.isArray(message) ? message.join('; ') : String(message) },
      };
    }

    const code = pgCode(e);
    const named = pgConstraint(e);
    if (code === '23P01' && named && BY_CONSTRAINT[named]) return { status: 409, body: BY_CONSTRAINT[named] };
    const mapped = code ? PG[code] : undefined;
    if (mapped === 'tenant_mismatch') return this.mismatch(req, { sqlstate: code });
    if (mapped) return mapped;

    this.log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return { status: 500, body: { error: 'internal_error', message: 'Something went wrong' } };
  }

  private async mismatch(req: Request, detail: Record<string, unknown>): Promise<{ status: number; body: Body }> {
    const ctx = maybeCurrentTenant() ?? (req as Request & { tenantContext?: { tenantId: string; actor: { kind: string; userId?: string } } }).tenantContext;
    await this.security?.record('tenant_mismatch', {
      tenantId: ctx?.tenantId ?? null,
      actorSub: ctx?.actor.kind === 'staff' ? (ctx.actor.userId ?? null) : (ctx?.actor.kind ?? null),
      path: req.path,
      detail,
    });
    return { status: 404, body: NOT_FOUND };
  }
}
