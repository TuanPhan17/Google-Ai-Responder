import {
  findReviewById,
  markProcessing,
  markProcessingFailed,
  recordEvent,
  saveGeneratedResponse,
  type ReviewRow,
} from "@/database/repositories/review.repository";
import { getEnv } from "@/config/env";
import { extractFirstName } from "@/reviews/mapper";
import { generateReviewResponse } from "@/openai/review-response.service";
import { evaluateReviewForPublishing } from "@/policies/evaluate-review";
import { BadRequestError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { NormalizedReview, ReviewStatus, PublishDecision } from "@/types/review";
import type { BusinessContext, PublishingSettings } from "@/types/business";

const log = logger.child("reviews.processing");

/**
 * Drives a stored review from RECEIVED through generation to a final
 * processing state — AI output persistence, processing states, and audit
 * logging, per docs/SPEC.md Phase 4.
 *
 * ## Idempotency
 *
 * This adds a fourth layer on top of the three ingest.service.ts already
 * documents: **only a review in RECEIVED status is eligible.** A review that
 * is already PROCESSING, GENERATED, PENDING_APPROVAL, PUBLISHED, etc. is left
 * untouched — a replayed trigger cannot regenerate a response that already
 * exists, and cannot walk a review backwards through the state machine.
 * Re-running generation on a non-RECEIVED review is an explicit "regenerate"
 * action (Phase 5), not something this function does on its own. An edit
 * (ingest.service.ts's applyReviewEdit) is what legitimately resets status
 * back to RECEIVED, which is what makes a review eligible again.
 *
 * Concurrent calls for the same review can still race between the initial
 * status read and the PROCESSING write — the same single-writer assumption
 * the rest of this codebase makes elsewhere (see the token-refresh
 * singleflight note in src/auth). Recovering a review stuck in PROCESSING
 * from a crash mid-run is a Phase 7 concern, not this one.
 *
 * `business` and `settings` default to `null`: Settings management (Phase 8)
 * does not exist yet, so by default there is nothing to read, and both
 * generateReviewResponse and evaluateReviewForPublishing already treat `null`
 * as their safe default (no auto-publish at all until a business explicitly
 * opts in). They're accepted as parameters — not hardcoded — so Phase 8 can
 * pass real values from its own repository later without any change here.
 */

export interface ProcessReviewOptions {
  actor?: string;
  business?: BusinessContext | null;
  settings?: PublishingSettings | null;
}

export type ProcessReviewOutcome =
  | { outcome: "skipped"; reason: "not_in_received_state"; status: ReviewStatus }
  | { outcome: "generated"; status: ReviewStatus; decision: PublishDecision }
  | { outcome: "failed"; error: string };

export async function processReview(
  reviewId: string,
  options: ProcessReviewOptions = {},
): Promise<ProcessReviewOutcome> {
  const actor = options.actor ?? "system";
  const business = options.business ?? null;
  const settings = options.settings ?? null;

  const review = await findReviewById(reviewId);
  if (!review) throw new BadRequestError("No review with that id.", { reviewId });

  if (review.status !== "RECEIVED") {
    log.debug("Skipped: review is not in RECEIVED state", { reviewId, status: review.status });
    return { outcome: "skipped", reason: "not_in_received_state", status: review.status };
  }

  const processing = await markProcessing(reviewId, review.processing_attempts + 1);
  await recordEvent(reviewId, "AI_GENERATION_STARTED", { attempt: processing.processing_attempts }, actor);

  const normalizedReview = toNormalizedReview(processing);

  try {
    const aiOutput = await generateReviewResponse({ review: normalizedReview, business });

    const evaluation = evaluateReviewForPublishing({
      rating: normalizedReview.rating,
      reviewText: normalizedReview.reviewText,
      hasExistingGoogleReply: processing.google_reply_state !== "NONE",
      aiOutput: { riskLevel: aiOutput.riskLevel, needsHumanReview: aiOutput.needsHumanReview },
      settings,
    });

    const status: ReviewStatus = evaluation.decision === "AUTO_PUBLISH" ? "GENERATED" : "PENDING_APPROVAL";

    await saveGeneratedResponse(reviewId, {
      aiResponse: aiOutput.reply,
      sentiment: aiOutput.sentiment,
      riskLevel: evaluation.riskLevel,
      needsHumanReview: evaluation.needsHumanReview,
      aiReason: aiOutput.reason,
      referencedDetails: aiOutput.referencedDetails,
      aiModel: getEnv().OPENAI_MODEL,
      publishDecision: evaluation.decision,
      publishDecisionReason: evaluation.reasons.join(","),
      status,
    });

    await recordEvent(
      reviewId,
      "AI_GENERATION_COMPLETED",
      {
        sentiment: aiOutput.sentiment,
        riskLevel: evaluation.riskLevel,
        needsHumanReview: evaluation.needsHumanReview,
        // Which deterministic categories fired, if any — not the review text itself.
        keywordCategories: evaluation.keywordMatches.map((m) => m.category),
      },
      actor,
    );

    await recordEvent(
      reviewId,
      "AUTO_PUBLISH_DECISION",
      { decision: evaluation.decision, reasons: evaluation.reasons },
      actor,
    );

    log.info("Review processed", { reviewId, decision: evaluation.decision, status });
    return { outcome: "generated", status, decision: evaluation.decision };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await markProcessingFailed(reviewId, message);
    await recordEvent(reviewId, "AI_GENERATION_FAILED", { error: message }, actor);

    log.error("Review processing failed", { reviewId, error: message });
    return { outcome: "failed", error: message };
  }
}

function toNormalizedReview(row: ReviewRow): NormalizedReview {
  return {
    googleReviewId: row.google_review_id,
    googleReviewName:
      row.google_review_name ??
      `accounts/${row.google_account_id}/locations/${row.google_location_id}/reviews/${row.google_review_id}`,
    googleAccountId: row.google_account_id,
    googleLocationId: row.google_location_id,
    locationTitle: row.location_title,
    reviewerName: row.reviewer_name,
    reviewerFirstName: row.reviewer_is_anonymous ? null : extractFirstName(row.reviewer_name ?? undefined),
    reviewerIsAnonymous: row.reviewer_is_anonymous,
    rating: row.rating,
    reviewText: row.review_text,
    reviewCreateTime: row.review_created_at,
    reviewUpdateTime: row.review_updated_at,
    existingReplyText: row.existing_google_reply,
    existingReplyUpdateTime: row.existing_reply_updated_at,
  };
}
