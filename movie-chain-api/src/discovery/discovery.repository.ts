import { Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { screening } from '../db/schema/screening';
import { db } from '../tenancy/tenant-context';

@Injectable()
export class DiscoveryRepository {
  /**
   * Inside ONE tenant's scope: which of these screenings are sold out.
   * "Taken" = sold, or held and not yet expired.
   */
  async soldOut(screeningIds: string[]): Promise<Set<string>> {
    if (!screeningIds.length) return new Set();
    const rows = await db()
      .select({
        id: screening.id,
        // Correlated subqueries name the outer table EXPLICITLY. Drizzle renders
        // ${screening.screenId} unqualified ("screen_id"), which inside the
        // subquery would bind to seat.screen_id and compare a column to itself.
        full: sql<boolean>`(
          SELECT count(*) FROM seat_lock l
           WHERE l.screening_id = "screening"."id" AND (l.status = 'sold' OR l.expires_at > now())
        ) >= (SELECT count(*) FROM seat st WHERE st.screen_id = "screening"."screen_id" AND st.is_active)`,
      })
      .from(screening)
      .where(inArray(screening.id, screeningIds));
    return new Set(rows.filter((r) => r.full).map((r) => r.id));
  }
}
