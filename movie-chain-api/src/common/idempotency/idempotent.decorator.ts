import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './idempotency.interceptor';

export const IDEMPOTENT = 'cinechain:idempotent';

/**
 * Requires an `Idempotency-Key` header. A replay with the same key and the
 * same request returns the stored response WITHOUT running the handler; the
 * same key with a different request is a 422. Keyed (tenant_id, key, endpoint).
 */
export const Idempotent = () =>
  applyDecorators(
    SetMetadata(IDEMPOTENT, true),
    ApiHeader({ name: 'Idempotency-Key', required: true }),
    UseInterceptors(IdempotencyInterceptor),
  );
