import type { Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'cc_oauth_state';
const TTL_MS = 10 * 60 * 1000;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Stateless OAuth `state` for passport-oauth2 (we run without sessions).
 * The state is `nonce.expiry.hmac`, and the nonce is ALSO set in an HttpOnly
 * cookie: the callback must present both, so a forged callback URL (login
 * CSRF) fails because the victim's browser does not hold the matching cookie.
 */
export class SignedStateStore {
  constructor(
    private readonly secret: Buffer,
    private readonly secureCookie: boolean,
  ) {}

  private sign(nonce: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`${nonce}.${exp}`).digest('base64url');
  }

  // arity 2: (req, cb)
  store(req: Request, cb: (err: Error | null, state?: string) => void): void {
    const nonce = randomBytes(16).toString('base64url');
    const exp = Date.now() + TTL_MS;
    (req.res as Response).cookie(COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookie,
      maxAge: TTL_MS,
      path: '/api/v1/auth/google',
    });
    cb(null, `${nonce}.${exp}.${this.sign(nonce, exp)}`);
  }

  // arity 3: (req, state, cb)
  verify(req: Request, state: string, cb: (err: Error | null, ok: boolean, info?: { message: string }) => void): void {
    const [nonce, expRaw, sig] = (state ?? '').split('.');
    const exp = Number(expRaw);
    const cookie = readCookie(req, COOKIE);
    const expected = nonce && Number.isFinite(exp) ? this.sign(nonce, exp) : '';
    const ok =
      !!nonce &&
      !!sig &&
      cookie === nonce &&
      exp > Date.now() &&
      sig.length === expected.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    (req.res as Response).clearCookie(COOKIE, { path: '/api/v1/auth/google' });
    cb(null, ok, ok ? undefined : { message: 'invalid_oauth_state' });
  }
}
