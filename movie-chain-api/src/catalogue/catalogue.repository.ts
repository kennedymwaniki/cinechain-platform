import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { film, pricingRule, type PricingRule } from '../db/schema/catalogue';
import type { ScreenFormat, SeatClass } from '../db/schema/venue';
import { currentTenant, db } from '../tenancy/tenant-context';

@Injectable()
export class CatalogueRepository {
  // ----------------------------------------------------------------- films
  async insertFilm(v: Omit<typeof film.$inferInsert, 'tenantId' | 'id' | 'createdAt' | 'posterKey'>) {
    const [row] = await db()
      .insert(film)
      .values({ ...v, tenantId: currentTenant().tenantId })
      .returning();
    return row!;
  }

  async findFilm(id: string) {
    const [row] = await db().select().from(film).where(eq(film.id, id));
    return row ?? null;
  }

  /** Keyset page on (lower(title), id). */
  listFilms(limit: number, after: [string, string] | null) {
    const key = sql`(lower(${film.title}), ${film.id})`;
    return db()
      .select()
      .from(film)
      .where(after ? sql`${key} > (${after[0]}, ${after[1]}::uuid)` : undefined)
      .orderBy(sql`lower(${film.title})`, asc(film.id))
      .limit(limit + 1);
  }

  async updateFilm(id: string, patch: Partial<typeof film.$inferInsert>) {
    const [row] = await db().update(film).set(patch).where(eq(film.id, id)).returning();
    return row ?? null;
  }

  // --------------------------------------------------------------- pricing
  listRules() {
    return db().select().from(pricingRule).orderBy(asc(pricingRule.seatClass), asc(pricingRule.format), desc(pricingRule.effectiveFrom));
  }

  /** Rules that could apply at or after `from` — the ones a new rule must not overlap. */
  rulesFrom(seatClass: SeatClass, format: ScreenFormat | null, from: Date): Promise<PricingRule[]> {
    return db()
      .select()
      .from(pricingRule)
      .where(
        and(
          eq(pricingRule.seatClass, seatClass),
          format === null ? isNull(pricingRule.format) : eq(pricingRule.format, format),
          or(isNull(pricingRule.effectiveTo), gt(pricingRule.effectiveTo, from)),
        ),
      )
      .for('update');
  }

  async closeRule(id: string, at: Date) {
    await db().update(pricingRule).set({ effectiveTo: at }).where(eq(pricingRule.id, id));
  }

  async insertRule(v: Omit<typeof pricingRule.$inferInsert, 'tenantId' | 'id' | 'createdAt'>) {
    const [row] = await db()
      .insert(pricingRule)
      .values({ ...v, tenantId: currentTenant().tenantId })
      .returning();
    return row!;
  }

  /** Every rule that could price something at or after `at` (for resolvePrice). */
  rulesCovering(at: Date) {
    return db()
      .select()
      .from(pricingRule)
      .where(or(isNull(pricingRule.effectiveTo), gt(pricingRule.effectiveTo, at)));
  }
}
