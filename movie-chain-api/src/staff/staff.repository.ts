import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { staffActivation, staffUser, type StaffRole } from '../db/schema/staff-user';
import { staffTheatre, theatre } from '../db/schema/venue';
import { currentTenant, db } from '../tenancy/tenant-context';

/** Columns a staff record may expose. password_hash is never selected here. */
const publicColumns = {
  id: staffUser.id,
  email: staffUser.email,
  displayName: staffUser.displayName,
  role: staffUser.role,
  status: staffUser.status,
  lastLoginAt: staffUser.lastLoginAt,
  createdAt: staffUser.createdAt,
};

@Injectable()
export class StaffRepository {
  async find(id: string): Promise<StaffRecord | null> {
    const [row] = await db().select(publicColumns).from(staffUser).where(eq(staffUser.id, id));
    return row ?? null;
  }

  list() {
    return db().select(publicColumns).from(staffUser).orderBy(asc(staffUser.email));
  }

  async theatresOf(staffIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!staffIds.length) return out;
    const rows = await db()
      .select({ staffUserId: staffTheatre.staffUserId, theatreId: staffTheatre.theatreId })
      .from(staffTheatre)
      .where(inArray(staffTheatre.staffUserId, staffIds));
    for (const r of rows) out.set(r.staffUserId, [...(out.get(r.staffUserId) ?? []), r.theatreId]);
    return out;
  }

  /** Ids from `ids` that exist (in this tenant — RLS). */
  async existingTheatres(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db().select({ id: theatre.id }).from(theatre).where(inArray(theatre.id, ids));
    return new Set(rows.map((r) => r.id));
  }

  async insertInvited(v: { email: string; displayName: string | null; role: StaffRole }) {
    const [row] = await db()
      .insert(staffUser)
      .values({ ...v, tenantId: currentTenant().tenantId, status: 'invited' })
      .returning(publicColumns);
    return row!;
  }

  async insertActivation(staffUserId: string, tokenHash: string, expiresAt: Date) {
    await db().insert(staffActivation).values({ tenantId: currentTenant().tenantId, staffUserId, tokenHash, expiresAt });
  }

  async replaceTheatres(staffUserId: string, theatreIds: string[]) {
    await db().delete(staffTheatre).where(eq(staffTheatre.staffUserId, staffUserId));
    if (theatreIds.length)
      await db()
        .insert(staffTheatre)
        .values(theatreIds.map((theatreId) => ({ tenantId: currentTenant().tenantId, staffUserId, theatreId })));
  }

  /**
   * Locks every active chain_admin row for the rest of the transaction and
   * returns their ids. Two admins suspending each other concurrently would
   * otherwise both see "2 admins" and leave the chain with none.
   */
  async lockActiveAdmins(): Promise<string[]> {
    const rows = await db()
      .select({ id: staffUser.id })
      .from(staffUser)
      .where(and(eq(staffUser.role, 'chain_admin'), eq(staffUser.status, 'active')))
      .for('update');
    return rows.map((r) => r.id);
  }

  /** Status change that also ends every session (refresh tokens check session_version). */
  async setStatus(id: string, status: 'active' | 'suspended') {
    const [row] = await db()
      .update(staffUser)
      .set({ status, sessionVersion: sql`${staffUser.sessionVersion} + 1` })
      .where(eq(staffUser.id, id))
      .returning(publicColumns);
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await db().delete(staffUser).where(eq(staffUser.id, id)).returning({ id: staffUser.id });
    return rows.length > 0;
  }
}

export type StaffRecord = NonNullable<Awaited<ReturnType<StaffRepository['insertInvited']>>>;
