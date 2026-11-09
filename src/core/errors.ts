/**
 * Typed error model shared by every layer.
 *
 * Rules (roadmap 3.3 / 18):
 * - `message` is safe to show and to log.
 * - `details` must already be sanitized by the thrower (never a raw URI/token).
 * - `retryable` drives the retry policy; destructive operations are never
 *   auto-retried just because the error is retryable.
 */

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CONFIG'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'PRECONDITION_FAILED'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFLICT'
  | 'LOCKED'
  | 'PATH_UNSAFE'
  | 'IO_ERROR'
  | 'STORAGE_ERROR'
  | 'FORMAT_UNSUPPORTED'
  | 'OPERATION_FAILED'
  | 'OPERATION_CANCELLED'
  | 'INTERRUPTED'
  | 'INTERNAL_ERROR';

export class UdmtError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'UdmtError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details) this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isUdmtError(value: unknown): value is UdmtError {
  return value instanceof UdmtError;
}

export function toUdmtError(value: unknown, fallbackCode: ErrorCode = 'INTERNAL_ERROR'): UdmtError {
  if (isUdmtError(value)) return value;
  if (value instanceof Error) {
    return new UdmtError(fallbackCode, value.message, { cause: value });
  }
  return new UdmtError(fallbackCode, String(value));
}

/** Maps driver/network failures onto the shared error model. */
export function mapDriverError(err: unknown, context: string): UdmtError {
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code ?? '';
  const message = sanitizeErrorMessage(raw);

  if (/password|authentication|auth failed|access denied|28P01|ER_ACCESS_DENIED/i.test(message)) {
    return new UdmtError('AUTH_FAILED', `${context}: authentication failed. ${message}`, { cause: err });
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout|connect ECONN|getaddrinfo/i.test(`${code} ${message}`)) {
    return new UdmtError('CONNECTION_FAILED', `${context}: cannot reach the server. ${message}`, {
      retryable: true,
      cause: err,
    });
  }
  if (/SQLITE_CANTOPEN|ENOENT|EACCES|EPERM/i.test(`${code} ${message}`)) {
    return new UdmtError('IO_ERROR', `${context}: ${message}`, { cause: err });
  }
  return new UdmtError('OPERATION_FAILED', `${context}: ${message}`, { cause: err });
}

const SECRET_PATTERNS: RegExp[] = [
  /(mongodb(?:\+srv)?:\/\/[^\s:@/]+):([^\s@/]+)@/gi,
  /(postgres(?:ql)?:\/\/[^\s:@/]+):([^\s@/]+)@/gi,
  /(mysql:\/\/[^\s:@/]+):([^\s@/]+)@/gi,
  /((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;&"']+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

export function sanitizeErrorMessage(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '$1***');
  return out;
}
