import { Injectable } from '@nestjs/common';

const TTL_MS = 30_000;

/**
 * screening id → tenant id, as resolved through the sanctioned door. A
 * published screening's tenant never changes, so a short positive cache saves
 * a database call per request on the busiest routes. Written ONLY by the rate
 * limit guard (after a real door lookup); read by it and by the early-refusal
 * middleware.
 */
@Injectable()
export class ScreeningTenants {
  private readonly map = new Map<string, { tenantId: string; at: number }>();

  get(screeningId: string): string | null {
    const hit = this.map.get(screeningId);
    return hit && Date.now() - hit.at < TTL_MS ? hit.tenantId : null;
  }

  set(screeningId: string, tenantId: string): void {
    if (this.map.size > 50_000) this.map.clear();
    this.map.set(screeningId, { tenantId, at: Date.now() });
  }
}
