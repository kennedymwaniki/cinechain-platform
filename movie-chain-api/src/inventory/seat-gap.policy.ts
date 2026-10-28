/**
 * FR-47, seat-gap prevention driven by demand. PURE: no clock, no I/O.
 *
 * A stranded single seat is lost revenue on a sell-out night and harmless on
 * a quiet one, so the rule only runs when the tenant enables it, the room is
 * busy enough, and the screening is far enough away that someone else could
 * still buy the seat. Even then it refuses only when a gap-free block of the
 * same size and seat classes exists, and it says which one.
 */
export interface GapSeat {
  id: string;
  row: number; // row_index
  col: number; // col_index; a missing column is an aisle
  seatClass: string;
}

export interface GapConfig {
  policy: 'off' | 'demand' | 'always';
  occupancyThreshold: number; // percent, 0–100
  liftMinutes: number;
}

export type GapVerdict =
  | { ok: true; reason: 'policy_off' | 'below_threshold' | 'starting_soon' | 'no_gap' | 'no_alternative' }
  | { ok: false; gapSeatIds: string[]; suggestion: string[] };

/**
 * @param seats      the ACTIVE seats of the screen. Inactive seats are absent, so
 *                   they never count as neighbours; nor do aisles or row ends.
 * @param taken      seats already held or sold by anyone
 * @param selection  the seats being requested
 */
export function checkSeatGap(
  seats: readonly GapSeat[],
  taken: ReadonlySet<string>,
  selection: readonly string[],
  minutesToStart: number,
  cfg: GapConfig,
): GapVerdict {
  if (cfg.policy === 'off') return { ok: true, reason: 'policy_off' };
  if (minutesToStart <= cfg.liftMinutes) return { ok: true, reason: 'starting_soon' };
  if (cfg.policy === 'demand' && seats.length > 0) {
    const projected = ((taken.size + selection.length) * 100) / seats.length;
    if (projected < cfg.occupancyThreshold) return { ok: true, reason: 'below_threshold' };
  }

  const layout = indexLayout(seats);
  const created = createdGaps(layout, taken, selection);
  if (created.length === 0) return { ok: true, reason: 'no_gap' };

  const suggestion = bestAlternative(layout, taken, selection);
  if (!suggestion) return { ok: true, reason: 'no_alternative' };
  return { ok: false, gapSeatIds: created, suggestion };
}

interface Layout {
  byId: Map<string, GapSeat>;
  rows: Map<number, Map<number, GapSeat>>; // row → col → seat
}

function indexLayout(seats: readonly GapSeat[]): Layout {
  const rows = new Map<number, Map<number, GapSeat>>();
  for (const s of seats) {
    if (!rows.has(s.row)) rows.set(s.row, new Map());
    rows.get(s.row)!.set(s.col, s);
  }
  return { byId: new Map(seats.map((s) => [s.id, s])), rows };
}

/** Empty seats whose left AND right neighbours both exist and are occupied. */
function gaps(layout: Layout, occupied: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const row of layout.rows.values())
    for (const s of row.values()) {
      if (occupied.has(s.id)) continue;
      const left = row.get(s.col - 1);
      const right = row.get(s.col + 1);
      if (left && right && occupied.has(left.id) && occupied.has(right.id)) out.add(s.id);
    }
  return out;
}

/** Only gaps THIS selection creates. A gap that already exists never blocks anyone. */
function createdGaps(layout: Layout, taken: ReadonlySet<string>, selection: readonly string[]): string[] {
  const before = gaps(layout, taken);
  const after = gaps(layout, new Set([...taken, ...selection]));
  return [...after].filter((id) => !before.has(id)).sort();
}

const classKey = (ids: readonly string[], layout: Layout) =>
  ids
    .map((id) => layout.byId.get(id)?.seatClass ?? '?')
    .sort()
    .join(',');

/** The closest contiguous, gap-free block of free seats with the same size and seat classes. */
function bestAlternative(layout: Layout, taken: ReadonlySet<string>, selection: readonly string[]): string[] | null {
  const n = selection.length;
  const wanted = classKey(selection, layout);
  const chosen = selection.map((id) => layout.byId.get(id)).filter((s): s is GapSeat => !!s);
  const rowAt = chosen.reduce((a, s) => a + s.row, 0) / Math.max(chosen.length, 1);
  const colAt = chosen.reduce((a, s) => a + s.col, 0) / Math.max(chosen.length, 1);
  const selected = new Set(selection);

  let best: { ids: string[]; distance: number } | null = null;
  for (const [rowIdx, row] of layout.rows) {
    const cols = [...row.keys()].sort((a, b) => a - b);
    for (const start of cols) {
      const block: GapSeat[] = [];
      for (let c = start; block.length < n; c++) {
        const s = row.get(c);
        if (!s || taken.has(s.id)) break;
        block.push(s);
      }
      if (block.length < n) continue;
      const ids = block.map((s) => s.id);
      if (ids.every((id) => selected.has(id))) continue; // that IS the selection
      if (classKey(ids, layout) !== wanted) continue;
      if (createdGaps(layout, taken, ids).length > 0) continue;
      const center = block.reduce((a, s) => a + s.col, 0) / n;
      const distance = Math.abs(rowIdx - rowAt) * 1000 + Math.abs(center - colAt);
      if (!best || distance < best.distance) best = { ids, distance };
    }
  }
  return best?.ids ?? null;
}
