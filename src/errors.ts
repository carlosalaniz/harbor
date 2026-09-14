// Stable error codes (TDD section 7) with HTTP mapping and CLI exit categories.

export type ErrorCode =
  | 'INVALID_PACKAGE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'NAME_CONFLICT'
  | 'PORT_CONFLICT'
  | 'STATE_CHANGED'
  | 'PLAN_EXPIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OWNERSHIP_CONFLICT'
  | 'DATA_MISSING'
  | 'SECRET_MISSING'
  | 'READINESS_TIMEOUT'
  | 'DOCKER_UNAVAILABLE'
  | 'STATE_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'MALFORMED_JSON'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INVALID_STATE'
  | 'BUSY'
  | 'OPERATION_FAILED'
  | 'INTERNAL';

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_PACKAGE: 422,
  UNSUPPORTED_CAPABILITY: 422,
  INVALID_REQUEST: 422,
  MALFORMED_JSON: 400,
  NAME_CONFLICT: 409,
  PORT_CONFLICT: 409,
  STATE_CHANGED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  OWNERSHIP_CONFLICT: 409,
  INVALID_STATE: 409,
  BUSY: 409,
  DATA_MISSING: 409,
  SECRET_MISSING: 409,
  PLAN_EXPIRED: 410,
  READINESS_TIMEOUT: 409,
  DOCKER_UNAVAILABLE: 503,
  STATE_UNAVAILABLE: 503,
  UNAUTHENTICATED: 401,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  OPERATION_FAILED: 500,
  INTERNAL: 500,
};

// CLI exit categories: 0 success, 1 operation failure, 2 invalid request,
// 3 conflict/action required, 4 dependency unavailable, 5 authentication.
const EXIT_CODE: Record<ErrorCode, number> = {
  INVALID_PACKAGE: 2,
  UNSUPPORTED_CAPABILITY: 2,
  INVALID_REQUEST: 2,
  MALFORMED_JSON: 2,
  NOT_FOUND: 2,
  NAME_CONFLICT: 3,
  PORT_CONFLICT: 3,
  STATE_CHANGED: 3,
  IDEMPOTENCY_CONFLICT: 3,
  OWNERSHIP_CONFLICT: 3,
  INVALID_STATE: 3,
  BUSY: 3,
  DATA_MISSING: 3,
  SECRET_MISSING: 3,
  PLAN_EXPIRED: 3,
  READINESS_TIMEOUT: 1,
  OPERATION_FAILED: 1,
  DOCKER_UNAVAILABLE: 4,
  STATE_UNAVAILABLE: 4,
  UNAUTHENTICATED: 5,
  FORBIDDEN_ORIGIN: 5,
  RATE_LIMITED: 5,
  INTERNAL: 1,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; nextAction: string; operationId?: string; details?: string[] };
}

export class HarborError extends Error {
  readonly code: ErrorCode;
  readonly nextAction: string;
  readonly details: string[];
  readonly operationId: string | undefined;

  constructor(code: ErrorCode, message: string, opts: { nextAction?: string; details?: string[]; operationId?: string } = {}) {
    super(message);
    this.name = 'HarborError';
    this.code = code;
    this.nextAction = opts.nextAction ?? defaultNextAction(code);
    this.details = opts.details ?? [];
    this.operationId = opts.operationId;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  get exitCode(): number {
    return EXIT_CODE[this.code];
  }

  toBody(): ErrorBody {
    const error: ErrorBody['error'] = { code: this.code, message: this.message, nextAction: this.nextAction };
    if (this.operationId) error.operationId = this.operationId;
    if (this.details.length) error.details = this.details;
    return { error };
  }

  static is(err: unknown, code?: ErrorCode): err is HarborError {
    return err instanceof HarborError && (code === undefined || err.code === code);
  }
}

function defaultNextAction(code: ErrorCode): string {
  switch (code) {
    case 'INVALID_PACKAGE': return 'Fix the package files; nothing was changed.';
    case 'UNSUPPORTED_CAPABILITY': return 'Remove the unsupported Compose/manifest feature from the package.';
    case 'NAME_CONFLICT': return 'Choose a different instance name and create a new plan.';
    case 'PORT_CONFLICT': return 'Free the port or wait for the other operation, then create a new plan.';
    case 'STATE_CHANGED': return 'The instance changed since planning; create a new plan.';
    case 'PLAN_EXPIRED': return 'The plan expired; create a new plan and submit it.';
    case 'IDEMPOTENCY_CONFLICT': return 'Use a new idempotency key for a different request.';
    case 'OWNERSHIP_CONFLICT': return 'A resource with this name is not owned by this installation; inspect it manually.';
    case 'DATA_MISSING': return 'Retained data is missing or replaced; investigate before continuing. Nothing was recreated.';
    case 'SECRET_MISSING': return 'A retained secret file is missing; restore it from your own backup. Nothing was regenerated.';
    case 'READINESS_TIMEOUT': return 'Inspect the instance; resources were kept. Use remove to clean up.';
    case 'DOCKER_UNAVAILABLE': return 'Start Docker Engine and retry.';
    case 'STATE_UNAVAILABLE': return 'Repair the state directory; Harbor never replaces a corrupt database.';
    case 'MALFORMED_JSON': return 'Send a valid JSON body.';
    case 'INVALID_REQUEST': return 'Correct the request and retry.';
    case 'UNAUTHENTICATED': return 'Log in and retry.';
    case 'FORBIDDEN_ORIGIN': return 'Use the configured local origin.';
    case 'NOT_FOUND': return 'Check the identifier.';
    case 'RATE_LIMITED': return 'Wait and retry.';
    case 'INVALID_STATE': return 'The instance is not in a state that allows this operation.';
    case 'BUSY': return 'Wait for the running operation to finish.';
    case 'OPERATION_FAILED': return 'Inspect the operation events and the instance.';
    case 'INTERNAL': return 'Check the daemon log.';
  }
}
