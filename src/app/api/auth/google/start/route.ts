import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getEnv } from "@/config/env";
import { buildAuthorizationUrl } from "@/auth/google-oauth";
import { createOAuthState, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS } from "@/auth/oauth-state";
import { isSignedIn } from "@/auth/session";

export const dynamic = "force-dynamic";

/** Starts the OAuth round trip: mints CSRF state, then redirects to Google. */
export async function GET() {
  const env = getEnv();

  if (!(await isSignedIn())) {
    return NextResponse.redirect(new URL("/login", env.APP_BASE_URL));
  }

  if (env.MOCK_MODE) {
    return NextResponse.redirect(new URL("/?error=mock_mode_active", env.APP_BASE_URL));
  }

  const state = createOAuthState();

  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, state.nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/api/auth/google",
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });

  return NextResponse.redirect(buildAuthorizationUrl(state.value));
}
