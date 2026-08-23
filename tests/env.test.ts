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
