import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { getEnv, resetEnvCache } from "@/config/env";

function setBaseEnv() {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-placeholder-value";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.ADMIN_PASSWORD = "console-password-example";
  process.env.MOCK_MODE = "true";
}

beforeEach(() => {
  setBaseEnv();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_STRICT_SCHEMA;
  resetEnvCache();
});

describe("Google OAuth env vars", () => {
  it("treats empty strings as unset, matching .env.example's MOCK_MODE keys", () => {
    process.env.GOOGLE_CLIENT_ID = "";
    process.env.GOOGLE_CLIENT_SECRET = "";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "";

    const env = getEnv();

    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(env.GOOGLE_OAUTH_REDIRECT_URI).toBeUndefined();
  });

  it("still accepts real values when present", () => {
    process.env.GOOGLE_CLIENT_ID = "client-id-value";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret-value";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://example.com/oauth/callback";

    const env = getEnv();

    expect(env.GOOGLE_CLIENT_ID).toBe("client-id-value");
    expect(env.GOOGLE_CLIENT_SECRET).toBe("client-secret-value");
    expect(env.GOOGLE_OAUTH_REDIRECT_URI).toBe("https://example.com/oauth/callback");
  });

  it("still requires the Google vars once MOCK_MODE is false, even as empty strings", () => {
    process.env.MOCK_MODE = "false";
    process.env.GOOGLE_CLIENT_ID = "";
    process.env.GOOGLE_CLIENT_SECRET = "";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "";

    expect(() => getEnv()).toThrow(/GOOGLE_CLIENT_ID is required/);
  });
});

describe("AI provider env vars", () => {
  it("defaults to OpenAI's base URL, model, and strict mode on", () => {
    const env = getEnv();

    expect(env.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
    expect(env.OPENAI_MODEL).toBe("gpt-4o-mini");
    expect(env.OPENAI_STRICT_SCHEMA).toBe(true);
  });

  it("switches provider entirely through env vars, e.g. to Groq", () => {
    process.env.OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
    process.env.OPENAI_MODEL = "openai/gpt-oss-20b";
    process.env.OPENAI_API_KEY = "gsk_test-key-not-real";

    const env = getEnv();

    expect(env.OPENAI_BASE_URL).toBe("https://api.groq.com/openai/v1");
    expect(env.OPENAI_MODEL).toBe("openai/gpt-oss-20b");
    expect(env.OPENAI_API_KEY).toBe("gsk_test-key-not-real");
  });

  it("parses OPENAI_STRICT_SCHEMA=false, for models/providers without strict-mode support", () => {
    process.env.OPENAI_STRICT_SCHEMA = "false";

    expect(getEnv().OPENAI_STRICT_SCHEMA).toBe(false);
  });

  it("rejects a malformed OPENAI_BASE_URL", () => {
    process.env.OPENAI_BASE_URL = "not-a-url";

    expect(() => getEnv()).toThrow(/OPENAI_BASE_URL/);
  });
});
