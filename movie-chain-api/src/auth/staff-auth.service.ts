import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { SecurityEvents } from '../audit/security-event.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { staffUser, type StaffRole } from '../db/schema/staff-user';
import { forbidden, unauthorized } from '../common/errors/api-error';
import { db, runWithTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { type TenantRecord, TenantRegistry } from '../tenancy/tenant-registry.service';
import { toSystemContext } from '../tenancy/system-context';
import { JwtService } from './jwt.service';
import { PasswordService } from './password.service';
import { RefreshTokens } from './refresh-token.service';

export interface StaffPrincipal {
  id: string;
  email: string;
  displayName: string | null;
  role: StaffRole;
  sessionVersion: number;
  tenant: TenantRecord;
}

export interface StaffSession {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: string;
  staff: { id: string; email: string; display_name: string | null; role: StaffRole };
  tenant: { id: string; slug: string; name: string };
}

// Columns a staff lookup may return. password_hash is selected ONLY by
// verifyCredentials and never leaves this file.
const principalColumns = {
  id: staffUser.id,
  email: staffUser.email,
  displayName: staffUser.displayName,
  role: staffUser.role,
  status: staffUser.status,
  sessionVersion: staffUser.sessionVersion,
};

@Injectable()
export class StaffAuthService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly registry: TenantRegistry,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly refresh: RefreshTokens,
    private readonly security: SecurityEvents,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Opens a SYSTEM scope for the tenant named by the login form. That is not
   * trusting the caller: the credential check still has to pass against a
   * row inside that tenant, and RLS confines the lookup to it.
   */
  async verifyCredentials(tenantSlug: string, email: string, password: string): Promise<StaffPrincipal> {
    const tenant = await this.registry.bySlug(tenantSlug);
    const row = tenant
      ? await this.inTenant(tenant.id, 'staff-login', async () => {
          const [r] = await db()
            .select({ ...principalColumns, passwordHash: staffUser.passwordHash })
            .from(staffUser)
            .where(eq(staffUser.email, email))
            .limit(1);
          return r;
        })
      : undefined;

    // Exactly one argon2 verification on every path, found or not.
    const ok = await this.passwords.verify(row?.passwordHash, password);
    if (!ok || !row || !tenant || row.status !== 'active') {
      await this.security.record('login_failed', { tenantId: tenant?.id ?? null, detail: { tenantSlug } });
      throw unauthorized('invalid_credentials', 'E-mail or password is incorrect');
    }
    if (tenant.status !== 'active') throw forbidden('tenant_suspended', 'This cinema chain is not currently active');

    await this.inTenant(tenant.id, 'staff-login', () =>
      db().update(staffUser).set({ lastLoginAt: new Date() }).where(eq(staffUser.id, row.id)),
    );
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      sessionVersion: row.sessionVersion,
      tenant,
    };
  }

  async startSession(p: StaffPrincipal): Promise<StaffSession> {
    const refresh = await this.refresh.issue({
      audience: 'staff-v1',
      subjectId: p.id,
      tenantId: p.tenant.id,
      sessionVersion: p.sessionVersion,
    });
    return this.session(p, refresh);
  }

  async rotate(refreshToken: string): Promise<StaffSession> {
    const subject = await this.refresh.consume('staff-v1', refreshToken);
    const tenant = subject.tenantId ? await this.registry.byId(subject.tenantId) : null;
    if (!tenant) throw unauthorized('refresh_token_invalid', 'Refresh token is invalid');

    const row = await this.inTenant(tenant.id, 'staff-refresh', async () => {
      const [r] = await db().select(principalColumns).from(staffUser).where(eq(staffUser.id, subject.subjectId));
      return r;
    });
    // Suspension, removal, or a bumped session_version all end the session here.
    if (!row || row.status !== 'active' || row.sessionVersion !== subject.sessionVersion) {
      await this.refresh.revokeFamily(subject.familyId);
      throw unauthorized('session_revoked', 'Session is no longer valid; sign in again');
    }
    if (tenant.status !== 'active') throw forbidden('tenant_suspended', 'This cinema chain is not currently active');

    const principal: StaffPrincipal = { ...row, tenant };
    const refresh = await this.refresh.issue(
      { audience: 'staff-v1', subjectId: row.id, tenantId: tenant.id, sessionVersion: row.sessionVersion },
      subject.familyId,
    );
    return this.session(principal, refresh);
  }

  logout(refreshToken: string): Promise<void> {
    return this.refresh.revokeByToken(refreshToken);
  }

  private async session(p: StaffPrincipal, refresh: { token: string; expiresAt: Date }): Promise<StaffSession> {
    const ttl = this.cfg.auth.accessTtl.staff;
    const { token } = await this.jwt.sign(
      'staff-v1',
      { typ: 'staff', sub: p.id, tenant_id: p.tenant.id, tenant_slug: p.tenant.slug, role: p.role, sv: p.sessionVersion },
      ttl,
    );
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_token: refresh.token,
      refresh_expires_at: refresh.expiresAt.toISOString(),
      staff: { id: p.id, email: p.email, display_name: p.displayName, role: p.role },
      tenant: { id: p.tenant.id, slug: p.tenant.slug, name: p.tenant.name },
    };
  }

  private inTenant<T>(tenantId: string, reason: string, fn: () => Promise<T>): Promise<T> {
    return runWithTenant(toSystemContext({ tenantId }, { kind: 'system', reason }), () =>
      this.tenantDb.withTenantScope(fn),
    );
  }
}
