import type { Audience } from './key-store';
import type { StaffRole } from '../db/schema/staff-user';

/** Access-token claim shapes. `typ` and the audience key are BOTH checked. */
export interface StaffClaims {
  typ: 'staff';
  sub: string;
  tenant_id: string;
  tenant_slug: string;
  role: StaffRole;
  sv: number; // session_version at issue time
}

export interface ConsumerClaims {
  typ: 'consumer';
  sub: string;
  email_verified: boolean;
  // NOTE: no tenant_id key — not even undefined. Asserted by test (step 6).
}

export interface ControlClaims {
  typ: 'operator';
  sub: string;
}

export interface ClaimsByAudience {
  'staff-v1': StaffClaims;
  'consumer-v1': ConsumerClaims;
  'control-v1': ControlClaims;
}

export type TokenAudience = keyof ClaimsByAudience & Audience;

/**
 * The seam that lets Keycloak (or any OIDC issuer) replace the in-app issuer
 * later: guards depend on this interface, not on the signing implementation.
 */
export abstract class TokenVerifier {
  abstract verify<A extends TokenAudience>(audience: A, token: string): Promise<ClaimsByAudience[A] | null>;
}
