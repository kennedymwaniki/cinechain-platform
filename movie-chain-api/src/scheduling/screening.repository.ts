import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { film } from '../db/schema/catalogue';
import { screening, type ScreeningStatus } from '../db/schema/screening';
import { screen, seat, theatre } from '../db/schema/venue';
import { currentTenant, db } from '../tenancy/tenant-context';

@Injectable()
export class ScreeningRepository {
  async insert(v: { screenId: string; filmId: string; startsAt: Date; endsAt: Date; turnaroundMinutes: number; format: string }) {
    const [row] = await db()
      .insert(screening)
      .values({ ...v, tenantId: currentTenant().tenantId })
      .returning();
    return row!;
  }

  async find(id: string) {
    const [row] = await db()
      .select({ screening, theatreId: screen.theatreId, screenStatus: screen.status, filmTitle: film.title })
      .from(screening)
      .innerJoin(screen, eq(screen.id, screening.screenId))
      .innerJoin(film, eq(film.id, screening.filmId))
      .where(eq(screening.id, id));
    return row ?? null;
  }

  list(f: { theatreIds: string[] | null; from: Date; to: Date }) {
    return db()
      .select({ screening, theatreId: screen.theatreId, screenName: screen.name, filmTitle: film.title })
      .from(screening)
      .innerJoin(screen, eq(screen.id, screening.screenId))
      .innerJoin(film, eq(film.id, screening.filmId))
      .where(
        and(
          gte(screening.startsAt, f.from),
          lt(screening.startsAt, f.to),
          f.theatreIds ? inArray(screen.theatreId, f.theatreIds) : undefined,
        ),
      )
      .orderBy(asc(screening.startsAt))
      .limit(1000);
  }

  /** Conditional transition: changes the row only if it is still in `from`. */
  async transition(id: string, from: ScreeningStatus, to: ScreeningStatus) {
    const extra =
      to === 'published' ? { publishedAt: new Date() } : to === 'cancelled' ? { cancelledAt: new Date() } : {};
    const [row] = await db()
      .update(screening)
      .set({ status: to, ...extra })
      .where(and(eq(screening.id, id), eq(screening.status, from)))
      .returning();
    return row ?? null;
  }

  async activeSeatCount(screenId: string): Promise<number> {
    const [r] = await db().select({ n: count() }).from(seat).where(and(eq(seat.screenId, screenId), eq(seat.isActive, true)));
    return r?.n ?? 0;
  }

  /**
   * Screenings to copy forward (FR-24), with their new start computed IN THE
   * THEATRE'S TIME ZONE: "the 20:30 showing" stays 20:30 local even across a
   * daylight-saving change. `fromDate` is a local calendar date.
   */
  sourcesForCopy(theatreId: string, fromDate: string, spanDays: number, shiftDays: number) {
    const local = sql`(${screening.startsAt} AT TIME ZONE ${theatre.timezone})`;
    return db()
      .select({
        sourceId: screening.id,
        screenId: screening.screenId,
        filmId: screening.filmId,
        format: screening.format,
        turnaroundMinutes: screening.turnaroundMinutes,
        durationMs: sql<number>`(extract(epoch from (${screening.endsAt} - ${screening.startsAt})) * 1000)::bigint`.mapWith(Number),
        newStartsAt: sql<Date>`((${local} + make_interval(days => ${shiftDays}::int)) AT TIME ZONE ${theatre.timezone})`.mapWith(
          (v: string | Date) => new Date(v),
        ),
      })
      .from(screening)
      .innerJoin(screen, eq(screen.id, screening.screenId))
      .innerJoin(theatre, eq(theatre.id, screen.theatreId))
      .where(
        and(
          eq(screen.theatreId, theatreId),
          ne(screening.status, 'cancelled'),
          sql`${local} >= ${fromDate}::date`,
          sql`${local} < ${fromDate}::date + make_interval(days => ${spanDays}::int)`,
        ),
      )
      .orderBy(asc(screening.startsAt));
  }
}
