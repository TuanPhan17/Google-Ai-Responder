import { z } from "zod";

/**
 * Server-only environment configuration.
 *
 * Loaded lazily and validated once. Importing this module from a client
 * component is a bug, so we fail loudly rather than shipping secrets to a
 * browser bundle.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "src/config/env.ts was imported into client code. This module reads secrets and must stay on the server.",
  );
}

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/** .env.example ships optional keys as `KEY=`, which reads as "" — treat that as unset. */
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

/** 32 raw bytes, base64-encoded. Generate with `npm run keys:generate`. */
const base64Key32 = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, "base64").length === 32;
    } catch {
      return false;
    }
  },
  { message: "must be 32 bytes encoded as base64 (run `npm run keys:generate`)" },
);

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** Public origin of this app. Used to build the OAuth redirect URI. */
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  /**
   * When true, no request ever leaves the machine for Google. Fixtures stand in
   * for the Business Profile API so the pipeline can be exercised before
   * Google grants API access (which takes 1-2 weeks).
   */
  MOCK_MODE: booleanish.default("true"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  /** Direct Postgres connection string, used only by the migration runner. */
  SUPABASE_DB_URL: z.string().min(1).optional(),

  /** AES-256-GCM key protecting refresh tokens at rest. */
  TOKEN_ENCRYPTION_KEY: base64Key32,

  /** HMAC key for the admin session cookie and the OAuth `state` parameter. */
  SESSION_SECRET: z.string().min(32),

  /** Single shared password gating the admin console in Phase 1. */
  ADMIN_PASSWORD: z.string().min(12),

  GOOGLE_CLIENT_ID: emptyToUndefined(z.string().min(1).optional()),
  GOOGLE_CLIENT_SECRET: emptyToUndefined(z.string().min(1).optional()),
  GOOGLE_OAUTH_REDIRECT_URI: emptyToUndefined(z.string().url().optional()),

  GOOGLE_API_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(20_000),
  GOOGLE_API_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(8).default(4),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const envSchema = baseSchema.superRefine((value, ctx) => {
  // Google credentials are only mandatory once we actually talk to Google.
  // This is what lets a new contributor run the app on day one.
  if (value.MOCK_MODE) return;

  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
  ] as const;

  for (const key of required) {
    if (!value[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when MOCK_MODE is false`,
      });
    }
  }
});

export type Env = z.infer<typeof baseSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Print the failing variable names only. Never print the values —
    // a malformed secret is still a secret.
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test helper: forces the next getEnv() call to re-read process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export function isMockMode(): boolean {
  return getEnv().MOCK_MODE;
}

/**
 * Google credentials, narrowed to non-optional. Only call this from code paths
 * that have already established we are not in mock mode.
 */
export function getGoogleOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI) {
    throw new Error(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI, or run with MOCK_MODE=true.",
    );
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  };
}
