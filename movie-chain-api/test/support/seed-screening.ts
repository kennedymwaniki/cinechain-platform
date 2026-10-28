import type { Client } from 'pg';

/**
 * A screening with N active seats (plus one inactive), in the given status.
 * Seat ids come back in seat-number order.
 */
export async function seedScreening(
  c: Client,
  tenantId: string,
  opts: { city?: string; title?: string; status?: string; seats?: number; startsInHours?: number } = {},
) {
  const th = (await c.query(`INSERT INTO theatre (tenant_id, name, city) VALUES ($1, $2, $3) RETURNING id`, [tenantId, `T-${Math.random().toString(36).slice(2, 8)}`, opts.city ?? 'Nairobi'])).rows[0].id;
  const sc = (await c.query(`INSERT INTO screen (tenant_id, theatre_id, name) VALUES ($1, $2, 'S1') RETURNING id`, [tenantId, th])).rows[0].id;
  const seats = (
    await c.query(
      `INSERT INTO seat (tenant_id, screen_id, row_label, seat_number, row_index, col_index)
       SELECT $1, $2, 'A', n, 0, n - 1 FROM generate_series(1, $3::int) n RETURNING id`,
      [tenantId, sc, opts.seats ?? 4],
    )
  ).rows.map((r) => r.id as string);
  await c.query(
    `INSERT INTO seat (tenant_id, screen_id, row_label, seat_number, row_index, col_index, is_active) VALUES ($1, $2, 'B', 1, 1, 0, false)`,
    [tenantId, sc],
  );
  const film = (await c.query(`INSERT INTO film (tenant_id, title, runtime_min, language, rating) VALUES ($1, $2, 120, 'English', 'PG') RETURNING id`, [tenantId, opts.title ?? 'Avengers: Doomsday'])).rows[0].id;
  const scr = (
    await c.query(
      `INSERT INTO screening (tenant_id, screen_id, film_id, starts_at, ends_at, turnaround_minutes, format, status)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4::int), now() + make_interval(hours => $4::int + 2), 60, 'standard', $5::screening_status)
       RETURNING id`,
      [tenantId, sc, film, opts.startsInHours ?? 24, opts.status ?? 'published'],
    )
  ).rows[0].id as string;
  return { theatreId: th as string, screenId: sc as string, filmId: film as string, screeningId: scr, seatIds: seats };
}

export async function lockSeat(c: Client, tenantId: string, screeningId: string, seatId: string, how: 'held' | 'expired' | 'sold', holdId?: string) {
  await c.query(
    `INSERT INTO seat_lock (screening_id, seat_id, tenant_id, status, hold_id, expires_at)
     VALUES ($1, $2, $3, $4::lock_status, $5::uuid,
             CASE $6 WHEN 'held' THEN now() + interval '5 minutes' WHEN 'expired' THEN now() - interval '1 minute' END)`,
    [screeningId, seatId, tenantId, how === 'sold' ? 'sold' : 'held', holdId ?? null, how],
  );
}
