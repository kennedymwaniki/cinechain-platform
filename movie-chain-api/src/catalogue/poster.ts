import { createHash } from 'node:crypto';

export const MAX_POSTER_BYTES = 2 * 1024 * 1024;

const SIGNATURES: { type: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
];

/**
 * Decides the type from the BYTES, never from the client's Content-Type or
 * file name: those are attacker-controlled. Anything that is not a JPEG, PNG
 * or WebP is refused.
 */
export function sniffImage(buf: Buffer): { type: string; ext: string } | null {
  const hit = SIGNATURES.find((s) => buf.length >= 12 && s.test(buf));
  return hit ? { type: hit.type, ext: hit.ext } : null;
}

/** Content-addressed name, so a new poster gets a new URL and caches never serve the old one. */
export function posterName(buf: Buffer, ext: string): string {
  return `poster-${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`;
}
