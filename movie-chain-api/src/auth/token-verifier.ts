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

/**
 * A hold token: possession is the claim to the seats (FR-71). Signed with its
 * OWN key, so it can never verify as a bearer credential. `tenant_id` is put
 * here by the server, from screening.tenant_id — never from the caller.
 */
export interface HoldClaims {
  typ: 'hold';
  hold_id: string;
  screening_id: string;
  tenant_id: string;
  seat_ids: string[];
  quoted_total_minor: number;
  currency: string;
  channel: 'online' | 'box_office';
}

/** The signed booking link (FR-73): view or cancel ONE booking. Its own key. */
export interface BookingClaims {
  typ: 'booking';
  booking_id: string;
  tenant_id: string;
  reference: string;
}

/** A ticket's QR image link: names the ticket, never carries its code. 15 minutes. */
export interface TicketQrClaims {
  typ: 'ticket_qr';
  tenant_id: string;
  ticket_id: string;
}

export interface ClaimsByAudience {
  'staff-v1': StaffClaims;
  'consumer-v1': ConsumerClaims;
  'control-v1': ControlClaims;
  'hold-v1': HoldClaims;
  'booking-v1': BookingClaims | TicketQrClaims;
}

export type TokenAudience = keyof ClaimsByAudience & Audience;

/**
 * The seam that lets Keycloak (or any OIDC issuer) replace the in-app issuer
 * later: guards depend on this interface, not on the signing implementation.
 */
export abstract class TokenVerifier {
  abstract verify<A extends TokenAudience>(audience: A, token: string): Promise<ClaimsByAudience[A] | null>;
}
