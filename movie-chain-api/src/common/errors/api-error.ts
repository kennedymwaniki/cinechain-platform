import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from './domain-errors';

/**
 * Constructors for the common domain errors. They return DomainErrors, not
 * HttpExceptions: the status is decided in one place, the exceptions filter.
 */
export const unauthorized = (code = 'unauthorized', message = 'Authentication required') =>
  new UnauthenticatedError(code, message);
export const forbidden = (code = 'forbidden', message = 'Not allowed') => new ForbiddenError(code, message);
/** Cross-tenant and not-yours resources are ALWAYS this — never 403 (convention 9). */
export const notFound = () => new NotFoundError();
export const badRequest = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new ValidationError(code, message, extra);
export const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new ConflictError(code, message, extra);
export const unprocessable = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new UnprocessableError(code, message, extra);
