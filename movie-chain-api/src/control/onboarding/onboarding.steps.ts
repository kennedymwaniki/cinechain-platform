import { and, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { RecordedResource } from '../../db/schema/control';
import { staffActivation, staffUser } from '../../db/schema/staff-user';
import { pricingRule } from '../../db/schema/catalogue';
import { tenant } from '../../db/schema/tenant';
import { screen, seat, theatre } from '../../db/schema/venue';
import { generateLayout } from '../../venue/seat-layout.generator';
import { db } from '../../tenancy/tenant-context';

export interface OnboardingRequest {
  name: string;
  slug: string;
  tier: 'basic' | 'standard' | 'premium' | 'dedicated';
  country: string;
  contactEmail: string;
  contactName?: string | undefined;
}

export interface StepContext {
  runId: string;
  tenantId: string;
  request: OnboardingRequest;
  /** Side effects to run AFTER the step's transaction commits (e-mail). */
  afterCommit: (fn: () => Promise<void>) => void;
  send: { activation: (email: string, slug: string, token: string) => Promise<void> };
}

/**
 * One step = one transaction, run inside the NEW tenant's scope (RLS
 * applies). It returns every resource it created; those rows are recorded
 * in onboarding_step in the same transaction, so compensation reads a list.
 * Steps must be idempotent: a step whose row is `done` is skipped on resume.
 *
 * Resources are recorded in CREATION order; compensation deletes them in reverse.
 */
export interface OnboardingStep {
  name: string;
  run(ctx: StepContext): Promise<RecordedResource[]>;
}

/** A chain's currency follows its country; every price it sets is in that currency. */
export const CURRENCY_BY_COUNTRY: Record<string, 'KES' | 'UGX' | 'TZS' | 'RWF'> = { KE: 'KES', UG: 'UGX', TZ: 'TZS', RW: 'RWF' };

/**
 * Starter prices per currency, in MINOR units (FR-3) — UGX and RWF have no
 * minor unit. Placeholders the chain admin replaces on day one; written out
 * per currency rather than converted, because converting money is exactly
 * the kind of arithmetic that should never happen implicitly.
 */
const STARTER_PRICES = {
  KES: { standard: 65000, vip: 120000, accessible: 65000, companion: 65000 }, //  KES 650 / 1,200
  UGX: { standard: 18000, vip: 35000, accessible: 18000, companion: 18000 }, //   UGX 18,000 / 35,000
  TZS: { standard: 1200000, vip: 2200000, accessible: 1200000, companion: 1200000 }, // TZS 12,000 / 22,000
  RWF: { standard: 6000, vip: 11000, accessible: 6000, companion: 6000 }, //      RWF 6,000 / 11,000
  USD: { standard: 500, vip: 900, accessible: 500, companion: 500 }, //           USD 5 / 9
} as const;

export const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    name: 'create_tenant',
    async run({ tenantId, request }) {
      await db().insert(tenant).values({
        id: tenantId,
        slug: request.slug,
        name: request.name,
        tier: request.tier,
        country: request.country,
        currency: CURRENCY_BY_COUNTRY[request.country] ?? 'USD',
        status: 'provisioning',
      });
      return [{ table: 'tenant', key: { id: tenantId } }];
    },
  },
  {
    name: 'create_chain_admin',
    async run({ tenantId, request, afterCommit, send }) {
      const [admin] = await db()
        .insert(staffUser)
        .values({
          tenantId,
          email: request.contactEmail,
          displayName: request.contactName ?? null,
          role: 'chain_admin',
          status: 'invited',
        })
        .returning({ id: staffUser.id });
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await db()
        .insert(staffActivation)
        .values({ tenantId, tokenHash, staffUserId: admin!.id, expiresAt: new Date(Date.now() + ACTIVATION_TTL_MS) });
      afterCommit(() => send.activation(request.contactEmail, request.slug, token));
      return [
        { table: 'staff_activation', key: { tenant_id: tenantId, token_hash: tokenHash } },
        { table: 'staff_user', key: { tenant_id: tenantId, id: admin!.id } },
      ];
    },
  },
  {
    // FR-3: an empty tenant is a poor first impression and generates support load.
    name: 'seed_sample_theatre',
    async run({ tenantId }) {
      const [t] = await db()
        .insert(theatre)
        .values({ tenantId, name: 'Sample Theatre', city: 'Nairobi', timezone: 'Africa/Nairobi' })
        .returning({ id: theatre.id });
      const [s] = await db()
        .insert(screen)
        .values({ tenantId, theatreId: t!.id, name: 'Screen 1' })
        .returning({ id: screen.id });
      const layout = generateLayout({ rows: 8, seatsPerRow: 12, defaultClass: 'standard', aisleAfter: [6] });
      await db()
        .insert(seat)
        .values(layout.map((x) => ({ ...x, tenantId, screenId: s!.id })));
      return [
        { table: 'theatre', key: { tenant_id: tenantId, id: t!.id } },
        { table: 'screen', key: { tenant_id: tenantId, id: s!.id } },
        { table: 'seat', key: { tenant_id: tenantId, screen_id: s!.id } },
      ];
    },
  },
  {
    name: 'seed_default_pricing',
    async run({ tenantId, request }) {
      const currency = CURRENCY_BY_COUNTRY[request.country] ?? 'USD';
      const rows = await db()
        .insert(pricingRule)
        .values(
          Object.entries(STARTER_PRICES[currency]).map(([seatClass, priceMinor]) => ({
            tenantId,
            seatClass: seatClass as keyof (typeof STARTER_PRICES)['KES'],
            format: null,
            priceMinor,
            currency,
            effectiveFrom: new Date(),
          })),
        )
        .returning({ id: pricingRule.id });
      return rows.map((r) => ({ table: 'pricing_rule', key: { tenant_id: tenantId, id: r.id } }));
    },
  },
  {
    name: 'activate_tenant',
    async run({ tenantId }) {
      await db().update(tenant).set({ status: 'active' }).where(eq(tenant.id, tenantId));
      return [];
    },
  },
];

/**
 * Deletes one recorded resource. Runs inside the tenant's scope. The table
 * list is closed: compensation can delete exactly what onboarding creates.
 */
export async function deleteResource(r: RecordedResource): Promise<void> {
  switch (r.table) {
    case 'staff_activation':
      await db().delete(staffActivation).where(eq(staffActivation.tokenHash, r.key.token_hash!));
      return;
    case 'staff_user':
      await db().delete(staffUser).where(eq(staffUser.id, r.key.id!));
      return;
    case 'seat': // every seat of a screen (recorded once, not 96 times)
      await db().delete(seat).where(eq(seat.screenId, r.key.screen_id!));
      return;
    case 'screen':
      await db().delete(screen).where(eq(screen.id, r.key.id!));
      return;
    case 'theatre':
      await db().delete(theatre).where(eq(theatre.id, r.key.id!));
      return;
    case 'pricing_rule':
      await db().delete(pricingRule).where(eq(pricingRule.id, r.key.id!));
      return;
    case 'tenant':
      await db().delete(tenant).where(and(eq(tenant.id, r.key.id!)));
      return;
    default:
      throw new Error(`onboarding cannot compensate unknown resource table "${r.table}"`);
  }
}
