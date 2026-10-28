import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { film } from '../db/schema/catalogue';
import { seatLock } from '../db/schema/inventory';
import { screening } from '../db/schema/screening';
import { screen, seat, theatre } from '../db/schema/venue';
import { db } from '../tenancy/tenant-context';

/** Runs inside the screening's tenant scope (resolved from the resource, never the caller). */
@Injectable()
export class SeatmapRepository {
  async screeningMeta(screeningId: string) {
    const [row] = await db()
      .select({
        id: screening.id,
        status: screening.status,
        startsAt: screening.startsAt,
        format: screening.format,
        screenId: screen.id,
        screenName: screen.name,
        theatreName: theatre.name,
        timezone: theatre.timezone,
        filmTitle: film.title,
      })
      .from(screening)
      .innerJoin(screen, eq(screen.id, screening.screenId))
      .innerJoin(theatre, eq(theatre.id, screen.theatreId))
      .innerJoin(film, eq(film.id, screening.filmId))
      .where(eq(screening.id, screeningId));
    return row ?? null;
  }

  activeSeats(screenId: string) {
    return db()
      .select({ id: seat.id, row: seat.rowLabel, number: seat.seatNumber, x: seat.colIndex, y: seat.rowIndex, seatClass: seat.seatClass })
      .from(seat)
      .where(and(eq(seat.screenId, screenId), eq(seat.isActive, true)))
      .orderBy(asc(seat.rowIndex), asc(seat.colIndex));
  }

  locks(screeningId: string) {
    return db()
      .select({ seatId: seatLock.seatId, status: seatLock.status, holdId: seatLock.holdId, expiresAt: seatLock.expiresAt })
      .from(seatLock)
      .where(eq(seatLock.screeningId, screeningId));
  }
}
