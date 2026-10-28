import { SetMetadata } from '@nestjs/common';

export const DEFER_TENANT_TX = 'cinechain:defer-tenant-tx';

/**
 * The interceptor establishes the tenant CONTEXT but opens no transaction;
 * the handler opens explicit short scopes itself. Required for streaming
 * responses, and for any handler that calls an external service (a payment
 * capture must not pin a pooled connection for ~20 s — step 18).
 */
export const DeferTenantTransaction = () => SetMetadata(DEFER_TENANT_TX, true);
