import { describe, expect, it } from "vitest";

import { redact } from "@/utils/logger";

/**
 * The logger is a security control, not a convenience. These tests exist so
 * that a future refactor cannot quietly start writing credentials to stdout.
 */
describe("log redaction", () => {
  it("removes anything under a secret-shaped key", () => {
    const output = redact({
      refresh_token: "1//0gREALtoken",
      access_token: "ya29.REALtoken",
      client_secret: "GOCSPX-abc",
      authorization: "Bearer ya29.abc",
      password: "hunter2",
      safeField: "kept",
    }) as Record<string, unknown>;

    expect(output["refresh_token"]).toBe("[redacted]");
    expect(output["access_token"]).toBe("[redacted]");
    expect(output["client_secret"]).toBe("[redacted]");
    expect(output["authorization"]).toBe("[redacted]");
    expect(output["password"]).toBe("[redacted]");
    expect(output["safeField"]).toBe("kept");
  });

  it("catches a Google token even under an innocuous key name", () => {
    const output = redact({ value: "ya29.a0AfB_byC" }) as Record<string, unknown>;
    expect(output["value"]).toBe("[redacted]");
  });

  it("replaces customer review text with a length instead of the words", () => {
    const output = redact({ comment: "They fixed my brakes in two hours" }) as Record<string, unknown>;

    expect(output["comment"]).toBe("[33 chars]");
    expect(String(output["comment"])).not.toContain("brakes");
  });

  it("masks the local part of an email address", () => {
    const output = redact({ contact: "owner@example.com" }) as Record<string, unknown>;

    expect(output["contact"]).toBe("o****@example.com");
  });

  it("redacts a whole subtree whose key is secret-shaped", () => {
    // `tokens` matches the secret pattern, so the entire object is replaced
    // rather than walked. That is deliberately blunt: it means a credential
    // added to that object in future is covered without anyone remembering to
    // update the redaction list.
    const output = redact({ connection: { tokens: { refresh_token: "1//secret" } } }) as {
      connection: { tokens: unknown };
    };

    expect(output.connection.tokens).toBe("[redacted]");
    expect(JSON.stringify(output)).not.toContain("1//secret");
  });

  it("redacts a secret nested several levels under ordinary keys", () => {
    const output = redact({ google: { stored: { account: { refresh_token: "1//secret" } } } }) as {
      google: { stored: { account: { refresh_token: string } } };
    };

    expect(output.google.stored.account.refresh_token).toBe("[redacted]");
    expect(JSON.stringify(output)).not.toContain("1//secret");
  });
});
