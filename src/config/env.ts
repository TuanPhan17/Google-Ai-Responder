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

  /**
   * Optional here, not gated by MOCK_MODE: response generation is a separate
   * concern from the Google Business Profile source, and this key isn't
   * needed until something actually calls the AI service.
   * getOpenAiApiKey() below is where a missing key becomes a loud failure.
   */
  OPENAI_API_KEY: emptyToUndefined(z.string().min(1).optional()),
  OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
  /**
   * Any OpenAI-compatible Responses API endpoint. Overriding this plus
   * OPENAI_MODEL and OPENAI_API_KEY is the entire "switch provider" story —
   * e.g. Groq's OpenAI-compatible host at https://api.groq.com/openai/v1.
   */
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  OPENAI_API_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(8).default(4),
  /**
   * Structured Outputs `strict: true` is a per-model capability, not a
   * universal one — on Groq, for instance, only openai/gpt-oss-20b and
   * openai/gpt-oss-120b support it. Set to false for a model/provider that
   * doesn't; Zod validation (with retry-on-failure) still applies either way,
   * so this only affects how often a bad generation needs a retry.
   */
  OPENAI_STRICT_SCHEMA: booleanish.default("true"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /**
   * Product-level kill switch, independent of `business_settings` and
   * independent of the deterministic auto-publish machinery in
   * src/policies/publishing-policy.ts. Defaults to true: every review
   * requires a human's explicit approval before anything reaches Google —
   * there is no automatic publish path in the shipped product. The
   * auto-publish logic still exists and is still exercised by its own tests;
   * this is the only thing standing between it and actually running. Set to
   * false to deliberately reverse that product decision.
   */
  REQUIRE_APPROVAL_FOR_ALL: booleanish.default("true"),

  /**
   * The `aud` claim Pub/Sub's push OIDC token must carry — set on the push
   * subscription when it's created (`--push-auth-token-audience`). Defaults to
   * this endpoint's own URL, which is what Pub/Sub uses when no audience is
   * explicitly configured on the subscription.
   */
  PUBSUB_AUDIENCE: emptyToUndefined(z.string().url().optional()),
  /**
   * If set, the push token's `email` claim must equal this exactly (the
   * service account the push subscription was configured to sign with). If
   * unset, verification still requires `.iam.gserviceaccount.com` and
   * `email_verified: true`, just not a specific account — set this once you
   * know which service account your subscription uses, for a tighter check.
   */
  PUBSUB_SERVICE_ACCOUNT_EMAIL: emptyToUndefined(z.string().email().optional()),
  /**
   * Skips OIDC verification entirely. For local testing only — there is no
   * real Pub/Sub push subscription to verify against until Google grants API
   * access, so this is what makes `scripts/simulate-pubsub-notification.ts`
   * possible. The route logs a warning on every request while this is true,
   * specifically so it cannot be silently left on.
   */
  PUBSUB_SKIP_VERIFICATION: booleanish.default("false"),
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

/** API key for the configured AI provider, narrowed to non-optional. Throws with setup instructions if unset. */
export function getOpenAiApiKey(): string {
  const key = getEnv().OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set. Add it to .env.local to use the AI response service.");
  }
  return key;
}

/** The expected `aud` claim on a Pub/Sub push OIDC token — PUBSUB_AUDIENCE if set, else this endpoint's own URL. */
export function getPubSubAudience(): string {
  const env = getEnv();
  return env.PUBSUB_AUDIENCE ?? `${env.APP_BASE_URL}/api/pubsub/reviews`;
}
