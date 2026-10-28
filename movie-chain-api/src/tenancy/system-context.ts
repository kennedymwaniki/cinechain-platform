import type { Actor, TenantContext } from './tenant-context';
import { UUID_RE } from './tenant-db.provider';

/**
 * Resource-derived tenancy. For consumers, guests, webhooks and jobs the
 * tenant is an attribute of the TRANSACTION, resolved server-side from the
 * resource (screening.tenant_id, a stored payment row, a job payload).
 *
 * `tenantId` must come from such a lookup. Passing a value taken from a path,
 * header, query or body is the one thing this function exists to prevent —
 * the name of the parameter is a reminder to the reviewer.
 */
export function toSystemContext(resolvedFromResource: { tenantId: string }, actor: Actor): TenantContext {
  if (!UUID_RE.test(resolvedFromResource.tenantId)) throw new Error('resolved tenantId is not a uuid');
  return { tenantId: resolvedFromResource.tenantId.toLowerCase(), actor };
}
