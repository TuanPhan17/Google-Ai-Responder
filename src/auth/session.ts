import { cookies } from "next/headers";

import { getEnv } from "@/config/env";
import { safeEquals, sign } from "@/auth/crypto";
import { SESSION_COOKIE } from "@/auth/constants";

/**
 * Admin session.
 *
 * Phase 1 gates the console behind a single shared password stored in the
 * environment. That is deliberately the simplest thing that is actually safe:
 * the cookie is HMAC-signed and httpOnly, so it cannot be forged or read by
 * scripts, and no user table exists yet to get wrong. Phase 8 replaces this
 * with real accounts.
 */

export { SESSION_COOKIE };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function serialize(expiresAt: number): string {
  const payload = String(expiresAt);
  return `${payload}.${sign(payload)}`;
}

export function verifySessionValue(value: string | undefined): boolean {
  if (!value) return false;

  const separator = value.lastIndexOf(".");
  if (separator <= 0) return false;

  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);

  if (!safeEquals(signature, sign(payload))) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function checkAdminPassword(candidate: string): boolean {
  return safeEquals(candidate, getEnv().ADMIN_PASSWORD);
}

export async function createSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, serialize(Date.now() + SESSION_TTL_MS), {
    httpOnly: true,
    sameSite: "lax", // "lax" so the Google OAuth redirect back to us keeps the session.
    secure: getEnv().NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function isSignedIn(): Promise<boolean> {
  const store = await cookies();
  return verifySessionValue(store.get(SESSION_COOKIE)?.value);
}
