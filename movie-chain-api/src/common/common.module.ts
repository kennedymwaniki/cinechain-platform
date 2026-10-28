import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { ZodValidationPipe } from './validation/zod-validation.pipe';

/** API conventions every endpoint inherits: one error model, Zod validation, idempotency. */
@Global()
@Module({
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    IdempotencyInterceptor,
  ],
  exports: [IdempotencyInterceptor],
})
export class CommonModule {}
