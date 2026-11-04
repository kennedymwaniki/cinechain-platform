import { Body, Controller, Get, HttpCode, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { notFound, unprocessable } from '../common/errors/api-error';
import { createZodDto } from '../common/validation/zod-dto';
import { Uuid } from '../common/validation/uuid.pipe';
import { tenant, tier } from '../db/schema/tenant';
import { ControlDb } from '../tenancy/control-db.provider';

export class ChangePlanDto extends createZodDto(
  z
    .object({
      tier: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
      // A negotiated limit; null clears it (back to the tier's).
      rate_limit_rps: z.number().int().min(1).max(100000).nullable().optional(),
    })
    .strict(),
) {}

/**
 * Tiers are a catalogue of rows; a tenant's plan is a reference to one. A
 * change here reaches every API instance within TierConfig's cache window
 * (15 s) — well inside one token lifetime, with no deploy. A fifth tier is an
 * INSERT into `tier`: nothing in the code knows any tier by name.
 */
@ApiTags('tiers')
@ApiBearerAuth()
@Controller('admin')
export class TiersController {
  constructor(private readonly db: ControlDb) {}

  @Get('tiers')
  list() {
    return this.db.platformTx((tx) => tx.select().from(tier).orderBy(asc(tier.sortOrder)));
  }

  @Patch('tenants/:id/plan')
  @HttpCode(200)
  async change(@Param('id', Uuid) id: string, @Body() b: ChangePlanDto) {
    return this.db.platformTx(async (tx) => {
      const [t] = await tx.select({ code: tier.code, sellable: tier.sellable }).from(tier).where(eq(tier.code, b.tier));
      if (!t) throw unprocessable('unknown_tier', `No tier "${b.tier}"`);
      const [row] = await tx
        .update(tenant)
        .set({ tier: b.tier, ...(b.rate_limit_rps !== undefined ? { rateLimitRps: b.rate_limit_rps } : {}) })
        .where(eq(tenant.id, id))
        .returning({ id: tenant.id, tier: tenant.tier, rate_limit_rps: tenant.rateLimitRps });
      if (!row) throw notFound();
      return { ...row, takes_effect_within_s: 15 };
    });
  }
}
