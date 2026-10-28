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

/** Code → status. The single table every error response comes from. */
export const STATUS_BY_CLASS = new Map<abstract new (...args: never[]) => DomainError, number>([
  [ValidationError, 400],
  [UnauthenticatedError, 401],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [TenantMismatchError, 404],
  [ConflictError, 409],
  [UnprocessableError, 422],
]);
