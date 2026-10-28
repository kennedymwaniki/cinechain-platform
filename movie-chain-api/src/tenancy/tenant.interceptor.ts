import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { SecurityEvents } from '../audit/security-event.service';
import { forbidden, notFound, unauthorized } from '../common/errors/api-error';
import { DEFER_TENANT_TX } from './decorators';
import { runWithTenant, type TenantContext } from './tenant-context';
import { TenantDb } from './tenant-db.provider';
import { TenantRegistry } from './tenant-registry.service';

/** Set on the request by the auth guards — never from caller input. */
export interface TenantScopedRequest {
  tenantContext?: TenantContext;
  params?: Record<string, string>;
  path?: string;
}

/**
 * Wraps every tenant-scoped request in runWithTenant + one transaction.
 *
 * `next.handle()` is a COLD observable: the handler runs only when it is
 * subscribed. `lastValueFrom` subscribes INSIDE the scope and resolves after
 * the handler finishes, so COMMIT happens after the handler — not on the next
 * microtask, on a released connection, with no tenant set (PRD correction 2).
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly registry: TenantRegistry,
    private readonly security: SecurityEvents,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<TenantScopedRequest>();
    const ctx = req.tenantContext;
    if (!ctx) return next.handle(); // unscoped route: health, public discovery, login

    const defer = this.reflector.getAllAndOverride<boolean>(DEFER_TENANT_TX, [context.getHandler(), context.getClass()]);
    const run = () => lastValueFrom(next.handle(), { defaultValue: undefined });
    return from(
      this.admit(req, ctx).then(() =>
        runWithTenant(ctx, defer ? run : () => this.tenantDb.withTenantScope(run)),
      ),
    );
  }

  /** Checks that apply to every tenant-scoped request, before the handler runs. */
  private async admit(req: TenantScopedRequest, ctx: TenantContext): Promise<void> {
    const tenant = await this.registry.byId(ctx.tenantId);
    if (!tenant) throw unauthorized('no_tenant_context', 'Unknown tenant');
    if (tenant.status !== 'active') {
      await this.security.record('suspended_tenant_access', { tenantId: tenant.id, path: req.path ?? null });
      throw forbidden('tenant_suspended', 'This cinema chain is not currently active');
    }
    // A route that names a tenant in its path must name THE token's tenant.
    // A mismatch is a probe: answer 404 (never 403, which would confirm the
    // other tenant exists) and record it.
    const pathSlug = req.params?.tenantSlug;
    if (pathSlug !== undefined && pathSlug !== tenant.slug) {
      const actor = ctx.actor.kind === 'staff' ? ctx.actor.userId : ctx.actor.kind;
      await this.security.record('tenant_mismatch', {
        tenantId: tenant.id,
        actorSub: actor,
        path: req.path ?? null,
        detail: { pathSlug },
      });
      throw notFound();
    }
  }
}
