import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createZodDto } from './zod-dto';

describe('createZodDto', () => {
  it('refuses a non-strict object schema at definition time', () => {
    expect(() => createZodDto(z.object({ a: z.string() }))).toThrow(/strict/);
    expect(() => createZodDto(z.object({ a: z.string() }).strict())).not.toThrow();
  });
});
