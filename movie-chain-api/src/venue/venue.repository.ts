import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { screening } from '../db/schema/screening';
import { screen, seat, type Seat, theatre } from '../db/schema/venue';
import { currentTenant, db } from '../tenancy/tenant-context';

/**
 * Venue queries. Repositories call db() inside whatever tenant scope the
 * request opened — they never open, commit or roll back a transaction, and
 * they never name tenant_id in a WHERE clause (RLS does that). tenant_id is
 * only WRITTEN, taken from the verified context, never from input.
 */
@Injectable()
export class VenueRepository {
  // ------------------------------------------------------------- theatres
  async insertTheatre(v: { name: string; city: string; address?: string | null; timezone: string; contactPhone?: string | null }) {
    const [row] = await db()
      .insert(theatre)
      .values({ ...v, tenantId: currentTenant().tenantId })
      .returning();
    return row!;
  }

  listTheatres(onlyIds: ReadonlySet<string> | null) {
    const q = db().select().from(theatre).orderBy(asc(theatre.name));
    return onlyIds ? q.where(inArray(theatre.id, [...onlyIds])) : q;
  }

  async findTheatre(id: string) {
    const [row] = await db().select().from(theatre).where(eq(theatre.id, id));
    return row ?? null;
  }

  async updateTheatre(id: string, patch: Partial<{ name: string; city: string; address: string | null; timezone: string; contactPhone: string | null }>) {
    const [row] = await db().update(theatre).set(patch).where(eq(theatre.id, id)).returning();
    return row ?? null;
  }

  // --------------------------------------------------------------- screens
  async insertScreen(v: { theatreId: string; name: string; format: (typeof screen.$inferInsert)['format']; turnaroundMinutes: number | null }) {
    const [row] = await db()
      .insert(screen)
      .values({ ...v, tenantId: currentTenant().tenantId })
      .returning();
    return row!;
  }

  async findScreen(id: string) {
    const [row] = await db().select().from(screen).where(eq(screen.id, id));
    return row ?? null;
  }

  listScreens(theatreId: string) {
    return db().select().from(screen).where(eq(screen.theatreId, theatreId)).orderBy(asc(screen.name));
  }

  async updateScreen(id: string, patch: Partial<typeof screen.$inferInsert>) {
    const [row] = await db().update(screen).set(patch).where(eq(screen.id, id)).returning();
    return row ?? null;
  }

  /** Future, not-cancelled screenings on a screen (FR-15: the manager moves or cancels them). */
  futureScreeningsOn(screenId: string) {
    return db()
      .select({ id: screening.id, starts_at: screening.startsAt, status: screening.status })
      .from(screening)
      .where(and(eq(screening.screenId, screenId), ne(screening.status, 'cancelled'), gte(screening.startsAt, sql`now()`)))
      .orderBy(asc(screening.startsAt));
  }

  // ----------------------------------------------------------------- seats
  async countSeats(screenId: string): Promise<number> {
    const [r] = await db().select({ n: count() }).from(seat).where(eq(seat.screenId, screenId));
    return r?.n ?? 0;
  }

  async insertSeats(screenId: string, seats: Omit<typeof seat.$inferInsert, 'tenantId' | 'screenId'>[]): Promise<number> {
    if (!seats.length) return 0;
    const tenantId = currentTenant().tenantId;
    const rows = await db()
      .insert(seat)
      .values(seats.map((s) => ({ ...s, tenantId, screenId })))
      .returning({ id: seat.id });
    return rows.length;
  }

  listSeats(screenId: string): Promise<Seat[]> {
    return db().select().from(seat).where(eq(seat.screenId, screenId)).orderBy(asc(seat.rowIndex), asc(seat.colIndex));
  }

  async findSeatWithScreen(id: string) {
    const [row] = await db()
      .select({ seat, theatreId: screen.theatreId })
      .from(seat)
      .innerJoin(screen, eq(screen.id, seat.screenId))
      .where(eq(seat.id, id));
    return row ?? null;
  }

  async updateSeat(id: string, patch: Partial<Pick<Seat, 'seatClass' | 'isActive'>>) {
    const [row] = await db().update(seat).set(patch).where(eq(seat.id, id)).returning();
    return row ?? null;
  }
}
