import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { notFound } from '../common/errors/api-error';
import { staffTheatre } from '../db/schema/venue';
import { currentTenant, db } from '../tenancy/tenant-context';

export type TheatreScopeSet = { all: true } | { all: false; ids: ReadonlySet<string> };

/**
 * Theatre-level scoping inside a tenant (FR-5). A theatre_manager or
 * box_office user with staff_theatre rows sees only those theatres; with no
 * rows they cover the whole chain; a chain_admin always does.
 *
 * Out-of-scope resources are NOT FOUND — never forbidden — the same rule as
 * across tenants, applied one level down. Services call `assert` after
 * loading a resource; listings call `current` and filter.
 */
@Injectable()
export class TheatreScope {
  async current(): Promise<TheatreScopeSet> {
    const { actor } = currentTenant();
    if (actor.kind !== 'staff' || actor.role === 'chain_admin') return { all: true };
    const rows = await db()
      .select({ theatreId: staffTheatre.theatreId })
      .from(staffTheatre)
      .where(eq(staffTheatre.staffUserId, actor.userId));
    return rows.length === 0 ? { all: true } : { all: false, ids: new Set(rows.map((r) => r.theatreId)) };
  }

  async assert(theatreId: string): Promise<void> {
    const scope = await this.current();
    if (!scope.all && !scope.ids.has(theatreId)) throw notFound();
  }
}
