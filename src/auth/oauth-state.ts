import { safeEquals, sign, randomToken } from "@/auth/crypto";
import { OAUTH_STATE_COOKIE } from "@/auth/constants";

/**
 * CSRF protection for the OAuth round trip.
 *
 * The `state` parameter is a signed, timestamped nonce. We also drop the same
 * nonce in a short-lived cookie, so the callback can prove the response belongs
 * to a flow *this browser* started — a signature alone would let an attacker
 * replay a state value they obtained elsewhere.
 */

export { OAUTH_STATE_COOKIE };
export const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes

export interface OAuthState {
  value: string;
  nonce: string;
}

export function createOAuthState(): OAuthState {
  const nonce = randomToken(24);
  const issuedAt = Date.now();
  const payload = `${nonce}:${issuedAt}`;
  return { value: `${payload}.${sign(payload)}`, nonce };
}

export function verifyOAuthState(
  stateParam: string | null,
  cookieNonce: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!stateParam) return { ok: false, reason: "missing state parameter" };
  if (!cookieNonce) return { ok: false, reason: "missing state cookie" };

  const separator = stateParam.lastIndexOf(".");
  if (separator <= 0) return { ok: false, reason: "malformed state" };

  const payload = stateParam.slice(0, separator);
  const signature = stateParam.slice(separator + 1);
  if (!safeEquals(signature, sign(payload))) return { ok: false, reason: "bad state signature" };

  const [nonce, issuedAtRaw] = payload.split(":");
  if (!nonce || !issuedAtRaw) return { ok: false, reason: "malformed state payload" };

  if (!safeEquals(nonce, cookieNonce)) return { ok: false, reason: "state does not match this browser" };

  const ageSeconds = (Date.now() - Number(issuedAtRaw)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > OAUTH_STATE_TTL_SECONDS) {
    return { ok: false, reason: "state expired" };
  }

  return { ok: true };
}
