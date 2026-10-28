import { Injectable, Logger } from '@nestjs/common';
import { securityEvent } from '../db/schema/platform';
import { IdentityDb } from '../tenancy/identity-db.provider';

export type SecurityEventKind =
  | 'tenant_mismatch'
  | 'wrong_token_type'
  | 'refresh_token_reuse'
  | 'login_failed'
  | 'suspended_tenant_access';

export interface SecurityEventInput {
  tenantId?: string | null;
  actorSub?: string | null;
  path?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Platform-level, append-only security log. Written on the identity
 * connection (INSERT-only grant), so a tenant can neither read nor erase it.
 * Recording never fails the request that triggered it.
 */
@Injectable()
export class SecurityEvents {
  private readonly log = new Logger(SecurityEvents.name);

  constructor(private readonly identity: IdentityDb) {}

  async record(kind: SecurityEventKind, e: SecurityEventInput = {}): Promise<void> {
    try {
      await this.identity.db.insert(securityEvent).values({
        kind,
        tenantId: e.tenantId ?? null,
        actorSub: e.actorSub ?? null,
        path: e.path ?? null,
        detail: e.detail ?? {},
      });
    } catch (err) {
      this.log.error(`failed to record security event ${kind}: ${(err as Error).message}`);
    }
  }
}
