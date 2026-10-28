import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { booking, type BookingStatus, loyaltyLedger, outboxEvent, ticket } from '../db/schema/booking';
import { idempotencyKey } from '../db/schema/audit';
import { screening } from '../db/schema/screening';
import { tenantCustomer } from '../db/schema/tenant-customer';
import { film } from '../db/schema/catalogue';
import { screen, seat, theatre } from '../db/schema/venue';
import { currentTenant, db } from '../tenancy/tenant-context';

const uuidArray = (ids: readonly string[]) => sql`ARRAY[${sql.join(
  ids.map((id) => sql`${id}`),
  sql`, `,
)}]::uuid[]`;

/** Tenant-scoped (RLS). Never manages transactions; never filters on tenant_id. */
@Injectable()
export class BookingRepository {
  // --- idempotency (committed on its own, BEFORE any capture) -------------

  async claimKey(key: string, endpoint: string, requestHash: string): Promise<boolean> {
    const rows = await db()
      .insert(idempotencyKey)
      .values({ tenantId: currentTenant().tenantId, key, endpoint, requestHash, expiresAt: new Date(Date.now() + 24 * 3600_000) })
      .onConflictDoNothing()
      .returning({ key: idempotencyKey.key });
    return rows.length === 1;
  }

  async priorKey(key: string, endpoint: string) {
    const [row] = await db()
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.endpoint, endpoint)));
    return row ?? null;
  }

  async completeKey(key: string, endpoint: string, status: number, body: unknown) {
    await db()
      .update(idempotencyKey)
      .set({ status: 'completed', responseStatus: status, responseBody: body ?? null })
      .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.endpoint, endpoint)));
  }

  async releaseKey(key: string, endpoint: string) {
    await db()
      .delete(idempotencyKey)
      .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.endpoint, endpoint), eq(idempotencyKey.status, 'in_progress')));
  }

  // --- the hold, as Postgres sees it ---------------------------------------

  /** This hold's live rows, and how long the SHORTEST has left — by Postgres's clock. */
  async holdState(holdId: string): Promise<{ seatIds: string[]; secondsLeft: number }> {
    const { rows } = await db().execute<{ seat_id: string; left_s: number }>(sql`
      SELECT seat_id, extract(epoch FROM expires_at - now())::float8 AS left_s
        FROM seat_lock WHERE hold_id = ${holdId}::uuid AND status = 'held' AND expires_at > now()`);
    return { seatIds: rows.map((r) => r.seat_id), secondsLeft: rows.length ? Math.min(...rows.map((r) => Number(r.left_s))) : 0 };
  }

  /**
   * THE atomicity: check-and-act collapsed into one statement. If anything —
   * the sweeper, a release, another converter — changed these rows, fewer
   * come back, and the caller abandons the sale.
   */
  async convert(v: { bookingId: string; screeningId: string; seatIds: readonly string[]; holdId: string }): Promise<string[]> {
    const { rows } = await db().execute<{ seat_id: string }>(sql`
      UPDATE seat_lock SET status = 'sold', expires_at = NULL, booking_id = ${v.bookingId}::uuid
       WHERE screening_id = ${v.screeningId}::uuid AND seat_id = ANY(${uuidArray(v.seatIds)})
         AND hold_id = ${v.holdId}::uuid AND status = 'held' AND expires_at > now()
      RETURNING seat_id`);
    return rows.map((r) => r.seat_id);
  }

  // --- bookings -------------------------------------------------------------

  async insertBooking(v: Omit<typeof booking.$inferInsert, 'tenantId'>) {
    const [row] = await db()
      .insert(booking)
      .values({ ...v, tenantId: currentTenant().tenantId })
      .returning();
    return row!;
  }

  async liveBookingForHold(holdId: string) {
    const [row] = await db()
      .select()
      .from(booking)
      .where(and(eq(booking.holdId, holdId), sql`${booking.status} <> 'expired'`));
    return row ?? null;
  }

  async byId(id: string) {
    const [row] = await db().select().from(booking).where(eq(booking.id, id));
    return row ?? null;
  }

  async byIds(ids: string[]) {
    return ids.length ? db().select().from(booking).where(inArray(booking.id, ids)) : [];
  }

  async setStatus(id: string, from: BookingStatus, to: BookingStatus, extra: { failureReason?: string; confirmedAt?: Date } = {}) {
    const [row] = await db()
      .update(booking)
      .set({ status: to, ...extra })
      .where(and(eq(booking.id, id), eq(booking.status, from)))
      .returning();
    return row ?? null;
  }

  async setConsumer(id: string, consumerId: string) {
    await db().update(booking).set({ consumerId }).where(and(eq(booking.id, id), sql`${booking.consumerId} IS NULL`));
  }

  // --- tickets, customers, loyalty, outbox ---------------------------------

  async insertTickets(rows: Omit<typeof ticket.$inferInsert, 'tenantId'>[]) {
    const tenantId = currentTenant().tenantId;
    return db()
      .insert(ticket)
      .values(rows.map((r) => ({ ...r, tenantId })))
      .returning();
  }

  async ticketsFor(bookingIds: string[]) {
    return bookingIds.length ? db().select().from(ticket).where(inArray(ticket.bookingId, bookingIds)) : [];
  }

  /** What THIS chain knows about a customer. consumer_id is set only for a verified account (FR-77). */
  async upsertCustomer(email: string, name: string | null, linkConsumerId: string | null) {
    await db()
      .insert(tenantCustomer)
      .values({ tenantId: currentTenant().tenantId, email, displayName: name, consumerId: linkConsumerId })
      .onConflictDoUpdate({
        target: [tenantCustomer.tenantId, tenantCustomer.email],
        set: {
          displayName: sql`coalesce(excluded.display_name, ${tenantCustomer.displayName})`,
          consumerId: sql`coalesce(${tenantCustomer.consumerId}, excluded.consumer_id)`,
        },
      });
  }

  /** Keyed on the booking: a replay inserts nothing and awards nothing. */
  async awardLoyalty(bookingId: string, email: string, points: number): Promise<boolean> {
    const rows = await db()
      .insert(loyaltyLedger)
      .values({ tenantId: currentTenant().tenantId, bookingId, kind: 'award', email, points })
      .onConflictDoNothing()
      .returning({ bookingId: loyaltyLedger.bookingId });
    if (!rows.length) return false;
    await db()
      .update(tenantCustomer)
      .set({ loyaltyPoints: sql`${tenantCustomer.loyaltyPoints} + ${points}` })
      .where(eq(tenantCustomer.email, email));
    return true;
  }

  async outbox(kind: string, payload: Record<string, unknown>): Promise<number> {
    const [row] = await db()
      .insert(outboxEvent)
      .values({ tenantId: currentTenant().tenantId, kind, payload })
      .returning({ id: outboxEvent.id });
    return row!.id;
  }

  async seatsAndShow(screeningId: string, seatIds: readonly string[]) {
    const seats = await db()
      .select({ id: seat.id, row: seat.rowLabel, number: seat.seatNumber, seatClass: seat.seatClass })
      .from(seat)
      .where(inArray(seat.id, [...seatIds]));
    const [show] = await db()
      .select({ startsAt: screening.startsAt, format: screening.format, film: film.title, theatre: theatre.name, screen: screen.name })
      .from(screening)
      .innerJoin(screen, eq(screen.id, screening.screenId))
      .innerJoin(theatre, eq(theatre.id, screen.theatreId))
      .innerJoin(film, eq(film.id, screening.filmId))
      .where(eq(screening.id, screeningId));
    return { seats, show: show ?? null };
  }
}
