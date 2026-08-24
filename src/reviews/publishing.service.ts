import {
  claimReviewForPublishing,
  findReviewById,
  markPublishBlockedByExistingReply,
  markPublished,
  markPublishFailed,
  recordEvent,
  type ReviewRow,
} from "@/database/repositories/review.repository";
import { normalizeText } from "@/reviews/mapper";
import { getReviewSource } from "@/reviews/review-source";
import { BadRequestError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { ReviewStatus } from "@/types/review";

const log = logger.child("reviews.publishing");

/**
 * Posts an eligible review's response to Google. Per docs/SPEC.md Phase 6.
 *
 * Two entry states share this one function: APPROVED (a human signed off via
 * the Phase 5 approval workflow) and GENERATED (the deterministic publishing
 * policy already decided AUTO_PUBLISH — see policies/publishing-policy.ts).
 * There is no separate "auto-publish" code path; a GENERATED review is simply
 * a review that reaches this function without a human having approved it
 * first, and the policy decision that got it there was already checked
 * before the row could ever become GENERATED. Nothing here re-derives that
 * decision — this function's job starts after eligibility has already been
 * decided, and is entirely about doing the write safely.
 *
 * ## Re-checking state immediately before calling Google
 *
 * A review can sit between "eligible" and "actually published" for an
 * arbitrary length of time, and nothing stops someone from unapproving it (or
 * two publish requests from racing each other) in that window. This function
 * never acts on the status a caller — or even this function's own read a few
 * lines up — last observed. `claimReviewForPublishing` is a single
 * UPDATE ... WHERE that only succeeds if the row is *still* eligible at the
 * instant it runs, atomically, in the same statement. That is the actual
 * guard; the `findReviewById` check above it exists only to produce a
 * friendlier `BadRequestError` on the common, non-racy case (a review that
 * was simply never approved) instead of always surfacing a `ConflictError`.
 * This mirrors the exact split approval.service.ts already uses for approve/
 * reject/edit — a fast pre-check plus a race-proof atomic write — rather than
 * inventing a second way to do the same thing.
 *
 * The claim also moves `google_reply_state` to `PUBLISH_PENDING`, which is
 * what stops `unapproveReview` from succeeding on a review that a publish
 * attempt already holds (see the guard on `markUnapproved` in
 * review.repository.ts).
 *
 * ## What happens if Google accepts the reply but the published_at write fails
 *
 * This is not a hypothetical: the write to Supabase happens *after* the
 * network call to Google returns, so a crash, a timeout, or a transient
 * Supabase error in that specific window leaves the review's true state
 * (published on Google) out of sync with its recorded state (still
 * PUBLISH_PENDING, `published_at` still null).
 *
 * The fix relies on a property of Google's API described in
 * google/reviews.service.ts: `updateReply` is a PUT to a single reply
 * resource per review, not a POST that appends. There is no way to end up
 * with two replies by calling it twice with the same content — the second
 * call just re-sets the same value. That makes recovery a matter of asking
 * Google what is actually there before writing anything, rather than an
 * operator having to reconcile the two systems by hand:
 *
 *   1. The `try` block below covers both the call to Google and the
 *      subsequent `markPublished` write. If `markPublished` is the half that
 *      throws — the case this note is about — the `catch` still runs and
 *      transitions `google_reply_state` from PUBLISH_PENDING to
 *      PUBLISH_FAILED. That is what makes the row claimable again: `status`
 *      was never touched (still APPROVED or GENERATED), so the very next
 *      call to `publishReview` for this review is a completely ordinary
 *      retry, not a special "resume" path with its own code.
 *   2. That retry re-claims the row and, before writing anything, asks
 *      Google what the review's reply *actually* is right now.
 *   3. If Google's stored reply already equals the response this function
 *      intended to publish, that is proof the earlier attempt's write to
 *      Google succeeded — this function records `published_at` and returns
 *      without calling Google a second time (the `recovered: true` branch
 *      below). If it doesn't match (nothing there, or genuinely different
 *      text), the earlier attempt's Google call is treated as never having
 *      happened, and this function posts normally.
 *
 * Either branch is safe specifically because of the PUT semantics above: even
 * when this function *does* re-post identical content the earlier attempt
 * already wrote, that is a no-op on Google's side, not a second reply.
 *
 * What this does **not** cover: if the process dies entirely (not a thrown
 * error, but the whole runtime disappearing) between Google accepting the
 * write and the `catch` block running, the row is left stuck at
 * PUBLISH_PENDING — which is deliberately not itself claimable, so the
 * ordinary retry path above can't reach it. That is a narrow window and this
 * phase does not add a background reconciler for it; see the phase report
 * for why, and what closing it fully would take (a Phase 7 concern — an
 * automatic workflow is exactly where a "sweep stale PUBLISH_PENDING rows"
 * job belongs).
 *
 * ## Never publishing over an existing reply
 *
 * The same live Google read that powers recovery above is also the
 * authoritative existing-reply check, run immediately before the write. It
 * does not rely on `google_reply_state` as recorded in this database, which
 * can be stale — the review could have been approved before an existing
 * reply was known about (approveReview does not check reply state; only
 * auto-publish's deterministic policy does), or someone could have replied
 * directly in Google's own UI after this review entered the queue. If
 * Google's reply exists and does not match what this function intended to
 * publish, it is left alone and the review is routed back to
 * PENDING_APPROVAL for a human to look at.
 */

export interface PublishReviewOptions {
  actor?: string;
}

export type PublishReviewOutcome =
  | { outcome: "published"; publishedAt: string; recovered: boolean }
  | { outcome: "blocked_existing_reply" }
  | { outcome: "failed"; error: string };

const PUBLISHABLE_STATUSES: ReviewStatus[] = ["APPROVED", "GENERATED"];

function requireReview(review: ReviewRow | null, reviewId: string): ReviewRow {
  if (!review) throw new BadRequestError("No review with that id.", { reviewId });
  return review;
}

export async function publishReview(
  reviewId: string,
  options: PublishReviewOptions = {},
): Promise<PublishReviewOutcome> {
  const actor = options.actor ?? "system";

  const precheck = requireReview(await findReviewById(reviewId), reviewId);
  if (!PUBLISHABLE_STATUSES.includes(precheck.status)) {
    throw new BadRequestError(`Cannot publish a review in status ${precheck.status}.`, {
      reviewId,
      status: precheck.status,
    });
  }

  // The guard that actually matters — see the module doc comment.
  const claimed = await claimReviewForPublishing(reviewId, PUBLISHABLE_STATUSES);

  return finalizeClaimedPublish(claimed, actor);
}

/**
 * Everything that happens once a review is already atomically claimed
 * (`google_reply_state = 'PUBLISH_PENDING'`) — the live Google check, the
 * write, and the outcome bookkeeping described in the module doc comment
 * above.
 *
 * Split out so `publishReview`'s own claim (via `claimReviewForPublishing`,
 * NONE/PUBLISH_FAILED -> PUBLISH_PENDING) and the Phase 7 stale-row sweep's
 * claim (`claimStalePublishPendingReview`, a PUBLISH_PENDING row whose claim
 * looks abandoned, re-touched in place) both land here afterwards. The two
 * callers claim differently — one from a fresh state, one by force-reclaiming
 * a row already in PUBLISH_PENDING — but once a caller holds the claim, what
 * happens next (check Google live, recover/publish/block) is identical, and
 * only living in one place keeps it that way.
 */
export async function finalizeClaimedPublish(claimed: ReviewRow, actor: string): Promise<PublishReviewOutcome> {
  const reviewId = claimed.id;
  const finalResponse = claimed.final_response ?? claimed.ai_response;
  if (!finalResponse) {
    await markPublishFailed(reviewId, "No generated response text was available to publish.");
    await recordEvent(reviewId, "PUBLISH_FAILED", { reason: "no_response_text" }, actor);
    log.error("Publish claimed a review with no response text", { reviewId });
    return { outcome: "failed", error: "No generated response text was available to publish." };
  }

  const source = getReviewSource();

  try {
    const liveReview = await source.getReview(claimed.google_account_id, claimed.google_location_id, claimed.google_review_id);
    const existingReply = normalizeText(liveReview.reviewReply?.comment);

    if (existingReply && existingReply === finalResponse) {
      const publishedAt = new Date().toISOString();
      await markPublished(reviewId, { finalResponse, publishedAt });
      await recordEvent(reviewId, "RESPONSE_PUBLISHED", { recovered: true }, actor);
      log.info("Publish recovered: Google already had this exact reply", { reviewId });
      return { outcome: "published", publishedAt, recovered: true };
    }

    if (existingReply) {
      await markPublishBlockedByExistingReply(reviewId, {
        existingReply,
        existingReplyUpdateTime: liveReview.reviewReply?.updateTime ?? null,
      });
      await recordEvent(reviewId, "PUBLISH_FAILED", { reason: "existing_google_reply" }, actor);
      log.info("Publish blocked: Google already has a different reply", { reviewId });
      return { outcome: "blocked_existing_reply" };
    }

    await source.updateReply(claimed.google_account_id, claimed.google_location_id, claimed.google_review_id, finalResponse);

    const publishedAt = new Date().toISOString();
    await markPublished(reviewId, { finalResponse, publishedAt });
    await recordEvent(reviewId, "RESPONSE_PUBLISHED", { recovered: false }, actor);
    log.info("Review published", { reviewId });
    return { outcome: "published", publishedAt, recovered: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markPublishFailed(reviewId, message);
    await recordEvent(reviewId, "PUBLISH_FAILED", { error: message }, actor);
    log.error("Review publish failed", { reviewId, error: message });
    return { outcome: "failed", error: message };
  }
}
