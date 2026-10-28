import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SecurityEvents } from '../audit/security-event.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { refreshToken } from '../db/schema/platform';
import { IdentityDb } from '../tenancy/identity-db.provider';
import { unauthorized } from '../common/errors/api-error';

type RefreshAudience = 'staff-v1' | 'consumer-v1' | 'control-v1';

export interface RefreshSubject {
  audience: RefreshAudience;
  subjectId: string;
  tenantId: string | null;
  sessionVersion: number;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Opaque, rotating refresh tokens with reuse detection. Each login starts a
 * family; every refresh marks the presented token used and issues the next.
 * Presenting a token that was already rotated means it was copied: the whole
 * family is revoked and a security event is raised.
 */
@Injectable()
export class RefreshTokens {
  constructor(
    private readonly identity: IdentityDb,
    private readonly security: SecurityEvents,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async issue(subject: RefreshSubject, familyId: string = randomUUID()): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.cfg.auth.refreshTtl * 1000);
    await this.identity.db.insert(refreshToken).values({
      familyId,
      audience: subject.audience,
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      sessionVersion: subject.sessionVersion,
      tokenHash: hash(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  /**
   * Consumes a refresh token exactly once. The conditional UPDATE is the
   * decision: of two concurrent refreshes with the same token, one wins and
   * the other is treated as reuse.
   */
  async consume(audience: RefreshAudience, token: string): Promise<RefreshSubject & { familyId: string }> {
    const tokenHash = hash(token);
    const [won] = await this.identity.db
      .update(refreshToken)
      .set({ usedAt: new Date() })
      .where(and(eq(refreshToken.tokenHash, tokenHash), isNull(refreshToken.usedAt), isNull(refreshToken.revokedAt)))
      .returning();

    if (!won) {
      const [row] = await this.identity.db.select().from(refreshToken).where(eq(refreshToken.tokenHash, tokenHash));
      if (row && row.audience === audience) {
        await this.revokeFamily(row.familyId);
        await this.security.record('refresh_token_reuse', {
          tenantId: row.tenantId,
          actorSub: row.subjectId,
          detail: { familyId: row.familyId, audience },
        });
      }
      throw unauthorized('refresh_token_invalid', 'Refresh token is invalid');
    }
    if (won.audience !== audience || won.expiresAt.getTime() <= Date.now())
      throw unauthorized('refresh_token_invalid', 'Refresh token is invalid');

    return {
      audience: won.audience,
      subjectId: won.subjectId,
      tenantId: won.tenantId,
      sessionVersion: won.sessionVersion,
      familyId: won.familyId,
    };
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.identity.db
      .update(refreshToken)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshToken.familyId, familyId), isNull(refreshToken.revokedAt)));
  }

  /** Logout: revokes the family the presented token belongs to. Idempotent. */
  async revokeByToken(token: string): Promise<void> {
    const [row] = await this.identity.db
      .select({ familyId: refreshToken.familyId })
      .from(refreshToken)
      .where(eq(refreshToken.tokenHash, hash(token)));
    if (row) await this.revokeFamily(row.familyId);
  }
}
