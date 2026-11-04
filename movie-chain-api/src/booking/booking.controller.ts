import { RateLimitTenantFrom } from '../tiering/decorators';
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { ConsumerRoute, Roles } from '../auth/decorators';
import { badRequest } from '../common/errors/api-error';
import { ConsumerService } from '../identity/consumer.service';
import { actorOf } from '../inventory/hold.controller';
import type { ConsumerRequest } from '../tenancy/consumer.guard';
import { DeferTenantTransaction } from '../tenancy/decorators';
import { currentTenant } from '../tenancy/tenant-context';
import { BookingHistoryService } from './booking-history.service';
import { BookingService, type Contact } from './booking.service';
import { BOOKING_TOKEN_HEADER } from './booking-token.service';
import { CancellationService } from './cancellation.service';
import { BoxOfficeSaleDto, CancelBookingDto, CreateBookingDto, ListBookingsQuery } from './dto';
import { Uuid } from '../common/validation/uuid.pipe';
import { MANAGERS } from '../scheduling/screening.controller';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { BookingLookupQuery } from './dto';
import { BookingTokenService } from './booking-token.service';
import { Doors } from '../tenancy/doors';
import { TenantDb } from '../tenancy/tenant-db.provider';
import { runWithTenant } from '../tenancy/tenant-context';
import { toSystemContext } from '../tenancy/system-context';
import { notFound } from '../common/errors/api-error';

const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function requireKey(key: string | undefined): string {
  if (!key) throw badRequest('idempotency_key_required', 'This endpoint requires an Idempotency-Key header');
  if (!KEY_RE.test(key)) throw badRequest('idempotency_key_invalid', 'Idempotency-Key must be 1–200 URL-safe characters');
  return key;
}

/**
 * Bookings. Guests need no account anywhere in this flow (FR-70). Every
 * handler opens its own short tenant scopes (@DeferTenantTransaction): the
 * payment capture must never run inside a transaction.
 */
@ApiTags('bookings')
@Controller()
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly history: BookingHistoryService,
    private readonly consumers: ConsumerService,
    private readonly cancellations: CancellationService,
    private readonly limiter: RateLimiter,
    private readonly bookingTokens: BookingTokenService,
    private readonly doors: Doors,
    private readonly tenantDb: TenantDb,
  ) {}

  /**
   * FR-73: retrieve a booking with no account — by its signed link, or by
   * reference PLUS e-mail. The reference alone is never enough (it would be
   * an enumeration oracle). Rate-limited per address; every miss is the same 404.
   */
  @ConsumerRoute()
  @DeferTenantTransaction()
  @ApiHeader({ name: BOOKING_TOKEN_HEADER, required: false })
  @RateLimitTenantFrom('booking_token')
  @Get('bookings/lookup')
  async lookup(@Query() q: BookingLookupQuery, @Headers(BOOKING_TOKEN_HEADER) token: string | undefined, @Req() req: ConsumerRequest) {
    await this.limiter.consume(`lookup:${req.ip ?? 'unknown'}`, 20, 60);
    let target: { tenantId: string; bookingId: string } | null;
    if (token) {
      const c = await this.bookingTokens.verify(token);
      target = { tenantId: c.tenant_id, bookingId: c.booking_id };
    } else {
      if (!q.reference || !q.email) throw badRequest('email_required', 'Look a booking up with its reference AND the e-mail it was made with');
      target = await this.doors.resolveBookingReference(q.reference, q.email);
    }
    if (!target) throw notFound();
    const found = target;
    return runWithTenant(toSystemContext({ tenantId: found.tenantId }, actorOf(req)), () =>
      this.tenantDb.withTenantScope(async () => {
        if (!(await this.bookings.exists(found.bookingId))) throw notFound();
        return this.bookings.view(found.bookingId);
      }),
    );
  }

  @ConsumerRoute()
  @DeferTenantTransaction()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @RateLimitTenantFrom('hold_token')
  @Post('bookings')
  async create(
    @Body() body: CreateBookingDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: ConsumerRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const contact: Contact = body.contact;
    // FR-77 inline link: only a VERIFIED account booking under its OWN e-mail.
    let linksCustomer = false;
    if (req.consumer?.emailVerified) {
      const me = await this.consumers.profile(req.consumer.id);
      linksCustomer = me.email.toLowerCase() === contact.email.toLowerCase();
    }
    const out = await this.bookings.checkout({
      holdToken: body.hold_token,
      idempotencyKey: requireKey(key),
      requestHash: hashOf(body),
      actor: actorOf(req),
      consumer: req.consumer ? { id: req.consumer.id, emailVerified: req.consumer.emailVerified } : null,
      linksCustomer,
      method: body.payment_method === 'mpesa' ? { kind: 'mpesa', phone: body.phone! } : { kind: 'card', cardToken: body.card_token! },
      contact,
    });
    res.status(out.status);
    return out.body;
  }

  /** FR-62–64: cancel some or all seats, with the booking's signed link. */
  @ConsumerRoute()
  @DeferTenantTransaction()
  @ApiHeader({ name: BOOKING_TOKEN_HEADER, required: true })
  @RateLimitTenantFrom('booking_token')
  @Post('bookings/:id/cancel')
  cancel(@Param('id', Uuid) id: string, @Body() body: CancelBookingDto, @Headers(BOOKING_TOKEN_HEADER) token: string | undefined, @Req() req: ConsumerRequest) {
    return this.cancellations.cancelBooking(id, token, body.seat_ids, actorOf(req));
  }

  /** FR-26: cancel a screening — holds released, every booking refunded. Safe to repeat. */
  @Roles(...MANAGERS)
  @DeferTenantTransaction()
  @HttpCode(200)
  @Post('screenings/:id/cancel')
  cancelScreening(@Param('id', Uuid) id: string) {
    return this.cancellations.cancelScreening(id);
  }

  /** FR-76: every chain, one list. The consumer id comes from the verified token only. */
  @ConsumerRoute({ requireAccount: true })
  @Get('bookings')
  list(@Query() q: ListBookingsQuery, @Req() req: ConsumerRequest) {
    return this.history.list(req.consumer!.id, q.before ? new Date(q.before) : new Date(), q.limit ?? 20);
  }

  /** FR-78: balances per chain, never pooled. */
  @ConsumerRoute({ requireAccount: true })
  @Get('me/loyalty')
  loyalty(@Req() req: ConsumerRequest) {
    return this.history.loyalty(req.consumer!.id);
  }

  /** FR-57: a clerk sells a box-office hold for cash (or a card terminal / till), settled at once. */
  @Roles('box_office', 'theatre_manager', 'chain_admin')
  @DeferTenantTransaction()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @Post('box-office/sales')
  async sell(@Body() body: BoxOfficeSaleDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const ctx = currentTenant();
    if (ctx.actor.kind !== 'staff') throw badRequest('staff_only', 'Box-office sales need a staff token');
    const out = await this.bookings.checkout({
      holdToken: body.hold_token,
      idempotencyKey: requireKey(key),
      requestHash: hashOf(body),
      actor: ctx.actor,
      consumer: null,
      linksCustomer: false,
      method: { kind: 'cash' },
      contact: body.contact ?? null,
      boxOffice: { ctx, tender: body.tender_type, clerkId: ctx.actor.userId },
    });
    res.status(out.status);
    return out.body;
  }
}
