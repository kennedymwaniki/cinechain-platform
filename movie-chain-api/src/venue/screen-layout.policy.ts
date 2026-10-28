import { Injectable } from '@nestjs/common';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { conflict } from '../common/errors/api-error';
import { seatLock } from '../db/schema/inventory';
import { screening } from '../db/schema/screening';
import { db } from '../tenancy/tenant-context';

/**
 * FR-14: a screen's seat layout may not change while a future screening on it
 * has sold seats — those tickets name physical seats.
 */
@Injectable()
export class ScreenLayoutPolicy {
  async assertLayoutMutable(screenId: string): Promise<void> {
    const [hit] = await db()
      .select({ one: sql`1` })
      .from(seatLock)
      .innerJoin(screening, eq(screening.id, seatLock.screeningId))
      .where(
        and(
          eq(screening.screenId, screenId),
          gt(screening.startsAt, sql`now()`),
          ne(screening.status, 'cancelled'),
          eq(seatLock.status, 'sold'),
        ),
      )
      .limit(1);
    if (hit) throw conflict('layout_locked', 'Future screenings on this screen have sold seats; the layout cannot change');
  }
}
