import { ParseUUIDPipe } from '@nestjs/common';
import { notFound } from '../errors/api-error';

/** For `:id` params. A malformed id is just another id that does not exist: 404, not 400. */
export const Uuid = new ParseUUIDPipe({ exceptionFactory: () => notFound() });
