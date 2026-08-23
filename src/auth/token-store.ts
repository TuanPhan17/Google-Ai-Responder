import {
  getConnection,
  markConnectionFailed,
  updateAccessToken,
  type StoredConnection,
} from "@/database/repositories/connection.repository";
import { refreshAccessToken } from "@/auth/google-oauth";
import { GoogleAuthError } from "@/utils/errors";
import { logger } from "@/utils/logger";

/**
 * Supplies a valid access token to the Google HTTP client.
 *
 * Two details worth calling out:
 *
 *  - A 60-second skew window. Tokens that expire "in 3 seconds" are treated as
 *    already expired, because the request they would authorize takes non-zero
 *    time to reach Google.
 *
 *  - Single-flight refresh. Processing a Pub/Sub burst means many concurrent
 *    calls discovering an expired token at the same instant. Without the
 *    in-flight promise, each would refresh independently — wasting quota and,
 *    worse, racing to write different access tokens into the same row.
 */

const log = logger.child("google.tokens");
const EXPIRY_SKEW_MS = 60_000;

let inFlightRefresh: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
  const connection = await requireConnection();

  if (isUsable(connection)) return connection.accessToken as string;

  // Coalesce concurrent refreshes onto one request.
  inFlightRefresh ??= doRefresh(connection).finally(() => {
    inFlightRefresh = null;
  });

  return inFlightRefresh;
}

/** Forces a refresh even if the cached token looks valid. Used after a 401. */
export async function forceRefresh(): Promise<string> {
  const connection = await requireConnection();
  inFlightRefresh ??= doRefresh(connection).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function requireConnection(): Promise<StoredConnection> {
  const connection = await getConnection();

  if (!connection) {
    throw new GoogleAuthError("No Google account is connected. Connect one from the console.");
  }
  if (connection.status !== "ACTIVE") {
    throw new GoogleAuthError(
      `The Google connection is ${connection.status.toLowerCase()}. Reconnect the Google account.`,
      { status: connection.status },
    );
  }

  return connection;
}

function isUsable(connection: StoredConnection): boolean {
  if (!connection.accessToken || !connection.accessTokenExpiresAt) return false;
  return connection.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();
}

async function doRefresh(connection: StoredConnection): Promise<string> {
  try {
    const refreshed = await refreshAccessToken(connection.refreshToken);
    await updateAccessToken(connection.id, refreshed.accessToken, refreshed.expiresAt);
    log.info("Access token refreshed", { expiresAt: refreshed.expiresAt.toISOString() });
    return refreshed.accessToken;
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      // The refresh token itself is dead. Record that so the console can tell
      // the operator to reconnect, instead of failing the same way forever.
      await markConnectionFailed(connection.id, "REVOKED", error.message);
    } else {
      await markConnectionFailed(
        connection.id,
        "ERROR",
        error instanceof Error ? error.message : "Unknown refresh failure",
      );
    }
    throw error;
  }
}
