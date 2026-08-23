import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";

beforeAll(() => {
  // Minimal env so getEnv() validates. No real credentials involved.
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-placeholder-value";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.ADMIN_PASSWORD = "console-password-example";
  process.env.MOCK_MODE = "true";
  resetEnvCache();
});

describe("token encryption", () => {
  it("round-trips a refresh token", async () => {
    const { encryptSecret, decryptSecret } = await import("@/auth/crypto");
    const token = "1//0gTESTrefreshTOKENvalue-not-real";

    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it("produces a different ciphertext each time", async () => {
    const { encryptSecret } = await import("@/auth/crypto");
    // A fresh nonce per encryption. Identical ciphertexts would leak that two
    // rows hold the same credential.
    expect(encryptSecret("same-value")).not.toBe(encryptSecret("same-value"));
  });

  it("never leaves the plaintext visible in the stored value", async () => {
    const { encryptSecret } = await import("@/auth/crypto");
    expect(encryptSecret("super-secret-token")).not.toContain("super-secret-token");
  });

  it("rejects a tampered ciphertext instead of returning garbage", async () => {
    const { encryptSecret, decryptSecret } = await import("@/auth/crypto");
    const encrypted = encryptSecret("authentic-value");

    const parts = encrypted.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString("base64url");

    // GCM authentication is what makes this a throw rather than silent
    // corruption we would then send to Google.
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("rejects an unknown format version", async () => {
    const { decryptSecret } = await import("@/auth/crypto");
    expect(() => decryptSecret("v9.aaaa.bbbb.cccc")).toThrow(/unknown format version/i);
  });
});

describe("constant-time comparison", () => {
  it("matches equal strings and rejects unequal ones of any length", async () => {
    const { safeEquals } = await import("@/auth/crypto");

    expect(safeEquals("abc123", "abc123")).toBe(true);
    expect(safeEquals("abc123", "abc124")).toBe(false);
    expect(safeEquals("short", "considerably-longer")).toBe(false);
    expect(safeEquals("", "")).toBe(true);
  });
});
