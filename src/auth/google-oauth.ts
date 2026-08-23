import {
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_REVOKE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_SCOPES,
} from "@/config/google-api";
import { getGoogleOAuthConfig } from "@/config/env";
import { googleTokenResponseSchema, type GoogleTokenResponse } from "@/schemas/google";
import { GoogleApiError, GoogleAuthError, SchemaValidationError } from "@/utils/errors";
import { withRetry } from "@/utils/retry";
import { logger } from "@/utils/logger";

/**
 * Raw OAuth 2.0 against Google's endpoints, rather than the `googleapis`
 * client library.
 *
 * Reasons: the library does not cover mybusiness v4 (where reviews live), so we
 * would need a hand-rolled request path anyway; and token persistence here is
 * custom (encrypted, in Postgres) rather than the library's in-memory or
 * file-based defaults. One HTTP path is easier to reason about than two.
 */

const log = logger.child("google.oauth");

export function buildAuthorizationUrl(state: string): string {
  const { clientId, redirectUri } = getGoogleOAuthConfig();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // offline + consent is what produces a refresh token. Google only returns
    // one on first authorization unless consent is re-prompted, and a server
    // that cannot refresh is a server that breaks in an hour.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

async function postToken(body: URLSearchParams, label: string): Promise<GoogleTokenResponse> {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const text = await response.text();

  if (!response.ok) {
    // Google's OAuth errors are a flat {error, error_description}. We surface
    // the code but never the request body, which contains the client secret.
    let code = "unknown_error";
    let description = "";
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      code = parsed.error ?? code;
      description = parsed.error_description ?? "";
    } catch {
      /* non-JSON error body; fall through with the defaults */
    }

    // invalid_grant means the refresh token is dead — revoked, expired after
    // long disuse, or invalidated by a password change. Retrying cannot help.
    if (code === "invalid_grant") {
      throw new GoogleAuthError(
        "Google rejected the stored credential. Reconnect the Google account.",
        { label, code },
      );
    }

    throw new GoogleApiError(`Google token request failed (${code}).`, {
      status: response.status,
      context: { label, code, description: description.slice(0, 200) },
    });
  }

  const parsed = googleTokenResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new SchemaValidationError("Google returned an unexpected token response.", {
      label,
      issues: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
  }

  return parsed.data;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string | null;
  email: string | null;
}

export async function exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
  const { clientId, clientSecret, redirectUri } = getGoogleOAuthConfig();

  const tokens = await withRetry(
    () =>
      postToken(
        new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
        "exchange",
      ),
    { label: "oauth.exchange", maxAttempts: 3 },
  );

  if (!tokens.refresh_token) {
    // Without a refresh token the integration dies at the first token expiry.
    // Better to fail the connection now, loudly, than in an hour, silently.
    throw new GoogleAuthError(
      "Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.",
    );
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    scope: tokens.scope ?? null,
    email: tokens.id_token ? readEmailFromIdToken(tokens.id_token) : null,
  };
}

export interface RefreshedTokens {
  accessToken: string;
  expiresAt: Date;
  scope: string | null;
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
  const { clientId, clientSecret } = getGoogleOAuthConfig();

  const tokens = await withRetry(
    () =>
      postToken(
        new URLSearchParams({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
        }),
        "refresh",
      ),
    { label: "oauth.refresh", maxAttempts: 3 },
  );

  return {
    accessToken: tokens.access_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    scope: tokens.scope ?? null,
  };
}

export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_OAUTH_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      cache: "no-store",
    });
  } catch (error) {
    // A failed revoke should not block local disconnection — the user still
    // wants the credential gone from our database.
    log.warn("Token revocation failed; removing the local credential anyway", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Reads the `email` claim from Google's ID token without verifying it.
 *
 * Safe in this one context: the token came straight from Google's token
 * endpoint over TLS, in response to our own authenticated request, so there is
 * no untrusted party in the path. The value is used only as a display label —
 * never for authorization. Anywhere else, this would need full signature
 * verification.
 */
function readEmailFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}
