import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

import { getEnv } from "@/config/env";

/**
 * Refresh tokens are long-lived Google credentials. If someone gets a read-only
 * copy of the database — a leaked backup, an over-broad support query — the
 * tokens must be useless without the application key. So they are encrypted
 * with AES-256-GCM before they ever reach Postgres.
 *
 * GCM (rather than CBC) because it is authenticated: a tampered ciphertext
 * fails to decrypt instead of silently producing garbage we might then send to
 * Google.
 *
 * Wire format: `v1.<iv>.<authTag>.<ciphertext>`, each part base64url.
 * The version prefix means we can rotate to a new scheme later without
 * guessing at how existing rows were encoded.
 */

const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for.

function key(): Buffer {
  return Buffer.from(getEnv().TOKEN_ENCRYPTION_KEY, "base64");
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function encryptSecret(plaintext: string): string {
  if (plaintext.length === 0) throw new Error("Refusing to encrypt an empty secret.");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION, b64url(iv), b64url(authTag), b64url(ciphertext)].join(".");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Encrypted value is malformed or uses an unknown format version.");
  }

  const [, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ctPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** HMAC-SHA256, base64url encoded. Used for session cookies and OAuth state. */
export function sign(value: string, secret: string = getEnv().SESSION_SECRET): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** Constant-time comparison, safe on differing lengths. */
export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so the timing does not leak the length.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
