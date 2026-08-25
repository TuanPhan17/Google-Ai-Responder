import {
  findReviewById,
  listSyncedLocations,
  recordEvent,
} from "@/database/repositories/review.repository";
import { ingestReview } from "@/reviews/ingest.service";
import { processReview } from "@/reviews/processing.service";
import { getReviewSource } from "@/reviews/review-source";
import { resolveLocationConfig } from "@/reviews/settings.service";
import { REVIEW_NOTIFICATION_TYPES, type GoogleNotification } from "@/schemas/pubsub";
import type { GoogleReview } from "@/schemas/google";
import { logger } from "@/utils/logger";

const log = logger.child("reviews.pubsub");

/**
 * What a notification triggers, per docs/SPEC.md's Pub/Sub section: "trigger
 * review retrieval rather than trusting notification payloads as the
 * complete source of review data." Google is always re-read; the
 * notification only decides *what* to re-read.
 *
 * Two paths, depending on how much the notification actually tells us:
 *
 *  - **Targeted fetch**: the notification's review resource name parses
 *    cleanly (`accounts/{a}/locations/{l}/reviews/{r}`, the same shape this
 *    codebase already uses everywhere — see `buildReviewParent` in
 *    google/reviews.service.ts). One `getReview` call, one `ingestReview`.
 *  - **Fallback resync**: it doesn't. Google's own reference docs for this
 *    API describe which fields exist in prose (`review_name`) but never
 *    publish the message's actual JSON schema, so this case is a real
 *    possibility, not defensive paranoia. Resyncing every location this app
 *    has synced is still *correct* — `ingestReview`'s idempotency (see its
 *    own doc comment) makes a redundant resync of an unaffected location a
 *    no-op — just less targeted than the first path. Tightening this once
 *    real notification traffic is observable is exactly the kind of
 *    follow-up that needs actual Google API access, which is the same
 *    external dependency blocking everything else about going live.
 */

const REVIEW_RESOURCE_NAME_PATTERN = /^accounts\/([^/]+)\/locations\/([^/]+)\/reviews\/([^/]+)$/;

