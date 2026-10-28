import { Injectable } from '@nestjs/common';
import { notFound } from '../common/errors/api-error';
import { currentTenant } from '../tenancy/tenant-context';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { TheatreScope } from '../venue/theatre-scope.service';
import { HoldService } from './hold.service';
import { SeatmapRepository } from './seatmap.repository';

/** FR-48: shorter, because the customer is standing at the counter. */
export const BOX_OFFICE_HOLD_SECONDS = 90;

/**
 * Box-office holds. The same inventory and the same atomic path as online
 * holds (FR-42: one inventory, no exceptions), with the tenant from the
 * clerk's JWT, a 90 s window, and the clerk recorded on the row.
 */
@Injectable()
export class BoxOfficeHoldService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly screenings: SeatmapRepository,
    private readonly scope: TheatreScope,
    private readonly holds: HoldService,
  ) {}

  async place(v: { screeningId: string; seatIds: string[]; gapOverrideReason?: string | undefined }) {
    const ctx = currentTenant();
    if (ctx.actor.kind !== 'staff') throw notFound();
    await this.tenantDb.withTenantScope(async () => {
      // RLS: another chain's screening is simply not found. So is one outside the clerk's theatres.
      const meta = await this.screenings.screeningMeta(v.screeningId);
      if (!meta || meta.status !== 'published') throw notFound();
      await this.scope.assert(meta.theatreId);
    });
    return this.holds.place({
      ctx,
      screeningId: v.screeningId,
      seatIds: v.seatIds,
      ttlSeconds: BOX_OFFICE_HOLD_SECONDS,
      channel: 'box_office',
      heldByStaff: ctx.actor.userId,
      gapOverrideReason: v.gapOverrideReason ?? null,
    });
  }
}
