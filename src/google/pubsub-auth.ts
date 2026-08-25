import { OAuth2Client, type TokenPayload } from "google-auth-library";

import { getEnv, getPubSubAudience } from "@/config/env";
import { UnauthorizedError } from "@/utils/errors";
import { logger } from "@/utils/logger";

const log = logger.child("google.pubsub-auth");

/**
 * Verifies a Cloud Pub/Sub push request actually came from Pub/Sub.
 *
 * An authenticated push subscription signs a Google-issued OIDC JWT into the
 * request's `Authorization: Bearer <token>` header. Per CLAUDE.md's security
 * requirements ("Validate Pub/Sub requests"), this is not optional — without
 * it, `/api/pubsub/reviews` would be an unauthenticated endpoint that anyone
 * on the internet could POST to, forcing this app to spend Google API quota
 * fetching and re-processing arbitrary reviews on command.
 *
 * `OAuth2Client.verifyIdToken` (google-auth-library, Google's own recommended
 * approach for this) checks the signature against Google's published keys,
 * the expiry, and the audience in one call. What it does *not* check —
 * confirmed by Google's Pub/Sub authentication docs — is that the token
 * actually came from a service account, so `email` /  `email_verified` are
 * checked here explicitly afterward.
 */

let client: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  client ??= new OAuth2Client();
  return client;
}

export interface VerifiedPushToken {
  email: string;
}

export async function verifyPubSubPushToken(authorizationHeader: string | null): Promise<VerifiedPushToken> {
  const token = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    throw new UnauthorizedError("Missing or malformed Authorization header on Pub/Sub push request.");
  }

  let payload: TokenPayload | undefined;
  try {
    const ticket = await getClient().verifyIdToken({ idToken: token, audience: getPubSubAudience() });
    payload = ticket.getPayload();
  } catch (error) {
    log.warn("Pub/Sub push token failed verification", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new UnauthorizedError("Pub/Sub push token failed verification.");
  }

  if (!payload?.email || !payload.email_verified) {
    throw new UnauthorizedError("Pub/Sub push token has no verified email claim.");
  }
  if (!payload.email.endsWith(".iam.gserviceaccount.com")) {
    throw new UnauthorizedError("Pub/Sub push token was not issued to a service account.");
  }

  const expected = getEnv().PUBSUB_SERVICE_ACCOUNT_EMAIL;
  if (expected && payload.email !== expected) {
    throw new UnauthorizedError("Pub/Sub push token's service account is not the configured one.");
  }

  return { email: payload.email };
}
