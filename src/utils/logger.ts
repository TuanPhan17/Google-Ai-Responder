/**
 * Structured logger with hard-coded redaction.
 *
 * Two rules drive the design:
 *  1. Secrets must never reach a log sink, even accidentally, so redaction
 *     happens inside the logger rather than at each call site. A call site can
 *     forget; the logger cannot.
 *  2. Customer text is business data, not debugging data. Review bodies and
 *     reviewer names are truncated/masked by default.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** Keys whose values are replaced wholesale, matched case-insensitively. */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|credential|authorization|apikey|api_key|client_secret|refresh|cookie|signature)/i;

/** Keys holding customer text that gets truncated rather than removed. */
const CUSTOMER_TEXT_KEY_PATTERN = /(comment|reviewText|reply|displayName|reviewerName)/i;

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_ARRAY = 25;
const MAX_TEXT = 80;

function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${value.slice(at + 1)}`;
}

function truncate(value: string): string {
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}… (+${value.length - MAX_TEXT} chars)`;
}

function looksLikeBearerToken(value: string): boolean {
  // ya29.* is Google's access-token prefix; 1//* is a refresh token.
  return /^ya29\./.test(value) || /^1\/\//.test(value) || /^Bearer\s+/i.test(value);
}

export function redact(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (depth > MAX_DEPTH) return "[max depth]";

  if (typeof input === "string") {
    if (looksLikeBearerToken(input)) return REDACTED;
    if (input.includes("@") && !input.includes(" ")) return maskEmail(input);
    return truncate(input);
  }

  if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
    return input;
  }

  if (input instanceof Error) {
    return { name: input.name, message: truncate(input.message) };
  }

  if (Array.isArray(input)) {
    const head = input.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
    return input.length > MAX_ARRAY ? [...head, `[+${input.length - MAX_ARRAY} more]`] : head;
  }

  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      if (CUSTOMER_TEXT_KEY_PATTERN.test(key) && typeof value === "string") {
        out[key] = `[${value.length} chars]`;
        continue;
      }
      out[key] = redact(value, depth + 1);
    }
    return out;
  }

  return "[unloggable]";
}

function currentLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ? { context: redact(context) as Record<string, unknown> } : {}),
  };

  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
  /** Namespaced child logger, e.g. `logger.child("google.reviews")`. */
  child(scope: string) {
    return {
      debug: (m: string, c?: Record<string, unknown>) => emit("debug", `${scope}: ${m}`, c),
      info: (m: string, c?: Record<string, unknown>) => emit("info", `${scope}: ${m}`, c),
      warn: (m: string, c?: Record<string, unknown>) => emit("warn", `${scope}: ${m}`, c),
      error: (m: string, c?: Record<string, unknown>) => emit("error", `${scope}: ${m}`, c),
    };
  },
};
