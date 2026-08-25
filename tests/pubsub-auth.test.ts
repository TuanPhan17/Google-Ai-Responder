import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";
import { UnauthorizedError } from "@/utils/errors";

const verifyIdToken = vi.fn();

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken(...args: unknown[]) {
      return verifyIdToken(...args);
    }
  },
}));

function ticket(payload: Record<string, unknown> | null) {
  return { getPayload: () => payload };
}

const SERVICE_ACCOUNT_EMAIL = "push-subscription@my-project.iam.gserviceaccount.com";

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-placeholder-value";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.ADMIN_PASSWORD = "console-password-example";
  process.env.MOCK_MODE = "true";
  process.env.APP_BASE_URL = "https://app.example.com";
  delete process.env.PUBSUB_AUDIENCE;
  delete process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL;
  resetEnvCache();

  verifyIdToken.mockReset();
});

describe("verifyPubSubPushToken", () => {
  it("rejects a request with no Authorization header", async () => {
    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");

    await expect(verifyPubSubPushToken(null)).rejects.toThrow(UnauthorizedError);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects a header that isn't a Bearer token", async () => {
    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");

    await expect(verifyPubSubPushToken("Basic dXNlcjpwYXNz")).rejects.toThrow(UnauthorizedError);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("passes this endpoint's own URL as the expected audience when PUBSUB_AUDIENCE is unset", async () => {
    verifyIdToken.mockResolvedValue(ticket({ email: SERVICE_ACCOUNT_EMAIL, email_verified: true }));

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    await verifyPubSubPushToken("Bearer good-token");

    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "good-token",
      audience: "https://app.example.com/api/pubsub/reviews",
    });
  });

  it("uses PUBSUB_AUDIENCE when it's set", async () => {
    process.env.PUBSUB_AUDIENCE = "https://custom.example.com/hooks/pubsub";
    resetEnvCache();
    verifyIdToken.mockResolvedValue(ticket({ email: SERVICE_ACCOUNT_EMAIL, email_verified: true }));

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    await verifyPubSubPushToken("Bearer good-token");

    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "good-token",
      audience: "https://custom.example.com/hooks/pubsub",
    });
  });

  it("rejects when the underlying signature/audience/expiry check throws", async () => {
    verifyIdToken.mockRejectedValue(new Error("Token used too late"));

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    await expect(verifyPubSubPushToken("Bearer expired-token")).rejects.toThrow(UnauthorizedError);
  });

  it("rejects a token with no email claim", async () => {
    verifyIdToken.mockResolvedValue(ticket({ email_verified: true }));

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    await expect(verifyPubSubPushToken("Bearer token")).rejects.toThrow(UnauthorizedError);
  });

  it("rejects a token whose email is not verified", async () => {
    verifyIdToken.mockResolvedValue(ticket({ email: SERVICE_ACCOUNT_EMAIL, email_verified: false }));

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    await expect(verifyPubSubPushToken("Bearer token")).rejects.toThrow(UnauthorizedError);
  });

  it("rejects a verified token that isn't a service account", async () => {
    verifyIdToken.mockResolvedValue(ticket({ email: "someone@gmail.com", email_verified: true }));

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    await expect(verifyPubSubPushToken("Bearer token")).rejects.toThrow(UnauthorizedError);
  });

  it("accepts any verified service-account token when PUBSUB_SERVICE_ACCOUNT_EMAIL is unset", async () => {
    verifyIdToken.mockResolvedValue(ticket({ email: SERVICE_ACCOUNT_EMAIL, email_verified: true }));

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    const result = await verifyPubSubPushToken("Bearer token");

    expect(result).toEqual({ email: SERVICE_ACCOUNT_EMAIL });
  });

  it("rejects a service-account token that doesn't match PUBSUB_SERVICE_ACCOUNT_EMAIL when it's configured", async () => {
    process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL = SERVICE_ACCOUNT_EMAIL;
    resetEnvCache();
    verifyIdToken.mockResolvedValue(
      ticket({ email: "someone-else@other-project.iam.gserviceaccount.com", email_verified: true }),
    );

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    await expect(verifyPubSubPushToken("Bearer token")).rejects.toThrow(UnauthorizedError);
  });

  it("accepts a token whose service account matches PUBSUB_SERVICE_ACCOUNT_EMAIL exactly", async () => {
    process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL = SERVICE_ACCOUNT_EMAIL;
    resetEnvCache();
    verifyIdToken.mockResolvedValue(ticket({ email: SERVICE_ACCOUNT_EMAIL, email_verified: true }));

    const { verifyPubSubPushToken } = await import("@/google/pubsub-auth");
    const result = await verifyPubSubPushToken("Bearer token");

    expect(result).toEqual({ email: SERVICE_ACCOUNT_EMAIL });
  });
});
