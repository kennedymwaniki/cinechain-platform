import { randomInt } from 'node:crypto';

// Crockford-style: no 0/O, 1/I/L, U — read aloud at a counter without ambiguity.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A booking reference: the tenant's prefix and 6 random characters
 * (~29 bits), e.g. NYT-7KQ3XP. Random, not sequential — though a reference
 * alone never retrieves a booking anyway (FR-73). Unique per tenant;
 * the caller retries on the rare collision.
 */
export function newReference(prefix: string): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${s}`;
}

/** The chain's configured prefix, or its slug's first three LETTERS (a hyphen would make references ambiguous). */
export function prefixFor(configured: string | null, slug: string): string {
  if (configured) return configured;
  const letters = slug.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase();
  return letters.length >= 2 ? letters : 'BKG';
}
