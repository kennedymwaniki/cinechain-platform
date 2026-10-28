import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  consumer,
  consumerIdentity,
  emailVerification,
  identityOutbox,
  refreshToken,
} from '../db/schema/platform';
import { badRequest, forbidden, unauthorized } from '../common/errors/api-error';
import { JwtService } from '../auth/jwt.service';
import { PasswordService } from '../auth/password.service';
import { RefreshTokens } from '../auth/refresh-token.service';
import { IdentityDb, type IdentityDrizzle } from '../tenancy/identity-db.provider';
import { VerificationMailer } from './verification-mailer';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface ConsumerSession {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: string;
  consumer: { email: string; display_name: string | null; email_verified: boolean };
}

export interface GoogleProfile {
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

interface Principal {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  sessionVersion: number;
}

const principalCols = {
  id: consumer.id,
  email: consumer.email,
  displayName: consumer.displayName,
  emailVerified: consumer.emailVerified,
  sessionVersion: consumer.sessionVersion,
  status: consumer.status,
};

/**
 * THE ONLY module permitted to touch platform.consumer (asserted by
 * test/isolation/identity-boundary.spec.ts). Runs on the cinechain_identity
 * connection; cinechain_app cannot reach any of these tables.
 */
@Injectable()
export class ConsumerService {
  constructor(
    private readonly identity: IdentityDb,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly refresh: RefreshTokens,
    private readonly mailer: VerificationMailer,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Same response whether or not the e-mail exists. An existing account is
   * NEVER modified here — setting a password on it would be a takeover.
   */
  async register(email: string, password: string, displayName: string | null): Promise<void> {
    const hash = await this.passwords.hash(password);
    const created = await this.identity.transaction(async (tx) => {
      const [row] = await tx
        .insert(consumer)
        .values({ email, passwordHash: hash, displayName })
        .onConflictDoNothing({ target: consumer.email })
        .returning({ id: consumer.id });
      if (!row) return null;
      return this.newVerificationToken(tx, row.id);
    });
    if (created) await this.mailer.sendVerification(email, this.verifyLink(created));
    else await this.mailer.sendAlreadyRegistered(email);
  }

  async login(email: string, password: string): Promise<ConsumerSession> {
    const [row] = await this.identity.db
      .select({ ...principalCols, passwordHash: consumer.passwordHash })
      .from(consumer)
      .where(eq(consumer.email, email));
    const ok = await this.passwords.verify(row?.passwordHash, password); // one argon2 call on every path
    if (!ok || !row || row.status !== 'active')
      throw unauthorized('invalid_credentials', 'E-mail or password is incorrect');
    await this.identity.db.update(consumer).set({ lastLoginAt: new Date() }).where(eq(consumer.id, row.id));
    return this.startSession(row);
  }

  /** Single-use. On the first transition to verified, announces `consumer.verified`. */
  async verifyEmail(token: string): Promise<{ email_verified: true }> {
    const ok = await this.identity.transaction(async (tx) => {
      const [v] = await tx
        .update(emailVerification)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(emailVerification.tokenHash, sha(token)),
            isNull(emailVerification.usedAt),
            gt(emailVerification.expiresAt, new Date()),
          ),
        )
        .returning({ consumerId: emailVerification.consumerId });
      if (!v) return false;
      await this.markVerified(tx, v.consumerId);
      return true;
    });
    if (!ok) throw badRequest('verification_token_invalid', 'This link is invalid or has expired');
    return { email_verified: true };
  }

