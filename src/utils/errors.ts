/**
 * Error taxonomy.
 *
 * The important distinction for this application is *retryable* vs *terminal*.
 * A 429 from Google should back off and try again; a 400 should not, because
 * retrying an invalid request forever burns quota we do not have much of.
 */

export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;

  constructor(
    message: string,
    options: { code: string; retryable?: boolean; context?: Record<string, unknown>; cause?: unknown } ,
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.context = options.context ?? {};
  }
}

/** A request to a Google API failed. */
export class GoogleApiError extends AppError {
  readonly status: number;
  /** Seconds Google asked us to wait, from a Retry-After header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: {
      status: number;
      retryAfterSeconds?: number;
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, {
      code: "GOOGLE_API_ERROR",
      // 408/429 and 5xx are transient. Everything else is a bug in our request,
      // a permissions problem, or a quota approval that has not landed yet.
      retryable: options.status === 408 || options.status === 429 || options.status >= 500,
      context: { ...options.context, status: options.status },
      cause: options.cause,
    });
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The stored Google credential is missing, revoked, or unusable. */
export class GoogleAuthError extends AppError {
  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message, { code: "GOOGLE_AUTH_ERROR", retryable: false, context, cause });
  }
}

/** A Google or OpenAI response did not match the schema we expect. */
export class SchemaValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message, { code: "SCHEMA_VALIDATION_ERROR", retryable: false, context, cause });
  }
}

/** A request to the OpenAI API failed. */
export class OpenAiApiError extends AppError {
  readonly status: number;

  constructor(
    message: string,
    options: { status: number; context?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, {
      code: "OPENAI_API_ERROR",
      // Same shape as GoogleApiError: 408/429 and 5xx are worth a retry, a 4xx
      // otherwise means the request itself is wrong and retrying won't fix it.
      retryable: options.status === 408 || options.status === 429 || options.status >= 500,
      context: { ...options.context, status: options.status },
      cause: options.cause,
    });
    this.status = options.status;
  }
}

/**
 * The model declined to produce structured output (a Structured Outputs
 * `refusal`, not a malformed one). Not retryable: re-sending the same review
 * is likely to be refused again, and retrying blindly would just burn quota.
 */
export class OpenAiRefusalError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: "OPENAI_REFUSAL", retryable: false, context });
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message, { code: "DATABASE_ERROR", retryable: false, context, cause });
  }
}

/** Caller supplied bad input to an API route. */
export class BadRequestError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: "BAD_REQUEST", retryable: false, context });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Sign in to continue.") {
    super(message, { code: "UNAUTHORIZED", retryable: false });
  }
}

/**
 * The row didn't match the caller's expected state by the time the write
 * landed — someone else's request (or a double-submit of this one) got there
 * first. Not retryable in the back-off sense: retrying the same request
 * without re-reading the row will just conflict again.
 */
export class ConflictError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: "CONFLICT", retryable: false, context });
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  // Undici surfaces connection resets and DNS failures as TypeError with a cause.
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

/** A message safe to return to the browser: never includes context or causes. */
export function toPublicMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return "Something went wrong. Check the server logs for details.";
}

export function toHttpStatus(error: unknown): number {
  if (error instanceof UnauthorizedError) return 401;
  if (error instanceof BadRequestError) return 400;
  if (error instanceof ConflictError) return 409;
  if (error instanceof GoogleAuthError) return 409;
  if (error instanceof GoogleApiError) return error.status >= 500 ? 502 : error.status;
  if (error instanceof OpenAiApiError) return error.status >= 500 ? 502 : error.status;
  return 500;
}
