import { Injectable } from '@nestjs/common';
import { AuditLog } from '../audit/audit-log.service';
import { badRequest, conflict, notFound } from '../common/errors/api-error';
import type { Screen, Seat, Theatre } from '../db/schema/venue';
import { ScreenLayoutPolicy } from './screen-layout.policy';
import { generateLayout, LayoutError, type LayoutSpec } from './seat-layout.generator';
import { TheatreScope } from './theatre-scope.service';
import { VenueRepository } from './venue.repository';

export const theatreView = (t: Theatre) => ({
  id: t.id,
  name: t.name,
  city: t.city,
  address: t.address,
  timezone: t.timezone,
  contact_phone: t.contactPhone,
  created_at: t.createdAt,
});

export const screenView = (s: Screen, seatCount?: number) => ({
  id: s.id,
  theatre_id: s.theatreId,
  name: s.name,
  format: s.format,
  status: s.status,
  out_of_service_reason: s.outOfServiceReason,
  out_of_service_until: s.outOfServiceUntil,
  turnaround_minutes: s.turnaroundMinutes, // null = the chain's default
  ...(seatCount === undefined ? {} : { capacity: seatCount }),
});

export const seatView = (s: Seat) => ({
  id: s.id,
  row: s.rowLabel,
  number: s.seatNumber,
  x: s.colIndex,
  y: s.rowIndex,
  seat_class: s.seatClass,
  is_active: s.isActive,
});

@Injectable()
export class VenueService {
  constructor(
    private readonly repo: VenueRepository,
    private readonly scope: TheatreScope,
    private readonly layoutPolicy: ScreenLayoutPolicy,
    private readonly audit: AuditLog,
  ) {}

  // ------------------------------------------------------------- theatres
  async createTheatre(v: Parameters<VenueRepository['insertTheatre']>[0]) {
    const t = await this.repo.insertTheatre(v);
    await this.audit.record('theatre.created', 'theatre', t.id, { name: t.name });
    return theatreView(t);
  }

  async listTheatres() {
    const s = await this.scope.current();
    return (await this.repo.listTheatres(s.all ? null : s.ids)).map(theatreView);
  }

  async getTheatre(id: string) {
    const t = await this.loadTheatre(id);
    const screens = await this.repo.listScreens(t.id);
    return { ...theatreView(t), screens: screens.map((s) => screenView(s)) };
  }

  async updateTheatre(id: string, patch: Parameters<VenueRepository['updateTheatre']>[1]) {
    await this.loadTheatre(id);
    const t = (await this.repo.updateTheatre(id, patch))!;
    await this.audit.record('theatre.updated', 'theatre', id, { fields: Object.keys(patch) });
    return theatreView(t);
  }

  // --------------------------------------------------------------- screens
  async createScreen(v: Parameters<VenueRepository['insertScreen']>[0]) {
    await this.loadTheatre(v.theatreId); // another chain's (or out-of-scope) theatre → 404
    const s = await this.repo.insertScreen(v);
    await this.audit.record('screen.created', 'screen', s.id, { theatre_id: v.theatreId });
    return screenView(s, 0);
  }

  /** Changing a screen's default affects screenings created AFTER; scheduled ones keep their copy. */
  async updateScreen(id: string, patch: { name?: string; turnaroundMinutes?: number | null }) {
    await this.loadScreen(id);
    const s = (await this.repo.updateScreen(id, patch))!;
    await this.audit.record('screen.updated', 'screen', id, { ...patch });
    return screenView(s);
  }

  async getScreen(id: string) {
    const s = await this.loadScreen(id);
    const seats = await this.repo.listSeats(id);
    return { ...screenView(s, seats.filter((x) => x.isActive).length), seats: seats.map(seatView) };
  }

  async setOutOfService(id: string, reason: string, until: Date | null) {
    await this.loadScreen(id);
    const s = (await this.repo.updateScreen(id, {
      status: 'out_of_service',
      outOfServiceReason: reason,
      outOfServiceUntil: until,
    }))!;
    await this.audit.record('screen.out_of_service', 'screen', id, { reason, until });
    // Not auto-cancelled: the manager decides, and cancelling may mean refunds.
    return { ...screenView(s), affected_screenings: await this.repo.futureScreeningsOn(id) };
  }

  async restore(id: string) {
    const current = await this.loadScreen(id);
    if (current.status === 'active') return screenView(current);
    const s = (await this.repo.updateScreen(id, { status: 'active', outOfServiceReason: null, outOfServiceUntil: null }))!;
    await this.audit.record('screen.restored', 'screen', id);
    return screenView(s);
  }

  // ----------------------------------------------------------------- seats
  async generateSeats(screenId: string, spec: LayoutSpec) {
    await this.loadScreen(screenId);
    await this.layoutPolicy.assertLayoutMutable(screenId);
    let seats;
    try {
      seats = generateLayout(spec);
    } catch (e) {
      if (e instanceof LayoutError) throw badRequest('invalid_layout', e.message);
      throw e;
    }
    // A second generate is a mistake, not an update: refuse rather than duplicate.
    // (The unique (screen, row, number) constraint would also stop it.)
    if ((await this.repo.countSeats(screenId)) > 0)
      throw conflict('layout_exists', 'This screen already has a seat layout; edit individual seats instead');
    const created = await this.repo.insertSeats(screenId, seats);
    await this.audit.record('screen.layout_generated', 'screen', screenId, { seats: created, rows: spec.rows });
    return { screen_id: screenId, created };
  }

  async updateSeat(id: string, patch: { seatClass?: Seat['seatClass']; isActive?: boolean }) {
    const found = await this.repo.findSeatWithScreen(id);
    if (!found) throw notFound();
    await this.scope.assert(found.theatreId);
    await this.layoutPolicy.assertLayoutMutable(found.seat.screenId);
    const s = (await this.repo.updateSeat(id, patch))!;
    await this.audit.record('seat.updated', 'seat', id, { ...patch });
    return seatView(s);
  }

  // ---------------------------------------------------------------- loaders
  private async loadTheatre(id: string): Promise<Theatre> {
    const t = await this.repo.findTheatre(id);
    if (!t) throw notFound();
    await this.scope.assert(t.id);
    return t;
  }

  private async loadScreen(id: string): Promise<Screen> {
    const s = await this.repo.findScreen(id);
    if (!s) throw notFound();
    await this.scope.assert(s.theatreId);
    return s;
  }
}
