import type { SeatClass } from '../db/schema/venue';

export interface LayoutSpec {
  rows: number;
  seatsPerRow: number;
  defaultClass: SeatClass;
  /** Seat numbers after which an aisle (one empty column) appears, e.g. [4, 16]. */
  aisleAfter?: number[] | undefined;
  /** Whole rows of a different class, e.g. [{ rows: ['K','L'], seatClass: 'vip' }]. */
  rowClasses?: { rows: string[]; seatClass: SeatClass }[] | undefined;
  /** Individual seats, e.g. [{ seat: 'A1', seatClass: 'accessible' }]. */
  seatClasses?: { seat: string; seatClass: SeatClass }[] | undefined;
}

export interface GeneratedSeat {
  rowLabel: string;
  seatNumber: number;
  rowIndex: number;
  colIndex: number;
  seatClass: SeatClass;
}

export const MAX_ROWS = 52;
export const MAX_SEATS_PER_ROW = 60;

export class LayoutError extends Error {}

/** 0 → A, 25 → Z, 26 → AA, 27 → AB … (spreadsheet-style). */
export function rowLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new LayoutError('row index must be a non-negative integer');
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    label = String.fromCharCode(65 + r) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/**
 * Pure: (spec) → seats. Row A is the front. Seats are numbered 1..n left to
 * right; `colIndex` includes aisle gaps, so the seat map can be drawn from
 * (rowIndex, colIndex) alone.
 */
export function generateLayout(spec: LayoutSpec): GeneratedSeat[] {
  const { rows, seatsPerRow } = spec;
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) throw new LayoutError(`rows must be 1–${MAX_ROWS}`);
  if (!Number.isInteger(seatsPerRow) || seatsPerRow < 1 || seatsPerRow > MAX_SEATS_PER_ROW)
    throw new LayoutError(`seatsPerRow must be 1–${MAX_SEATS_PER_ROW}`);

  const aisles = [...new Set(spec.aisleAfter ?? [])].sort((a, b) => a - b);
  if (aisles.some((a) => !Number.isInteger(a) || a < 1 || a >= seatsPerRow))
    throw new LayoutError('aisleAfter entries must be seat numbers between 1 and seatsPerRow - 1');

  const labels = Array.from({ length: rows }, (_, i) => rowLabel(i));
  const labelSet = new Set(labels);
  const rowClass = new Map<string, SeatClass>();
  for (const rc of spec.rowClasses ?? [])
    for (const r of rc.rows) {
      if (!labelSet.has(r)) throw new LayoutError(`row ${r} is not in this layout`);
      rowClass.set(r, rc.seatClass);
    }
  const seatClass = new Map<string, SeatClass>();
  for (const sc of spec.seatClasses ?? []) {
    const m = /^([A-Z]{1,2})(\d{1,3})$/.exec(sc.seat);
    if (!m || !labelSet.has(m[1]!) || Number(m[2]) < 1 || Number(m[2]) > seatsPerRow)
      throw new LayoutError(`seat ${sc.seat} is not in this layout`);
    seatClass.set(sc.seat, sc.seatClass);
  }

  const seats: GeneratedSeat[] = [];
  labels.forEach((label, rowIndex) => {
    for (let n = 1; n <= seatsPerRow; n++) {
      const gapsBefore = aisles.filter((a) => a < n).length;
      seats.push({
        rowLabel: label,
        seatNumber: n,
        rowIndex,
        colIndex: n - 1 + gapsBefore,
        seatClass: seatClass.get(`${label}${n}`) ?? rowClass.get(label) ?? spec.defaultClass,
      });
    }
  });
  return seats;
}
