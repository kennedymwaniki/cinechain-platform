import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { admissionEvent, type AdmissionResult } from '../db/schema/admission';
import { ticket } from '../db/schema/booking';
import { screening } from '../db/schema/screening';
import { screen, seat, theatre } from '../db/schema/venue';
import { notFound } from '../common/errors/api-error';
import { ScreeningService } from '../scheduling/screening.service';
import { currentTenant, db } from '../tenancy/tenant-context';
import { TicketCodeService } from './ticket-code.service';
import { Metrics } from '../observability/metrics.module';

/**
 * FR-60/61. A scan is decided by ONE conditional UPDATE — valid, same
 * screening, not yet used — so two simultaneous scans of the same ticket
 * cannot both pass: the second matches no row. Only then is the reason read.
 * Codes are compared as SHA-256 digests through a unique index, so response
 * time says nothing about how close a guess was. Every scan is recorded.
 */
@Injectable()
export class AdmissionService {
  constructor(
    private readonly screenings: ScreeningService,
    private readonly metrics: Metrics,
  ) {}

  async redeem(code: string, screeningId: string, deviceId: string) {
    // The screening being admitted: this chain's, within the clerk's theatres (else 404).
    const at = await this.screenings.get(screeningId);
    const { tenantId, actor } = currentTenant();
    const operatorId = actor.kind === 'staff' ? actor.userId : null;
    if (!operatorId) throw notFound();

    let result: AdmissionResult;
    let ticketId: string | null = null;
    let redeemedAt: Date | null = null;

    const hash = TicketCodeService.looksLikeCode(code) ? TicketCodeService.hash(code) : null;
    const [won] = hash
      ? await db()
          .update(ticket)
          .set({ status: 'redeemed', redeemedAt: sql`now()` })
          .where(and(eq(ticket.codeHash, hash), eq(ticket.screeningId, screeningId), eq(ticket.status, 'valid')))
          .returning({ id: ticket.id, redeemedAt: ticket.redeemedAt })
      : [];
    if (won) {
      result = 'valid';
      ticketId = won.id;
      redeemedAt = won.redeemedAt;
    } else {
      const [t] = hash ? await db().select().from(ticket).where(eq(ticket.codeHash, hash)) : [];
      if (!t) result = 'invalid'; // no such ticket IN THIS CHAIN (RLS): another chain's code is indistinguishable
      else {
        ticketId = t.id;
        redeemedAt = t.redeemedAt;
        if (t.status === 'void') result = 'void';
        else if (t.screeningId !== screeningId) result = (await this.sameLocalDay(t.screeningId, screeningId)) ? 'wrong_screening' : 'wrong_day';
        else result = 'already_used';
      }
    }

    await db().insert(admissionEvent).values({ tenantId, ticketId, screeningId, result, deviceId, operatorId });
    this.metrics.inc('admission.scans_total', { tenant: tenantId, result });
    const seatInfo = ticketId ? await this.seatOf(ticketId) : null;
    return {
      result,
      screening: { id: at.id, starts_at: at.starts_at },
      ...(seatInfo ? { seat: seatInfo } : {}),
      ...(result === 'already_used' && redeemedAt ? { first_scanned_at: redeemedAt.toISOString() } : {}),
    };
  }

  /** Same calendar day in the THEATRE's time zone, not the server's. */
  private async sameLocalDay(a: string, b: string): Promise<boolean> {
    const rows = await db()
      .select({ day: sql<string>`(${screening.startsAt} AT TIME ZONE ${theatre.timezone})::date::text` })
      .from(screening)
      .innerJoin(screen, eq(screen.id, screening.screenId))
      .innerJoin(theatre, eq(theatre.id, screen.theatreId))
      .where(sql`${screening.id} IN (${a}::uuid, ${b}::uuid)`);
    return rows.length === 2 && rows[0]!.day === rows[1]!.day;
  }

  private async seatOf(ticketId: string) {
    const [s] = await db()
      .select({ row: seat.rowLabel, number: seat.seatNumber })
      .from(ticket)
      .innerJoin(seat, eq(seat.id, ticket.seatId))
      .where(eq(ticket.id, ticketId));
    return s ?? null;
  }
}
