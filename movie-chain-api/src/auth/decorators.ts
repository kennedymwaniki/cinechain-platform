import { applyDecorators, SetMetadata } from '@nestjs/common';
import type { StaffRole } from '../db/schema/staff-user';

export const IS_PUBLIC = 'cinechain:public';
export const STAFF_ROLES = 'cinechain:staff-roles';
export const CONSUMER_ROUTE = 'cinechain:consumer-route';

/**
 * No token required, no tenant context. Every route that is NOT @Public is
 * probed cross-tenant by the generated route-table suite (step 9).
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Staff route restricted to these roles. A route with no decorator at all is
 * staff-only (any role): the default is closed, not open.
 */
export const Roles = (...roles: StaffRole[]) => applyDecorators(SetMetadata(STAFF_ROLES, roles));

/**
 * Customer-facing route. Guests (no token) are admitted with consumer = null
 * unless `requireAccount` is set. Staff tokens are refused with 403
 * wrong_token_type. No tenant context is set: handlers derive it from the
 * resource being acted on.
 */
export const ConsumerRoute = (opts: { requireAccount?: boolean } = {}) =>
  SetMetadata(CONSUMER_ROUTE, { requireAccount: opts.requireAccount ?? false });
