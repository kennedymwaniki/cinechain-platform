import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { badRequest } from '../errors/api-error';

/**
 * Global pipe (registered in CommonModule). Validates any parameter whose
 * declared type is a createZodDto class, and leaves everything else alone.
 * `nestjs-zod` does not support NestJS 12, so this is the in-house version.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = (metadata.metatype as { schema?: z.ZodType } | undefined)?.schema;
    if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') return value;
    const r = schema.safeParse(value);
    if (!r.success)
      throw badRequest('validation_failed', 'Request validation failed', {
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
      });
    return r.data;
  }
}

/** For values that are not DTO-typed parameters (query strings, passport bodies). */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw badRequest('validation_failed', 'Request validation failed', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    });
  return r.data;
}
