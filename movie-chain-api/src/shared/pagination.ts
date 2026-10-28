import { badRequest } from '../common/errors/api-error';

/**
 * Opaque keyset cursors. Offset pagination degrades badly on large tables
 * (seat_lock reaches tens of millions of rows) and skips or repeats rows when
 * data changes between pages. A cursor is the sort key of the last row.
 *
 * Opaque means clients must not build or edit them. Tampering gains nothing
 * anyway: every read is still scoped by RLS.
 */
export type CursorValue = string | number;

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export function clampLimit(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify({ v: 1, k: values })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, arity: number): CursorValue[] | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; k?: unknown };
    if (
      parsed.v === 1 &&
      Array.isArray(parsed.k) &&
      parsed.k.length === arity &&
      parsed.k.every((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))
    )
      return parsed.k as CursorValue[];
  } catch {
    // fall through
  }
  throw badRequest('invalid_cursor', 'The pagination cursor is not valid');
}

/** Fetch `limit + 1` rows, then call this: it trims and builds the next cursor. */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => CursorValue[]): Page<T> {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, next_cursor: more && last ? encodeCursor(keyOf(last)) : null };
}
