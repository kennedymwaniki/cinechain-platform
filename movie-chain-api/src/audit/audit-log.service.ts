import { Injectable } from '@nestjs/common';
import { auditEvent } from '../db/schema/audit';
import { currentTenant, db } from '../tenancy/tenant-context';

/**
 * Tenant-scoped audit trail, written through db() — i.e. in the SAME
 * transaction as the change being audited. If the change rolls back, so does
 * its audit row; there is never an audit entry for something that did not happen.
 */
@Injectable()
export class AuditLog {
  async record(action: string, resourceType: string, resourceId: string | null, detail: Record<string, unknown> = {}) {
    const { tenantId, actor } = currentTenant();
    await db()
      .insert(auditEvent)
      .values({
        tenantId,
        actorKind: actor.kind,
        actorId: actor.kind === 'staff' ? actor.userId : actor.kind === 'consumer' ? actor.consumerId : null,
        action,
        resourceType,
        resourceId,
        detail,
      });
  }
}
