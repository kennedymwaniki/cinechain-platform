import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, decodeJwt, errors as joseErrors } from 'jose';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { KeyStore } from './key-store';
import { type ClaimsByAudience, type TokenAudience, TokenVerifier } from './token-verifier';

/**
 * Issues and verifies access tokens. EdDSA (Ed25519), one keypair PER
 * AUDIENCE: a staff token cannot verify under the consumer key at all, so a
 * guard wired to the wrong route fails closed instead of admitting the token.
 */
@Injectable()
export class JwtService extends TokenVerifier {
  constructor(
    private readonly keys: KeyStore,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    super();
  }

  async sign<A extends TokenAudience>(
    audience: A,
    claims: ClaimsByAudience[A],
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const { privateKey } = this.keys.get(audience);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'EdDSA', kid: audience, typ: 'JWT' })
      .setIssuer(this.cfg.auth.issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .setJti(randomUUID())
      .sign(privateKey);
    return { token, expiresAt: new Date((now + ttlSeconds) * 1000) };
  }

  /** Returns null for ANY failure: bad signature, wrong audience, expired, malformed. */
  async verify<A extends TokenAudience>(audience: A, token: string): Promise<ClaimsByAudience[A] | null> {
    try {
      const { payload } = await jwtVerify(token, this.keys.get(audience).publicKey, {
        algorithms: ['EdDSA'],
        issuer: this.cfg.auth.issuer,
        audience,
      });
      return payload as unknown as ClaimsByAudience[A];
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) return null;
      throw e;
    }
  }
}

/**
 * Reads claims WITHOUT verifying. Only for classifying a token so a guard can
 * return the right error code (wrong_token_type vs invalid). Never trust it.
 */
export function decodeUnverified(token: string): Record<string, unknown> | null {
  try {
    return decodeJwt(token) as Record<string, unknown>;
  } catch {
    return null;
  }
}
