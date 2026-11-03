import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { db } from '../tenancy/tenant-context';

export type OccupancyRow = {
  screening_id: string;
  starts_at: Date;
  status: string;
  film: string;
  theatre_id: string;
  theatre: string;
  screen: string;
  capacity: number;
  sold: number;
  held: number;
};

export type RevenueRow = {
  theatre_id: string;
  theatre: string;
  bookings: number;
  tickets: number;
  total_minor: number;
};

/**
 * Every aggregate here runs through db() — inside a tenant scope, under RLS.
 * There is no raw pool and no WHERE on tenant_id: a SUM that forgot the
 * tenant would still see one tenant's rows only, because the database
 * decides. (Aggregates are the easiest place for isolation to leak.)
 *
 * Correlated subqueries name their outer alias explicitly (see CLAUDE.md).
 */
@Injectable()
export class ReportingRepository {
  async occupancy(from: Date, to: Date, theatreIds: string[] | null): Promise<OccupancyRow[]> {
    const { rows } = await db().execute<OccupancyRow>(sql`
      SELECT s.id AS screening_id, s.starts_at, s.status::text AS status, f.title AS film,
             th.id AS theatre_id, th.name AS theatre, sc.name AS screen,
             (SELECT count(*)::int FROM seat st WHERE st.screen_id = s.screen_id AND st.is_active) AS capacity,
             (SELECT count(*)::int FROM seat_lock l WHERE l.screening_id = s.id AND l.status = 'sold') AS sold,
             (SELECT count(*)::int FROM seat_lock l WHERE l.screening_id = s.id AND l.status = 'held' AND l.expires_at > now()) AS held
        FROM screening s
        JOIN screen  sc ON sc.id = s.screen_id
        JOIN theatre th ON th.id = sc.theatre_id
        JOIN film    f  ON f.id  = s.film_id
       WHERE s.starts_at >= ${from} AND s.starts_at < ${to}
         AND s.status IN ('published', 'closed', 'completed')
         ${theatreIds ? sql`AND th.id = ANY(${sql`ARRAY[${sql.join(theatreIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]`})` : sql``}
       ORDER BY s.starts_at, s.id
       LIMIT 5000`);
    return rows;
  }

  /** Revenue kept: the captured prices of tickets still valid (or admitted) on confirmed bookings. */
  async revenueByTheatre(from: Date, to: Date): Promise<RevenueRow[]> {
    const { rows } = await db().execute<RevenueRow>(sql`
      SELECT th.id AS theatre_id, th.name AS theatre,
             count(DISTINCT b.id)::int AS bookings, count(t.id)::int AS tickets,
             coalesce(sum(t.price_minor), 0)::bigint AS total_minor
        FROM booking b
        JOIN ticket  t  ON t.booking_id = b.id AND t.status <> 'void'
        JOIN screening s ON s.id = b.screening_id
        JOIN screen  sc ON sc.id = s.screen_id
        JOIN theatre th ON th.id = sc.theatre_id
       WHERE b.status = 'confirmed' AND b.confirmed_at >= ${from} AND b.confirmed_at < ${to}
       GROUP BY th.id, th.name
       ORDER BY th.name`);
    return rows.map((r) => ({ ...r, total_minor: Number(r.total_minor) }));
  }

  async refunded(from: Date, to: Date): Promise<number> {
    const { rows } = await db().execute<{ s: string }>(sql`
      SELECT coalesce(sum(amount_minor), 0)::bigint AS s FROM payment_refund
       WHERE status = 'succeeded' AND created_at >= ${from} AND created_at < ${to}`);
    return Number(rows[0]!.s);
  }

  /** For the pool-isolation test and nothing else: hold a reporting connection busy. */
  async sleep(seconds: number): Promise<void> {
    await db().execute(sql`SELECT pg_sleep(${seconds})`);
  }
}
