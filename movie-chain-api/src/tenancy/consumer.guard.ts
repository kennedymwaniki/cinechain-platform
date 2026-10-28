import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SecurityEvents } from '../audit/security-event.service';
import { decodeUnverified } from '../auth/jwt.service';
import { TokenVerifier } from '../auth/token-verifier';
import { forbidden, unauthorized } from '../common/errors/api-error';

export interface ConsumerIdentity {
  id: string;
  emailVerified: boolean;
}

export type ConsumerRequest = Request & { consumer?: ConsumerIdentity | null };

/**
 * The guard for consumer and guest routes. Note what it does NOT do: set a
 * tenant. A consumer's tenant is an attribute of the transaction, resolved
 * server-side from the resource (screening.tenant_id) by the handler.
 */
@Injectable()
export class ConsumerGuard {
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly security: SecurityEvents,
  ) {}

  async check(req: ConsumerRequest, raw: string | null, requireAccount: boolean): Promise<true> {
    // Guests are first-class: no token is a valid state, not a failure.
    if (!raw) {
      if (requireAccount) throw unauthorized('unauthorized', 'Sign in to continue');
      req.consumer = null;
      return true;
    }

    // Classify BEFORE verifying, so a staff token yields the right error.
    const peek = decodeUnverified(raw);
    if (peek && (peek.typ === 'staff' || peek.typ === 'operator' || peek.tenant_id !== undefined)) {
      // Without this, a Nyati clerk could transact as a customer of Prestige.
      await this.security.record('wrong_token_type', {
        actorSub: typeof peek.sub === 'string' ? peek.sub : null,
        path: req.path,
        detail: { typ: peek.typ ?? null },
      });
      throw forbidden('wrong_token_type', 'Staff tokens cannot be used on customer endpoints');
    }

    const claims = await this.verifier.verify('consumer-v1', raw);
    if (!claims || claims.typ !== 'consumer') throw unauthorized('invalid_token', 'Token is invalid or expired');
    req.consumer = { id: claims.sub, emailVerified: claims.email_verified };
    return true;
  }
}
