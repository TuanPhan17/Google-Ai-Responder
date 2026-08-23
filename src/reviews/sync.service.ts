import { ensureMockConnection, getConnection } from "@/database/repositories/connection.repository";
import {
  findAccountRowId,
  upsertAccounts,
  upsertLocations,
} from "@/database/repositories/review.repository";
import { getReviewSource } from "@/reviews/review-source";
import { ingestReviews } from "@/reviews/ingest.service";
import { GoogleAuthError } from "@/utils/errors";
import type { AccountSummary, LocationSummary } from "@/types/review";
import { logger } from "@/utils/logger";

const log = logger.child("reviews.sync");

/**
 * Sync orchestration.
 *
 * Accounts and locations are cached locally rather than fetched per request.
 * The Reviews API ships with a low default quota, and an admin page that
 * re-listed the org structure on every render would spend that quota on data
 * that changes roughly never.
 *
 * In mock mode there is no OAuth connection, so a placeholder google_connections
 * row is seeded on demand — connection_id is a hard FK, and google_accounts
 * rows still get written in mock mode, so the row has to genuinely exist.
 */

async function resolveConnectionId(): Promise<string> {
  const source = getReviewSource();
  if (source.kind === "mock") return ensureMockConnection();

  const connection = await getConnection();
  if (!connection) throw new GoogleAuthError("No Google account is connected.");
  return connection.id;
}

export async function syncAccounts(): Promise<AccountSummary[]> {
  const accounts = await getReviewSource().listAccounts();

  const source = getReviewSource();
  if (source.kind === "google") {
    await upsertAccounts(await resolveConnectionId(), accounts);
  }

  log.info("Synced Google accounts", { count: accounts.length });
  return accounts;
}

export async function syncLocations(accountResourceName: string): Promise<LocationSummary[]> {
  const locations = await getReviewSource().listLocations(accountResourceName);

  const accountId = accountResourceName.replace(/^accounts\//, "");
  const connectionId = await resolveConnectionId();

  let accountRowId = await findAccountRowId(connectionId, accountId);

  // Locations are meaningless without their parent account row, so create it
  // on demand rather than making the operator sync accounts first.
  if (!accountRowId) {
    const [created] = await upsertAccounts(connectionId, [
      { name: accountResourceName, accountId, accountName: null, type: null, verificationState: null },
    ]);
    accountRowId = created?.id ?? null;
  }

  if (accountRowId) {
    await upsertLocations(accountRowId, locations);
  }

  log.info("Synced locations", { accountId, count: locations.length });
  return locations;
}

/**
 * Pulls reviews for a location and persists them.
 *
 * Phase 1 stops here: reviews land in the database with status RECEIVED and
 * nothing else happens to them. Generation (Phase 2) and publishing (Phase 6)
 * hook in later. Keeping this function free of both means the ingest path can
 * be trusted before there is anything that could write to Google.
 */
export async function syncReviews(
  accountId: string,
  locationId: string,
  locationTitle?: string | null,
): Promise<{ fetched: number; created: number; updated: number; unchanged: number; failed: number }> {
  const reviews = await getReviewSource().listReviews(accountId, locationId);

  const totals = await ingestReviews(reviews, {
    googleAccountId: accountId,
    googleLocationId: locationId,
    locationTitle: locationTitle ?? null,
  });

  log.info("Synced reviews", { locationId, fetched: reviews.length, ...totals });
  return { fetched: reviews.length, ...totals };
}
