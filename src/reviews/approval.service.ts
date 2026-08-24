import {
  findReviewById,
  markApproved,
  markRejected,
  recordEvent,
  updateFinalResponse,
  type ReviewRow,
} from "@/database/repositories/review.repository";
import { runReviewGeneration, type ProcessReviewOutcome } from "@/reviews/processing.service";
import { BadRequestError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { ReviewStatus } from "@/types/review";
import type { BusinessContext, PublishingSettings } from "@/types/business";

const log = logger.child("reviews.approval");

/**
 * The pending-approval workflow: approve, edit, regenerate, reject — per
 * docs/SPEC.md Phase 5.
 *
 * None of these actions publish anything to Google; that is Phase 6. What
 * they do is move a review through its human-review lifecycle and leave a
 * complete audit trail behind (CLAUDE.md safety invariant: the model never has
 * final authority, and every safety-relevant action needs a test proving it).
 *
 * Each action is guarded by an explicit status allowlist rather than a single
 * "not terminal" check, so it's legible at a glance which states a given
 * action can start from.
 */

const APPROVABLE_STATUSES: ReviewStatus[] = ["GENERATED", "PENDING_APPROVAL"];
const REJECTABLE_STATUSES: ReviewStatus[] = ["GENERATED", "PENDING_APPROVAL", "FAILED"];
const EDITABLE_STATUSES: ReviewStatus[] = ["GENERATED", "PENDING_APPROVAL"];
const REGENERATABLE_STATUSES: ReviewStatus[] = ["GENERATED", "PENDING_APPROVAL", "FAILED"];

const DEFAULT_MAX_RESPONSE_CHARS = 2000;

function requireReview(review: ReviewRow | null, reviewId: string): ReviewRow {
  if (!review) throw new BadRequestError("No review with that id.", { reviewId });
  return review;
}

function assertStatus(review: ReviewRow, allowed: ReviewStatus[], action: string): void {
  if (!allowed.includes(review.status)) {
    throw new BadRequestError(`Cannot ${action} a review in status ${review.status}.`, {
      reviewId: review.id,
      status: review.status,
    });
  }
}

export interface ApproveReviewResult {
  review: ReviewRow;
}

/**
 * Approves whatever response is currently on the review — the human-edited
 * one if `editReviewResponse` has run, otherwise the AI draft as-is. Approving
 * is always a human action; it does not re-run the deterministic publishing
 * policy (that policy only governs *automatic* publishing, not an explicit
 * human sign-off), and it does not itself publish anything to Google.
 */
export async function approveReview(
  reviewId: string,
  options: { actor?: string } = {},
): Promise<ApproveReviewResult> {
  const actor = options.actor ?? "admin";

  const review = requireReview(await findReviewById(reviewId), reviewId);
  assertStatus(review, APPROVABLE_STATUSES, "approve");

  const finalResponse = review.final_response ?? review.ai_response;
  if (!finalResponse) {
    throw new BadRequestError("This review has no generated response to approve yet.", { reviewId });
  }

  const updated = await markApproved(reviewId, { finalResponse, approvedBy: actor });
  await recordEvent(
    reviewId,
    "APPROVED",
    { previousStatus: review.status, rating: review.rating, riskLevel: review.risk_level },
    actor,
  );

  log.info("Review approved", { reviewId, actor });
  return { review: updated };
}

export interface RejectReviewResult {
  review: ReviewRow;
}

/** Rejects a review: no response will be published for it. */
export async function rejectReview(
  reviewId: string,
  options: { actor?: string; reason?: string } = {},
): Promise<RejectReviewResult> {
  const actor = options.actor ?? "admin";

  const review = requireReview(await findReviewById(reviewId), reviewId);
  assertStatus(review, REJECTABLE_STATUSES, "reject");

  const updated = await markRejected(reviewId);
  await recordEvent(reviewId, "REJECTED", { previousStatus: review.status, reason: options.reason ?? null }, actor);

  log.info("Review rejected", { reviewId, actor });
  return { review: updated };
}

export interface EditReviewResponseResult {
  review: ReviewRow;
}

/**
 * Saves a human-edited draft in place of the AI's. Always leaves the review
 * PENDING_APPROVAL (see updateFinalResponse) — an edit is not itself an
 * approval, matching the dashboard's separate "Edit" and "Approve & Publish"
 * actions from docs/SPEC.md.
 */
export async function editReviewResponse(
  reviewId: string,
  responseText: string,
  options: { actor?: string; business?: BusinessContext | null } = {},
): Promise<EditReviewResponseResult> {
  const actor = options.actor ?? "admin";

  const review = requireReview(await findReviewById(reviewId), reviewId);
  assertStatus(review, EDITABLE_STATUSES, "edit");

  const trimmed = responseText.trim();
  if (trimmed.length === 0) {
    throw new BadRequestError("The edited response cannot be empty.", { reviewId });
  }

  const maxChars = options.business?.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
  if (trimmed.length > maxChars) {
    throw new BadRequestError(`The edited response cannot exceed ${maxChars} characters.`, {
      reviewId,
      length: trimmed.length,
      maxChars,
    });
  }

  const updated = await updateFinalResponse(reviewId, trimmed);
  await recordEvent(
    reviewId,
    "RESPONSE_EDITED_BY_HUMAN",
    { previousLength: (review.final_response ?? review.ai_response ?? "").length, newLength: trimmed.length },
    actor,
  );

  log.info("Review response edited", { reviewId, actor });
  return { review: updated };
}

export interface RegenerateReviewOptions {
  actor?: string;
  business?: BusinessContext | null;
  settings?: PublishingSettings | null;
}

/**
 * Discards the current AI draft and runs generation again through the same
 * pipeline `processReview` uses (see runReviewGeneration in
 * processing.service.ts), so a new response goes through the identical
 * AI-call → deterministic-evaluate → persist → audit sequence. Unlike
 * `processReview`, this is not restricted to RECEIVED — it exists precisely
 * for reviews already sitting in the approval queue, or reviews that
 * previously FAILED and need a retry.
 */
export async function regenerateReviewResponse(
  reviewId: string,
  options: RegenerateReviewOptions = {},
): Promise<ProcessReviewOutcome> {
  const actor = options.actor ?? "admin";
  const business = options.business ?? null;
  const settings = options.settings ?? null;

  const review = requireReview(await findReviewById(reviewId), reviewId);
  assertStatus(review, REGENERATABLE_STATUSES, "regenerate");

  await recordEvent(reviewId, "RESPONSE_REGENERATED", { previousStatus: review.status }, actor);

  const outcome = await runReviewGeneration(review, { actor, business, settings });
  log.info("Review response regenerated", { reviewId, actor });
  return outcome;
}