  async resendVerification(email: string): Promise<void> {
    const token = await this.identity.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: consumer.id, verified: consumer.emailVerified })
        .from(consumer)
        .where(eq(consumer.email, email));
      return row && !row.verified ? this.newVerificationToken(tx, row.id) : null;
    });
    if (token) await this.mailer.sendVerification(email, this.verifyLink(token));
  }

  /**
   * Google sign-in. Requires the PROVIDER to assert the e-mail is verified.
   * Linking to an existing account by e-mail is safe only because of that
   * assertion — and if the existing account was never verified, its password
   * is unproven (anyone could have registered that address), so it is
   * cleared and its sessions are revoked before the accounts are joined.
   */
  async googleSignIn(p: GoogleProfile): Promise<ConsumerSession> {
    if (!p.emailVerified) throw forbidden('email_not_verified', 'Google did not verify this e-mail address');
    const principal = await this.identity.transaction(async (tx) => {
      const [linked] = await tx
        .select(principalCols)
        .from(consumerIdentity)
        .innerJoin(consumer, eq(consumer.id, consumerIdentity.consumerId))
        .where(and(eq(consumerIdentity.provider, 'google'), eq(consumerIdentity.subject, p.subject)));
      if (linked) return linked;

      const [existing] = await tx.select(principalCols).from(consumer).where(eq(consumer.email, p.email));
      let id: string;
      if (existing) {
        id = existing.id;
        if (!existing.emailVerified) {
          await tx
            .update(consumer)
            .set({ passwordHash: null, sessionVersion: sql`${consumer.sessionVersion} + 1` })
            .where(eq(consumer.id, id));
          await tx
            .update(refreshToken)
            .set({ revokedAt: new Date() })
            .where(and(eq(refreshToken.subjectId, id), eq(refreshToken.audience, 'consumer-v1'), isNull(refreshToken.revokedAt)));
          await this.markVerified(tx, id);
        }
      } else {
        const [row] = await tx
          .insert(consumer)
          .values({ email: p.email, displayName: p.displayName, emailVerified: true })
          .returning({ id: consumer.id });
        id = row!.id;
        await tx.insert(identityOutbox).values({ kind: 'consumer.verified', payload: { consumerId: id } });
      }
      await tx
        .insert(consumerIdentity)
        .values({ provider: 'google', subject: p.subject, consumerId: id, email: p.email })
        .onConflictDoNothing();
      const [fresh] = await tx.select(principalCols).from(consumer).where(eq(consumer.id, id));
      return fresh!;
    });
    if (principal.status !== 'active') throw unauthorized('invalid_credentials', 'This account is disabled');
    await this.identity.db.update(consumer).set({ lastLoginAt: new Date() }).where(eq(consumer.id, principal.id));
    return this.startSession(principal);
  }

  async rotate(token: string): Promise<ConsumerSession> {
    const subject = await this.refresh.consume('consumer-v1', token);
    const [row] = await this.identity.db.select(principalCols).from(consumer).where(eq(consumer.id, subject.subjectId));
    if (!row || row.status !== 'active' || row.sessionVersion !== subject.sessionVersion) {
      await this.refresh.revokeFamily(subject.familyId);
      throw unauthorized('session_revoked', 'Session is no longer valid; sign in again');
    }
    return this.startSession(row, subject.familyId);
  }

  logout(token: string): Promise<void> {
    return this.refresh.revokeByToken(token);
  }

  async profile(consumerId: string) {
    const [row] = await this.identity.db
      .select({ email: consumer.email, display_name: consumer.displayName, email_verified: consumer.emailVerified })
      .from(consumer)
      .where(eq(consumer.id, consumerId));
    if (!row) throw unauthorized('session_revoked', 'Account not found');
    return row;
  }

  // -------------------------------------------------------------------------

  private async markVerified(tx: IdentityDrizzle, consumerId: string): Promise<void> {
    const [flipped] = await tx
      .update(consumer)
      .set({ emailVerified: true })
      .where(and(eq(consumer.id, consumerId), eq(consumer.emailVerified, false)))
      .returning({ id: consumer.id });
    // Only the FIRST transition announces it, in the same transaction.
    if (flipped) await tx.insert(identityOutbox).values({ kind: 'consumer.verified', payload: { consumerId } });
  }

  private async newVerificationToken(tx: IdentityDrizzle, consumerId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await tx
      .insert(emailVerification)
      .values({ consumerId, tokenHash: sha(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) });
    return token;
  }

  private verifyLink(token: string): string {
    return `${this.cfg.publicUrl}/api/v1/auth/verify-email?token=${token}`;
  }

  private async startSession(p: Principal, familyId?: string): Promise<ConsumerSession> {
    const ttl = this.cfg.auth.accessTtl.consumer;
    // NO tenant_id: a consumer's tenant is an attribute of each transaction.
    const { token } = await this.jwt.sign(
      'consumer-v1',
      { typ: 'consumer', sub: p.id, email_verified: p.emailVerified },
      ttl,
    );
    const refresh = await this.refresh.issue(
      { audience: 'consumer-v1', subjectId: p.id, tenantId: null, sessionVersion: p.sessionVersion },
      familyId,
    );
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_token: refresh.token,
      refresh_expires_at: refresh.expiresAt.toISOString(),
      consumer: { email: p.email, display_name: p.displayName, email_verified: p.emailVerified },
    };
  }
}
