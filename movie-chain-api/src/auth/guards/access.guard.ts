import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { StaffRole } from '../../db/schema/staff-user';
import { forbidden, unauthorized } from '../../common/errors/api-error';
import type { TenantScopedRequest } from '../../tenancy/tenant.interceptor';
import { ConsumerGuard } from '../../tenancy/consumer.guard';
import { CONSUMER_ROUTE, IS_PUBLIC, STAFF_ROLES } from '../decorators';
import { decodeUnverified } from '../jwt.service';
import { type StaffClaims, TokenVerifier } from '../token-verifier';

export type AuthedRequest = Request & TenantScopedRequest & { staff?: StaffClaims };

export function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * Global guard. Secure by default: a route is staff-only unless marked
 * @Public() or @ConsumerRoute(). For staff, the tenant comes
 * from the VERIFIED token — and only from there.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly consumers: ConsumerGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const raw = bearerToken(req);

    const consumerRoute = this.reflector.getAllAndOverride<{ requireAccount: boolean } | undefined>(CONSUMER_ROUTE, targets);
    if (consumerRoute) return this.consumers.check(req, raw, consumerRoute.requireAccount);

    if (!raw) throw unauthorized();

    const claims = await this.verifier.verify('staff-v1', raw);
    if (!claims) {
      // Classify the failure so a consumer token gets the RIGHT error code.
      const peek = decodeUnverified(raw);
      if (peek && (peek.typ === 'consumer' || peek.tenant_id === undefined))
        throw unauthorized('no_tenant_context', 'This endpoint requires a staff token');
      throw unauthorized('invalid_token', 'Token is invalid or expired');
    }
    if (claims.typ !== 'staff' || typeof claims.tenant_id !== 'string')
      throw unauthorized('no_tenant_context', 'This endpoint requires a staff token');

    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(STAFF_ROLES, targets);
    if (roles?.length && !roles.includes(claims.role)) throw forbidden('insufficient_role', 'Your role cannot do this');

    req.staff = claims;
    req.tenantContext = { tenantId: claims.tenant_id, actor: { kind: 'staff', userId: claims.sub, role: claims.role } };
    return true;
  }
}
