import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { getEnv } from "@/config/env";
import { exchangeCodeForTokens } from "@/auth/google-oauth";
import { OAUTH_STATE_COOKIE, verifyOAuthState } from "@/auth/oauth-state";
import { isSignedIn } from "@/auth/session";
import { saveConnection } from "@/database/repositories/connection.repository";
import { recordEvent } from "@/database/repositories/review.repository";
import { logger } from "@/utils/logger";

export const dynamic = "force-dynamic";

/**
 * OAuth callback.
 *
 * The authorization code arrives in a URL, which means it can land in browser
 * history, proxy logs and Referer headers. So the code is exchanged
 * immediately and the browser is redirected to a clean URL — the resulting
 * tokens never touch a query string, and the exchange happens server-side
 * where the client secret lives.
 */
export async function GET(request: NextRequest) {
  const env = getEnv();
  const home = new URL("/", env.APP_BASE_URL);

  const finish = async (params: Record<string, string>) => {
    const store = await cookies();
    store.delete(OAUTH_STATE_COOKIE);
    for (const [key, value] of Object.entries(params)) home.searchParams.set(key, value);
    return NextResponse.redirect(home);
  };

  if (!(await isSignedIn())) {
    return NextResponse.redirect(new URL("/login", env.APP_BASE_URL));
  }

  const url = new URL(request.url);

  // The user declined at Google's consent screen, or Google refused.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logger.warn("Google authorization was declined", { reason: oauthError });
    return finish({ error: "google_declined" });
  }

  const store = await cookies();
  const stateCheck = verifyOAuthState(
    url.searchParams.get("state"),
    store.get(OAUTH_STATE_COOKIE)?.value,
  );

  if (!stateCheck.ok) {
    logger.warn("Rejected OAuth callback", { reason: stateCheck.reason });
    return finish({ error: "invalid_state" });
  }

  const code = url.searchParams.get("code");
  if (!code) return finish({ error: "missing_code" });

  try {
    const tokens = await exchangeCodeForTokens(code);

    await saveConnection({
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      googleEmail: tokens.email,
    });

    await recordEvent(null, "GOOGLE_CONNECTED", { hasEmail: Boolean(tokens.email) }, "admin");
    logger.info("Google account connected");

    return finish({ connected: "1" });
  } catch (error) {
    logger.error("Token exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return finish({ error: "exchange_failed" });
  }
}