function extractReviewResourceName(notification: GoogleNotification): string | null {
  const record = notification as Record<string, unknown>;
  const candidate = record.reviewName ?? record.review_name;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

interface ParsedReviewResource {
  accountId: string;
  locationId: string;
  reviewId: string;
}

function parseReviewResourceName(resourceName: string): ParsedReviewResource | null {
  const match = REVIEW_RESOURCE_NAME_PATTERN.exec(resourceName);
  const accountId = match?.[1];
  const locationId = match?.[2];
  const reviewId = match?.[3];
  if (!accountId || !locationId || !reviewId) return null;
  return { accountId, locationId, reviewId };
}

export interface NotificationTotals {
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Reviews that were RECEIVED after ingest and were automatically sent through generation. */
  processed: number;
}

function emptyTotals(): NotificationTotals {
  return { created: 0, updated: 0, unchanged: 0, failed: 0, processed: 0 };
}

function addTotals(a: NotificationTotals, b: NotificationTotals): NotificationTotals {
  return {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
    failed: a.failed + b.failed,
    processed: a.processed + b.processed,
  };
}

/**
 * Ingests one Google review and, if that leaves it sitting in RECEIVED
 * (a genuinely new review, or an edit whose content actually changed),
 * immediately runs it through generation — the "automatic processing
 * workflow" docs/SPEC.md's Phase 7 calls for. This is deliberately Pub/Sub-
 * only: the dashboard's manual "Pull reviews" button (Phase 1) still only
 * ingests, matching its original, already-shipped behavior — a human
 * clicking that button hasn't asked for every resulting review to also be
 * auto-drafted. Auto-processing is specifically what wiring up automatic
 * notifications is supposed to add.
 */
async function ingestAndAutoProcess(
  review: GoogleReview,
  context: { googleAccountId: string; googleLocationId: string; locationTitle: string | null },
): Promise<NotificationTotals> {
  const totals = emptyTotals();

  try {
    const result = await ingestReview(review, { ...context, actor: "pubsub" });
    totals[result.action] += 1;

    if (result.status === "RECEIVED") {
      const row = await findReviewById(result.reviewId);
      if (row) {
        const { business, settings } = await resolveLocationConfig(row.location_id);
        await processReview(result.reviewId, { actor: "pubsub", business, settings });
        totals.processed += 1;
      }
    }
  } catch (error) {
    totals.failed += 1;
    log.error("Failed to ingest/process a Pub/Sub-notified review", {
      googleReviewId: review.reviewId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return totals;
}

/**
 * Deliberately lets `getReview` throw uncaught, unlike everything inside
 * `ingestAndAutoProcess`. This is one message about one review — if Google's
 * API is down or times out, the right outcome is for the route handler to
 * return 500 and let Pub/Sub's own retry/backoff try the same message again
 * later, not to silently tally a failure and acknowledge a message whose
 * review was never actually fetched. Once ingest has a review payload in
 * hand, though, a write failure is handled the same way `ingestReviews`
 * (ingest.service.ts) already treats a batch: tallied, not thrown, so one bad
 * row can't take a whole resync down with it.
 */
async function fetchIngestAndProcessOne(
  accountId: string,
  locationId: string,
  reviewId: string,
): Promise<NotificationTotals> {
  const review = await getReviewSource().getReview(accountId, locationId, reviewId);

  const synced = await listSyncedLocations();
  const locationTitle = synced.find((loc) => loc.googleLocationId === locationId)?.locationTitle ?? null;

  return ingestAndAutoProcess(review, { googleAccountId: accountId, googleLocationId: locationId, locationTitle });
}

async function resyncAllSyncedLocations(): Promise<NotificationTotals> {
  const locations = await listSyncedLocations();
  let totals = emptyTotals();

  for (const location of locations) {
    let reviews: GoogleReview[];
    try {
      reviews = await getReviewSource().listReviews(location.googleAccountId, location.googleLocationId);
    } catch (error) {
      totals.failed += 1;
      log.error("Failed to list reviews for a location during the Pub/Sub fallback resync", {
        googleLocationId: location.googleLocationId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const review of reviews) {
      totals = addTotals(
        totals,
        await ingestAndAutoProcess(review, {
          googleAccountId: location.googleAccountId,
          googleLocationId: location.googleLocationId,
          locationTitle: location.locationTitle,
        }),
      );
    }
  }

  return totals;
}

export type NotificationAction = "ignored_type" | "targeted_fetch" | "fallback_resync";

export interface HandleNotificationResult {
  action: NotificationAction;
  notificationType: string | null;
  totals: NotificationTotals;
}

export async function handleReviewNotification(
  notification: GoogleNotification,
  messageId: string,
): Promise<HandleNotificationResult> {
  const notificationType = notification.notificationType ?? null;

  if (!notificationType || !(REVIEW_NOTIFICATION_TYPES as readonly string[]).includes(notificationType)) {
    log.debug("Ignoring a notification type this app doesn't act on", { notificationType, messageId });
    await recordEvent(null, "PUBSUB_NOTIFICATION_RECEIVED", { messageId, notificationType, action: "ignored_type" }, "pubsub");
    return { action: "ignored_type", notificationType, totals: emptyTotals() };
  }

  const resourceName = extractReviewResourceName(notification);
  const parsed = resourceName ? parseReviewResourceName(resourceName) : null;

  let action: NotificationAction;
  let totals: NotificationTotals;

  if (parsed) {
    log.info("Targeted fetch for a notified review", { messageId, ...parsed });
    action = "targeted_fetch";
    totals = await fetchIngestAndProcessOne(parsed.accountId, parsed.locationId, parsed.reviewId);
  } else {
    log.warn("Notification did not carry a recognizable review resource name — falling back to a full resync", {
      messageId,
      notificationType,
    });
    action = "fallback_resync";
    totals = await resyncAllSyncedLocations();
  }

  await recordEvent(null, "PUBSUB_NOTIFICATION_RECEIVED", { messageId, notificationType, action, totals }, "pubsub");
  log.info("Pub/Sub notification handled", { messageId, notificationType, action, totals });

  return { action, notificationType, totals };
}
