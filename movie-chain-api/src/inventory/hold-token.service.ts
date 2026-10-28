import { Injectable } from '@nestjs/common';
import { JwtService } from '../auth/jwt.service';
import type { HoldClaims } from '../auth/token-verifier';
import { unauthorized } from '../common/errors/api-error';

export const HOLD_TOKEN_HEADER = 'hold-token';

export const holdTokenInvalid = () => unauthorized('hold_token_invalid', 'The hold token is invalid, expired or for another hold');

/**
 * Hold tokens, on the `hold-v1` key. Expiry is the hold's own expires_at
 * (from Postgres now()), so the token die    try {
      const c = this.client;
      if (c.status !== 'ready')
        await new Promise<void>((ok, fail) => {
          const t = setTimeout(() => fail(new Error('redis not ready within 3s')), 3000);
          c.once('ready', () => (clearTimeout(t), ok()));
        });
      for (const s of Object.values(this.scripts)) await c.script('LOAD', s.body);s with the hold.
 */
@Injectable()
export class HoldTokenService {
  constructor(private readonly jwt: JwtService) {}

  async sign(claims: Omit<HoldClaims, 'typ'>, expiresAt: Date): Promise<string> {
    return (await this.jwt.sign('hold-v1', { typ: 'hold', ...claims }, expiresAt)).token;
  }

  /** Verifies and checks it names THIS hold / screening. Any mismatch is the same 401. */
  async verify(token: string | undefined, expect: { holdId?: string; screeningId?: string }): Promise<HoldClaims> {
    if (!token) throw holdTokenInvalid();
    const c = await this.jwt.verify('hold-v1', token);
    if (!c || c.typ !== 'hold') throw holdTokenInvalid();
    if (expect.holdId !== undefined && c.hold_id !== expect.holdId) throw holdTokenInvalid();
    if (expect.screeningId !== undefined && c.screening_id !== expect.screeningId) throw holdTokenInvalid();
    // Only our claims: never echo iat/jti/aud back into a re-signed token.
    return {
      typ: 'hold',
      hold_id: c.hold_id,
      screening_id: c.screening_id,
      tenant_id: c.tenant_id,
      seat_ids: c.seat_ids,
      quoted_total_minor: c.quoted_total_minor,
      currency: c.currency,
      channel: c.channel,
    };
  }
}
