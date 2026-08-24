import {
  claimStalePublishPendingReview,
  findAutoPublishEligibleReviewIds,
  findStalePublishPendingReviewIds,
} from "@/database/repositories/review.repository";
import { getEnv } from "@/config/env";
import { finalizeClaimedPublish, publishReview, type PublishReviewOutcome } from "@/reviews/publishing.service";
import { logger } from "@/utils/logger";

const log = logger.child("reviews.sweep");

/**
 * Phase 7's "automatic processing workflow," minus the Pub/Sub wiring that
 * would trigger it on a schedule. `runBackgroundSweep` is what a scheduler
 * (cron, a platform's scheduled-function feature, whatever gets set up
 * later — see scripts/run-sweep.ts) is meant to call periodically. Nothing
 * in this file itself is "always running"; it is the work such a process
 * would do each time it wakes up.
 *
 * Two independent gaps, closed by two independent passes:
 *
 * 1. `recoverStalePublishPendingReviews` — the stuck-PUBLISH_PENDING gap
 *    documented in docs/SPEC.md's Phase 7 "Known gaps" note and in
 *    publishing.service.ts's module doc comment: a process that died
 *    outright (not a thrown error) between Google accepting a reply and the
 *    `catch` block that would otherwise demote the row to PUBLISH_FAILED
 *    leaves it stuck at PUBLISH_PENDING, a state `claimReviewForPublishing`
 *    deliberately never re-claims.
 * 2. `publishEligibleGeneratedReviews` — the auto-trigger gap Phase 6 left
 *    open on purpose (see the "What Phase 6 deliberately does not do"
 *    section of docs/SPEC.md): a GENERATED review is fully eligible to
 *    publish but nothing calls `publishReview` for it without a human or a
 *    script doing so explicitly.
 */

/**
 * A row still PUBLISH_PENDING past this many ms is treated as stuck rather
 * than mid-flight. Derived from the actual Google retry budget instead of a
 * flat guess, because a flat guess goes stale the moment someone raises
 * GOOGLE_API_TIMEOUT_MS or GOOGLE_API_MAX_ATTEMPTS (both valid per
 * src/config/env.ts, up to 120_000ms / 8 attempts) — a legitimate operator
 * response to a slow Business Profile API, not a misconfiguration.
 *
 * `finalizeClaimedPublish` makes up to two sequential `googleRequest` calls
 * (`getReview`, then `updateReply`) — each individually bounded by
 * `GOOGLE_API_MAX_ATTEMPTS * GOOGLE_API_TIMEOUT_MS` (every retry attempt is
 * capped at the timeout, and an aborted attempt is itself retryable — see
 * `isRetryable` in src/utils/errors.ts). `* 2` covers both calls; the
 * additive margin on top covers what that arithmetic leaves out: the
 * inter-attempt backoff sleeps (bounded, but not by this formula), the
 * Supabase round trips around the Google calls, and general scheduling
 * jitter. It does *not* cover a hung access-token refresh: `postToken` in
 * src/auth/google-oauth.ts issues a raw `fetch` with no timeout at all, so
 * that one path is genuinely unbounded and no finite threshold closes it —
 * see the Phase 7 sweep-threshold analysis in docs/SPEC.md.
 */
const GOOGLE_CALLS_PER_PUBLISH_ATTEMPT = 2;
const STALE_PUBLISH_PENDING_SAFETY_MARGIN_MS = 5 * 60 * 1000;

function defaultStalePublishPendingMs(): number {
  const env = getEnv();
  return env.GOOGLE_API_MAX_ATTEMPTS * env.GOOGLE_API_TIMEOUT_MS * GOOGLE_CALLS_PER_PUBLISH_ATTEMPT
    + STALE_PUBLISH_PENDING_SAFETY_MARGIN_MS;
}

const DEFAULT_BATCH_LIMIT = 25;

export interface SweepBatchResult {
  scanned: number;
  outcomes: Partial<Record<PublishReviewOutcome["outcome"] | "skipped", number>>;
}

export interface StaleSweepResult extends SweepBatchResult {
  /** How many of the scanned candidates this run actually won the claim race for. */
  reclaimed: number;
}

function tally(outcomes: SweepBatchResult["outcomes"], key: keyof SweepBatchResult["outcomes"]): void {
  outcomes[key] = (outcomes[key] ?? 0) + 1;
}

/**
 * Finds GENERATED reviews the deterministic policy already cleared for
 * auto-publish and calls `publishReview` for each. `publishReview` performs
 * its own atomic claim (`claimReviewForPublishing`), so a candidate this
 * function selected that something else (a human clicking "publish now", a
 * concurrent sweep tick) already claimed in the meantime just loses that
 * race cleanly — `ConflictError` — and is tallied as `skipped`, not an
 * error worth stopping the batch for.
 *
 * With `REQUIRE_APPROVAL_FOR_ALL` on (the shipped default — see
 * src/config/env.ts), `decidePublishing` never returns `AUTO_PUBLISH`, so no
 * review can reach GENERATED status through the normal generation pipeline
 * any more; the query below would come back empty on its own. This function
 * checks the flag directly anyway, before querying, for the same reason
 * `publishReview` re-checks Google's live reply instead of trusting a status
 * read moments earlier: a GENERATED row that predates this flag being turned
 * on — leftover from before this product decision, or written by a seed/test
 * script — must not be treated as still-eligible just because the row
 * exists and the flag happens to currently be off elsewhere.
 */
