import { Injectable } from '@nestjs/common';
import { announceTenant } from './tenant-context';
import { TenantDb, UUID_RE } from './tenant-db.provider';

export interface ShowtimeRow {
  tenant_id: string;
  chain_slug: string;
  chain_name: string;
  theatre_id: string;
  theatre_name: string;
  city: string;
  timezone: string;
  screen_id: string;
  film_id: string;
  title: string;
  runtime_min: number;
  rating: string | null;
  language: string | null;
  poster_key: string | null;
  screening_id: string;
  starts_at: Date;
  format: string;
}

export interface ShowtimeFilter {
  city?: string | undefined;
  from: Date;
  to: Date;
  filmId?: string | undefined;
  title?: string | undefined;
  language?: string | undefined;
  rating?: string | undefined;
  format?: string | undefined;
}

/**
 * The ONLY application entry points to the sanctioned cross-tenant read doors
 * (SECURITY DEFINER functions owned by cinechain_resolver). They run with no
 * tenant set — that is the point — and return the tenant as DATA, which the
 * caller then turns into a scope with toSystemContext(). The tenant id never
 * comes from the caller: only from these lookups.
 */
@Injectable()
export class Doors {
  constructor(private readonly tenantDb: TenantDb) {}

  /** Published screening of an active chain → its tenant. Anything else → null. */
  async resolvePublishedScreening(screeningId: string): Promise<{ tenantId: string } | null> {
    if (!UUID_RE.test(screeningId)) return null;
    const rows = await this.tenantDb.registryQuery<{ tenant_id: string }>(
      'SELECT tenant_id FROM resolve_published_screening($1::uuid)',
      [screeningId],
    );
    if (rows[0]) announceTenant(rows[0].tenant_id);
    return rows[0] ? { tenantId: rows[0].tenant_id } : null;
  }

  /** A provider's charge reference → the tenant and payment that own it. Call only AFTER verifying the webhook. */
  async resolvePaymentTenant(provider: string, providerRef: string): Promise<{ tenantId: string; paymentId: string } | null> {
    const rows = await this.tenantDb.registryQuery<{ tenant_id: string; payment_id: string }>(
      'SELECT tenant_id, payment_id FROM resolve_payment_tenant($1, $2)',
      [provider, providerRef],
    );
    if (rows[0]) announceTenant(rows[0].tenant_id);
    return rows[0] ? { tenantId: rows[0].tenant_id, paymentId: rows[0].payment_id } : null;
  }

  /** FR-76: (tenant, booking) POINTERS for one consumer. No amounts, names or seats. */
  async consumerBookingRefs(consumerId: string, before: Date, limit: number): Promise<{ tenantId: string; bookingId: string; createdAt: Date }[]> {
    if (!UUID_RE.test(consumerId)) return [];
    const rows = await this.tenantDb.registryQuery<{ tenant_id: string; booking_id: string; created_at: Date }>(
      'SELECT tenant_id, booking_id, created_at FROM consumer_booking_refs($1::uuid, $2, $3)',
      [consumerId, before, limit],
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, bookingId: r.booking_id, createdAt: new Date(r.created_at) }));
  }

  /** FR-77: chains with unlinked guest purchases under this e-mail. Call only for a VERIFIED e-mail. */
  async tenantsWithUnlinkedGuest(email: string): Promise<{ tenantId: string }[]> {
    const rows = await this.tenantDb.registryQuery<{ tenant_id: string }>('SELECT tenant_id FROM tenants_with_unlinked_guest($1::citext)', [email]);
    return rows.map((r) => ({ tenantId: r.tenant_id }));
  }

  /** FR-73: reference AND e-mail → the booking they name. Neither alone finds anything. */
  async resolveBookingReference(reference: string, email: string): Promise<{ tenantId: string; bookingId: string } | null> {
    const rows = await this.tenantDb.registryQuery<{ tenant_id: string; booking_id: string }>(
      'SELECT tenant_id, booking_id FROM resolve_booking_reference($1, $2::citext)',
      [reference, email],
    );
    // Two chains with the same reference AND the same customer e-mail: refuse rather than guess.
    if (rows.length === 1) announceTenant(rows[0]!.tenant_id);
    return rows.length === 1 ? { tenantId: rows[0]!.tenant_id, bookingId: rows[0]!.booking_id } : null;
  }

  /** Published showtimes across every chain: poster data only, no demand signals. */
  publicShowtimes(f: ShowtimeFilter): Promise<ShowtimeRow[]> {
    return this.tenantDb.registryQuery<ShowtimeRow>(
      'SELECT * FROM public_showtimes($1, $2, $3, $4::uuid, $5, $6, $7, $8)',
      [f.city ?? null, f.from, f.to, f.filmId ?? null, f.title ?? null, f.language ?? null, f.rating ?? null, f.format ?? null],
    );
  }
}
