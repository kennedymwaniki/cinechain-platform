import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuditLog } from '../audit/audit-log.service';
import { badRequest, conflict, notFound } from '../common/errors/api-error';
import type { StaffRole } from '../db/schema/staff-user';
import { currentTenant } from '../tenancy/tenant-context';
import { TenantRegistry } from '../tenancy/tenant-registry.service';
import { StaffInviteMailer } from './staff-invite.mailer';
import { type StaffRecord, StaffRepository } from './staff.repository';

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

const view = (s: StaffRecord, theatreIds: string[]) => ({
  id: s.id,
  email: s.email,
  display_name: s.displayName,
  role: s.role,
  status: s.status,
  // empty = whole chain
  theatre_ids: theatreIds,
  last_login_at: s.lastLoginAt,
  created_at: s.createdAt,
});

/** FR-5: a chain admin invites, scopes, suspends and removes staff. */
@Injectable()
export class StaffService {
  constructor(
    private readonly repo: StaffRepository,
    private readonly registry: TenantRegistry,
    private readonly mailer: StaffInviteMailer,
    private readonly audit: AuditLog,
  ) {}

  async list() {
    const rows = await this.repo.list();
    const scopes = await this.repo.theatresOf(rows.map((r) => r.id));
    return rows.map((r) => view(r, scopes.get(r.id) ?? []));
  }

  async get(id: string) {
    const s = await this.load(id);
    return view(s, (await this.repo.theatresOf([id])).get(id) ?? []);
  }

  /**
   * Returns the activation token to send; the CALLER sends it after the
   * transaction commits, so a rolled-back invite never e-mails a dead link.
   */
  async invite(v: { email: string; displayName: string | null; role: StaffRole; theatreIds: string[] }) {
    await this.validateScope(v.role, v.theatreIds);
    const staff = await this.repo.insertInvited({ email: v.email, displayName: v.displayName, role: v.role });
    await this.repo.replaceTheatres(staff.id, v.theatreIds);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.repo.insertActivation(staff.id, createHash('sha256').update(token).digest('hex'), expiresAt);
    await this.audit.record('staff.invited', 'staff_user', staff.id, { role: v.role, theatre_ids: v.theatreIds });
    const tenant = await this.registry.byId(currentTenant().tenantId);
    return {
      staff: { ...view(staff, v.theatreIds), invitation_expires_at: expiresAt },
      deliver: () => this.mailer.sendActivation(v.email, tenant!.slug, token),
    };
  }

  async setTheatres(id: string, theatreIds: string[]) {
    const s = await this.load(id);
    await this.validateScope(s.role, theatreIds);
    await this.repo.replaceTheatres(id, theatreIds);
    await this.audit.record('staff.theatres_changed', 'staff_user', id, { theatre_ids: theatreIds });
    return view(s, theatreIds);
  }

  async suspend(id: string) {
    const s = await this.load(id);
    if (s.status === 'suspended') return this.get(id);
    if (s.status !== 'active') throw conflict('invalid_state', `Cannot suspend a staff user who is ${s.status}`);
    await this.guardLastAdmin(s);
    await this.repo.setStatus(id, 'suspended');
    await this.audit.record('staff.suspended', 'staff_user', id);
    return this.get(id);
  }

  async reactivate(id: string) {
    const s = await this.load(id);
    if (s.status === 'active') return this.get(id);
    if (s.status !== 'suspended') throw conflict('invalid_state', `Cannot reactivate a staff user who is ${s.status}`);
    await this.repo.setStatus(id, 'active');
    await this.audit.record('staff.reactivated', 'staff_user', id);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const s = await this.load(id);
    await this.guardLastAdmin(s);
    await this.repo.delete(id);
    await this.audit.record('staff.removed', 'staff_user', id, { email: s.email, role: s.role });
  }

  // -------------------------------------------------------------------------

  private async load(id: string): Promise<StaffRecord> {
    const s = await this.repo.find(id);
    if (!s) throw notFound();
    return s;
  }

  /** A chain must always keep at least one active chain_admin. */
  private async guardLastAdmin(target: StaffRecord): Promise<void> {
    if (target.role !== 'chain_admin' || target.status !== 'active') return;
    const admins = await this.repo.lockActiveAdmins();
    if (admins.length <= 1 && admins.includes(target.id))
      throw conflict('last_chain_admin', 'A chain must keep at least one active chain admin');
  }

  private async validateScope(role: StaffRole, theatreIds: string[]): Promise<void> {
    if (role === 'chain_admin' && theatreIds.length)
      throw badRequest('invalid_scope', 'A chain_admin always covers the whole chain; omit theatre_ids');
    const found = await this.repo.existingTheatres(theatreIds);
    // Another chain's theatre id is simply not found.
    if (found.size !== new Set(theatreIds).size) throw notFound();
  }
}