export async function publishEligibleGeneratedReviews(limit = DEFAULT_BATCH_LIMIT): Promise<SweepBatchResult> {
  if (getEnv().REQUIRE_APPROVAL_FOR_ALL) {
    log.debug("Auto-publish sweep skipped entirely: REQUIRE_APPROVAL_FOR_ALL is on");
    return { scanned: 0, outcomes: {} };
  }

  const ids = await findAutoPublishEligibleReviewIds(limit);
  const outcomes: SweepBatchResult["outcomes"] = {};

  for (const reviewId of ids) {
    try {
      const result = await publishReview(reviewId, { actor: "system-auto-publish" });
      tally(outcomes, result.outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("Auto-publish sweep skipped a review it could not claim", { reviewId, error: message });
      tally(outcomes, "skipped");
    }
  }

  log.info("Auto-publish sweep complete", { scanned: ids.length, outcomes });
  return { scanned: ids.length, outcomes };
}

/**
 * Finds PUBLISH_PENDING rows whose claim looks abandoned (untouched for
 * `olderThanMs`), force-reclaims each one, and resolves it the same way
 * `publishReview`'s own crash-recovery path does: ask Google what the
 * review's live reply actually is before writing anything, via
 * `finalizeClaimedPublish` — the exact function `publishReview` itself calls
 * after its own claim succeeds, so a swept row is resolved with identical
 * logic to a normally-retried one, not a parallel reimplementation of it.
 *
 * `claimStalePublishPendingReview` returns `null` for a candidate this run
 * loses the claim race for (another sweep tick, or a normal retry, already
 * resolved it) — that candidate is silently skipped, not counted as
 * `reclaimed`.
 */
export async function recoverStalePublishPendingReviews(
  olderThanMs: number = defaultStalePublishPendingMs(),
  limit = DEFAULT_BATCH_LIMIT,
): Promise<StaleSweepResult> {
  const candidateIds = await findStalePublishPendingReviewIds(olderThanMs, limit);
  const outcomes: SweepBatchResult["outcomes"] = {};
  let reclaimed = 0;

  for (const reviewId of candidateIds) {
    const claimed = await claimStalePublishPendingReview(reviewId, olderThanMs);
    if (!claimed) continue;

    reclaimed += 1;
    log.warn("Sweep force-reclaimed a stale PUBLISH_PENDING review", { reviewId });

    try {
      const result = await finalizeClaimedPublish(claimed, "system-sweep");
      tally(outcomes, result.outcome);
    } catch (error) {
      // A row this run force-reclaimed can still be genuinely in flight under
      // an original caller that simply hasn't finished retrying yet (see the
      // staleness-threshold-vs-Google-retry-budget analysis this function's
      // doc comment doesn't cover, but the phase report does). If that
      // original call's own markPublished/markPublishFailed lands first, this
      // run's write loses its `WHERE google_reply_state = 'PUBLISH_PENDING'`
      // race and throws ConflictError from inside finalizeClaimedPublish's own
      // catch — a genuine double-claim, not a bug in the row's data. One
      // review racing like this must not abort the rest of the batch, the
      // same principle publishEligibleGeneratedReviews already applies to a
      // lost claim race there.
      const message = error instanceof Error ? error.message : String(error);
      log.warn("Sweep's reclaim of a stale review lost a race with the original in-flight attempt", {
        reviewId,
        error: message,
      });
      tally(outcomes, "skipped");
    }
  }

  log.info("Stale PUBLISH_PENDING sweep complete", { scanned: candidateIds.length, reclaimed, outcomes });
  return { scanned: candidateIds.length, reclaimed, outcomes };
}

export interface BackgroundSweepResult {
  stalePublishPending: StaleSweepResult;
  autoPublish: SweepBatchResult;
}

/**
 * One tick of the background sweep. Stale-row recovery runs first so a
 * review stuck from a previous crash is freed before this tick also looks
 * for newly-eligible GENERATED reviews — not load-bearing (the two passes
 * touch disjoint rows, since a GENERATED review's `google_reply_state` is
 * never PUBLISH_PENDING), just the more intuitive order to read in logs.
 */
export async function runBackgroundSweep(): Promise<BackgroundSweepResult> {
  const stalePublishPending = await recoverStalePublishPendingReviews();
  const autoPublish = await publishEligibleGeneratedReviews();
  return { stalePublishPending, autoPublish };
}
