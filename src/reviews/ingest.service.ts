import { hasContentChanged, mapGoogleReview } from "@/reviews/mapper";
import type { GoogleReview } from "@/schemas/google";
import type { GoogleReplyState, IngestResult, NormalizedReview } from "@/types/review";
import {
  applyReviewEdit,
  findLocationRowId,
  findReview,
  insertReview,
  recordEvent,
  recordRevision,
} from "@/database/repositories/review.repository";
import { BadRequestError } from "@/utils/errors";
import { logger } from "@/utils/logger";

const log = logger.child("reviews.ingest");

/**
 * Turns a Google review payload into a durable row, exactly once.
 *
 * ## Idempotency strategy
 *
 * Pub/Sub is at-least-once, and Google re-sends on any acknowledgement it does
 * not see in time. Duplicate delivery is therefore the normal case, not an
 * error case. Three layers handle it, deliberately overlapping:
 *
 *  1. **Database constraint.** `UNIQUE (location_id, google_review_id)` is the
 *     real guarantee. Even if every line of logic below were wrong, Postgres
 *     would refuse the second row. Application checks can be raced; a unique
 *     index cannot.
 *
 *  2. **Content comparison.** A duplicate delivery carries an identical
 *     `updateTime`, so it resolves to `unchanged` and does no writes at all —
 *     no status reset, no audit noise, and critically no re-entry into the
 *     generation pipeline that would produce a second draft.
 *
 *  3. **Reply-state tracking.** Publishing (Phase 6) keys off
 *     `google_reply_state`, not off status alone. A review already marked
 *     PUBLISHED or EXISTING_REPLY_FOUND is not a candidate for publishing, so
 *     even a replayed event that somehow reached the publisher would find
 *     nothing to do.
 *
 * The ordering matters: content comparison happens *before* any status change,
 * so a redelivery of an already-answered review cannot walk it backwards
 * through the state machine.
 */
export async function ingestReview(
  raw: GoogleReview,
  context: {
    googleAccountId: string;
    googleLocationId: string;
    locationTitle?: string | null;
    actor?: string;
  },
): Promise<IngestResult> {
  const review = mapGoogleReview(raw, context);
  const actor = context.actor ?? "system";

  const locationRowId = await findLocationRowId(context.googleLocationId);
  if (!locationRowId) {
    throw new BadRequestError(
      "That location is not synced yet. Load locations from the console before ingesting its reviews.",
      { googleLocationId: context.googleLocationId },
    );
  }

  const replyState = resolveReplyState(review);
  const existing = await findReview(locationRowId, review.googleReviewId);

  // --- New review -----------------------------------------------------------
  if (!existing) {
    const row = await insertReview(locationRowId, review, replyState);

    await recordEvent(
      row.id,
      "REVIEW_RECEIVED",
      {
        rating: review.rating,
        hasText: review.reviewText !== null,
        starOnly: review.reviewText === null,
      },
      actor,
    );

    if (replyState === "EXISTING_REPLY_FOUND") {
      await recordEvent(row.id, "EXISTING_REPLY_DETECTED", { source: "google" }, actor);
    }

    log.info("Review stored", { googleReviewId: review.googleReviewId, action: "created" });

    return {
      action: "created",
      reviewId: row.id,
      status: row.status,
      isEdited: row.is_edited,
      hasExistingGoogleReply: replyState === "EXISTING_REPLY_FOUND",
    };
  }

  // --- Duplicate delivery ---------------------------------------------------
  // Google's updateTime moves on any change the customer makes. Equal or older
  // means we have already seen this exact version.
  const isStaleOrDuplicate = review.reviewUpdateTime <= existing.review_updated_at;

  if (isStaleOrDuplicate) {
    log.debug("Duplicate or stale review event ignored", {
      googleReviewId: review.googleReviewId,
      storedUpdateTime: existing.review_updated_at,
    });

    return {
      action: "unchanged",
      reviewId: existing.id,
      status: existing.status,
      isEdited: existing.is_edited,
      hasExistingGoogleReply: existing.google_reply_state === "EXISTING_REPLY_FOUND",
    };
  }

  // --- Edited review --------------------------------------------------------
  const contentChanged = hasContentChanged(
    { rating: existing.rating, reviewText: existing.review_text },
    review,
  );

  // Snapshot the previous version before overwriting it. Done first so a
  // failure here aborts the edit rather than losing the customer's original
  // words silently.
  if (contentChanged) {
    await recordRevision(existing.id, existing);
  }

  const updated = await applyReviewEdit(
    existing.id,
    review,
    // Never downgrade a reply state we already know about: if Google shows a
    // reply, that fact survives an edit.
    replyState === "NONE" && existing.google_reply_state !== "NONE"
      ? (existing.google_reply_state as GoogleReplyState)
      : replyState,
    contentChanged,
    existing.edit_count,
  );

  if (contentChanged) {
    await recordEvent(
      updated.id,
      "REVIEW_EDITED",
      {
        previousRating: existing.rating,
        newRating: review.rating,
        editCount: updated.edit_count,
        // A business reply already exists, so Phase 4 must route the new draft
        // to a human rather than overwrite what customers can already see.
        hadPublishedReply: existing.google_reply_state !== "NONE",
      },
      actor,
    );
    log.info("Review edited by customer", { googleReviewId: review.googleReviewId });
  }

  return {
    action: contentChanged ? "updated" : "unchanged",
    reviewId: updated.id,
    status: updated.status,
    isEdited: updated.is_edited,
    hasExistingGoogleReply: updated.google_reply_state === "EXISTING_REPLY_FOUND",
  };
}

function resolveReplyState(review: NormalizedReview): GoogleReplyState {
  return review.existingReplyText ? "EXISTING_REPLY_FOUND" : "NONE";
}

/** Ingests a page of reviews, tolerating individual failures. */
export async function ingestReviews(
  reviews: GoogleReview[],
  context: { googleAccountId: string; googleLocationId: string; locationTitle?: string | null; actor?: string },
): Promise<{ created: number; updated: number; unchanged: number; failed: number }> {
  const totals = { created: 0, updated: 0, unchanged: 0, failed: 0 };

  for (const review of reviews) {
    try {
      const result = await ingestReview(review, context);
      totals[result.action] += 1;
    } catch (error) {
      totals.failed += 1;
      // One malformed review must not abort the batch — the remaining reviews
      // are still worth storing.
      log.error("Failed to ingest a review", {
        googleReviewId: review.reviewId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return totals;
}
