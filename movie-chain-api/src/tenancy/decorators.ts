import { SetMetadata } from '@nestjs/common';

export const DEFER_TENANT_TX = 'cinechain:defer-tenant-tx';

/**
 * The interceptor establishes the tenant CONTEXT but opens no transaction;
 * the handler opens explicit short scopes itself. Required for streaming
 * responses, and for any handler that calls an external service (a payment
 * capture must not pin a pooled connection for ~20 s — step 18).
 */
export const DeferTenantTransaction = () => SetMetadata(DEFER_TENANT_TX, true);

export const ALLOW_WHEN_SUSPENDED = 'cinechain:allow-when-suspended';

/**
 * Step 27: a suspended chain's customers who already paid still get in. A
 * route marked with this stays open to BOX-OFFICE staff while the chain is
 * suspended (ticket scanning); every other route, and every other role, is
 * refused. Offboarding and deleted chains are refused regardless.
 */
export const AllowWhenSuspended = () => SetMetadata(ALLOW_WHEN_SUSPENDED, true);

/** Login and refresh use the same rule: only box office, only while merely suspended. */
export const admitsDoorStaff = (tenantStatus: string, role: string) => tenantStatus === 'suspended' && role === 'box_office';
