/**
 * Domain errors. Services throw these; the global exceptions filter maps each
 * code to its HTTP status (PRD §8.4). No controller constructs a status.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {}
export class UnauthenticatedError extends DomainError {}
export class ForbiddenError extends DomainError {}
export class NotFoundError extends DomainError {
  constructor() {
    super('not_found', 'Resource not found');
  }
}
export class ConflictError extends DomainError {}
export class UnprocessableError extends DomainError {}
/** The customer paid and did not get what they paid for; the body says what happened to the money. */
export class PaymentRequiredError extends DomainError {}

/**
 * A request reached for another tenant's resource. Rendered as a 404 whose
 * body is BYTE-IDENTICAL to a genuine not-found (a 403, or any difference at
 * all, would confirm the resource exists), while the filter records a
 * security event internally.
 */
export class TenantMismatchError extends DomainError {
  constructor(readonly detail: Record<string, unknown> = {}) {
    super('not_found', 'Resource not found');
  }
}

/** A dependency is saturated or down; the client may retry. */
export class UnavailableError extends DomainError {}

/** Too many attempts: the enumeration-sensitive endpoints are rate-limited. */
export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterS: number) {
    super('rate_limited', 'Too many requests; try again shortly', { retry_after_s: retryAfterS });
  }
}

/** Code → status. The single table every error response comes from. */
export const STATUS_BY_CLASS = new Map<abstract new (...args: never[]) => DomainError, number>([
  [ValidationError, 400],
  [UnauthenticatedError, 401],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [TenantMismatchError, 404],
  [ConflictError, 409],
  [UnprocessableError, 422],
  [PaymentRequiredError, 402],
  [RateLimitedError, 429],
  [UnavailableError, 503],
]);
