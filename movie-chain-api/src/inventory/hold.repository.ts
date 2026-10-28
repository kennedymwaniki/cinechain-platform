import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { db } from '../tenancy/tenant-context';

const uuidArray = (ids: readonly string[]) => sql`ARRAY[${sql.join(
  ids.map((id) => sql`${id}`),
  sql`, `,
)}]::uuid[]`;

/**
 * The durable record of holds. Runs inside the screening's tenant scope; RLS
 * keeps every statement inside that tenant, so no WHERE names tenant_id.
 */
@Injectable()
export class HoldRepository {
  /**
   * ONE statement that is both the belt to Redis's braces and the complete
   * Redis-down path. The primary key (screening_id, seat_id) is the
   * guarantee. An existing row is taken over only if it is a hold that has
   * genuinely expired — never a sold seat, never a live hold. expires_at
   * comes from Postgres now(): one clock for every instance.
   */
  async insertHeld(v: {
    screeningId: string;
    tenantId: string;
    holdId: string;
    ttlSeconds: number;
    seatIds: readonly string[];
    heldByStaff: string | null;
  }): Promise<{ seatId: string; expiresAt: Date }[]> {
    const { rows } = await db().execute<{ seat_id: string; expires_at: Date }>(sql`
      INSERT INTO seat_lock (screening_id, seat_id, tenant_id, status, hold_id, expires_at, held_by_staff)
      SELECT ${v.screeningId}::uuid, s.seat_id, ${v.tenantId}::uuid, 'held', ${v.holdId}::uuid,
             now() + ${v.ttlSeconds}::int * interval '1 second', ${v.heldByStaff}::uuid
        FROM unnest(${uuidArray(v.seatIds)}) AS s(seat_id)
      ON CONFLICT (screening_id, seat_id) DO UPDATE
         SET hold_id = EXCLUDED.hold_id, expires_at = EXCLUDED.expires_at, status = 'held',
             booking_id = NULL, extensions = 0, held_by_staff = EXCLUDED.held_by_staff
       WHERE seat_lock.status = 'held'          -- NEVER steal a sold seat
         AND seat_lock.expires_at < now()       -- only a genuinely dead hold
      RETURNING seat_id, expires_at`);
    return rows.map((r) => ({ seatId: r.seat_id, expiresAt: new Date(r.expires_at) }));
  }

  /** Which of these seats are taken, and whether by a LIVE hold (vs sold). */
  async blockers(screeningId: string, seatIds: readonly string[]): Promise<{ seatId: string; status: 'held' | 'sold' }[]> {
    const { rows } = await db().execute<{ seat_id: string; status: 'held' | 'sold' }>(sql`
      SELECT seat_id, status FROM seat_lock
       WHERE screening_id = ${screeningId}::uuid AND seat_id = ANY(${uuidArray(seatIds)})
         AND (status = 'sold' OR expires_at >= now())`);
    return rows.map((r) => ({ seatId: r.seat_id, status: r.status }));
  }

  /** Deletes only this hold's still-held rows. A sold seat is never released here. */
  async release(holdId: string): Promise<string[]> {
    const { rows } = await db().execute<{ seat_id: string }>(sql`
      DELETE FROM seat_lock WHERE hold_id = ${holdId}::uuid AND status = 'held' RETURNING seat_id`);
    return rows.map((r) => r.seat_id);
  }

  /** FR-45: once, only while live. Returns the rows actually extended. */
  async extend(holdId: string, bySeconds: number): Promise<{ seatId: string; expiresAt: Date }[]> {
    const { rows } = await db().execute<{ seat_id: string; expires_at: Date }>(sql`
      UPDATE seat_lock SET expires_at = expires_at + ${bySeconds}::int * interval '1 second', extensions = extensions + 1
       WHERE hold_id = ${holdId}::uuid AND status = 'held' AND expires_at > now() AND extensions = 0
      RETURNING seat_id, expires_at`);
    return rows.map((r) => ({ seatId: r.seat_id, expiresAt: new Date(r.expires_at) }));
  }

  async now(): Promise<Date> {
    const { rows } = await db().execute<{ now: Date }>(sql`SELECT now() AS now`);
    return new Date(rows[0]!.now);
  }
}
