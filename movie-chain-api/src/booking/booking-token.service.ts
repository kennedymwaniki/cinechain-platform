import { Injectable } from '@nestjs/common';
import { JwtService } from '../auth/jwt.service';
import type { BookingClaims } from '../auth/token-verifier';
import { unauthorized } from '../common/errors/api-error';

export const BOOKING_TOKEN_HEADER = 'booking-token';
/** How long after the screening starts the link keeps working (a refund dispute, a receipt). */
export const BOOKING_TOKEN_GRACE_MS = 7 * 24 * 3600_000;

export const bookingTokenInvalid = () => unauthorized('booking_token_invalid', 'This booking link is invalid or has expired');

/**
 * The signed, expiring booking link (FR-73): possession is the claim to view
 * or cancel ONE booking. Its own key (`booking-v1`), so it can never act as a
 * bearer credential or a hold. `tenant_id` is put there by the server.
 */
@Injectable()
export class BookingTokenService {
  constructor(private readonly jwt: JwtService) {}

  async sign(v: { tenantId: string; bookingId: string; reference: string; startsAt: Date }): Promise<string> {
    const exp = new Date(v.startsAt.getTime() + BOOKING_TOKEN_GRACE_MS);
    return (await this.jwt.sign('booking-v1', { typ: 'booking', booking_id: v.bookingId, tenant_id: v.tenantId, reference: v.reference }, exp)).token;
  }

  async verify(token: string | undefined, bookingId?: string): Promise<BookingClaims> {
    if (!token) throw bookingTokenInvalid();
    const c = await this.jwt.verify('booking-v1', token);
    if (!c || c.typ !== 'booking' || (bookingId !== undefined && c.booking_id !== bookingId)) throw bookingTokenInvalid();
    return { typ: 'booking', booking_id: c.booking_id, tenant_id: c.tenant_id, reference: c.reference };
  }
}
