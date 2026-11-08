// Application error with a stable code, safe user-facing message and HTTP status.
// API responses: { error: { code, message, fieldErrors?, details? }, correlation_id }.

export type ErrorCode =
  | 'unauthenticated' | 'forbidden' | 'not_found' | 'validation_failed' | 'conflict'
  | 'version_conflict' | 'idempotency_conflict' | 'rate_limited' | 'csrf_failed'
  | 'provider_not_configured' | 'provider_error' | 'invalid_state' | 'payload_too_large'
  | 'unsupported_media' | 'budget_exhausted' | 'dispatch_disabled' | 'mfa_required' | 'step_up_required' | 'entitlement_required' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401, forbidden: 403, not_found: 404, validation_failed: 422, conflict: 409,
  version_conflict: 409, idempotency_conflict: 409, rate_limited: 429, csrf_failed: 403,
  provider_not_configured: 412, provider_error: 502, invalid_state: 409, payload_too_large: 413,
  unsupported_media: 415, budget_exhausted: 402, dispatch_disabled: 503, mfa_required: 403, step_up_required: 401, entitlement_required: 402, internal: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do that') => new AppError('forbidden', msg);
export const invalidState = (msg: string, details?: Record<string, unknown>) => new AppError('invalid_state', msg, undefined, details);
