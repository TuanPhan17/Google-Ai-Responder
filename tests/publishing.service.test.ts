import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";
import { BadRequestError, ConflictError } from "@/utils/errors";
import type { ReviewRow } from "@/database/repositories/review.repository";
import type { GoogleReview } from "@/schemas/google";

const findReviewById = vi.fn();
const claimReviewForPublishing = vi.fn();
const markPublished = vi.fn();
const markPublishFailed = vi.fn();
const markPublishBlockedByExistingReply = vi.fn();
const recordEvent = vi.fn();

vi.mock("@/database/repositories/review.repository", () => ({
  findReviewById: (...args: unknown[]) => findReviewById(...args),
  claimReviewForPublishing: (...args: unknown[]) => claimReviewForPublishing(...args),
  markPublished: (...args: unknown[]) => markPublished(...args),
  markPublishFailed: (...args: unknown[]) => markPublishFailed(...args),
  markPublishBlockedByExistingReply: (...args: unknown[]) => markPublishBlockedByExistingReply(...args),
  recordEvent: (...args: unknown[]) => recordEvent(...args),
}));

const getReview = vi.fn();
const updateReply = vi.fn();
const getReviewSource = vi.fn(() => ({ kind: "mock" as const, getReview, updateReply, listAccounts: vi.fn(), listLocations: vi.fn(), listReviews: vi.fn() }));

vi.mock("@/reviews/review-source", () => ({
  getReviewSource: (...args: unknown[]) => getReviewSource(...(args as [])),
}));

function reviewRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: "review-1",
    location_id: "location-1",
    google_review_id: "rev-001",
    google_review_name: "accounts/1/locations/1/reviews/rev-001",
    google_account_id: "1",
    google_location_id: "1",
    location_title: "Riverside Auto",
    reviewer_name: "Sarah Whitfield",
    reviewer_is_anonymous: false,
    rating: 5,
    review_text: "Fast, friendly, and fair pricing.",
    review_created_at: "2026-01-01T00:00:00Z",
    review_updated_at: "2026-01-01T00:00:00Z",
    is_edited: false,
    edit_count: 0,
    status: "APPROVED",
    google_reply_state: "NONE",
    existing_google_reply: null,
    existing_reply_updated_at: null,
    ai_response: "Thanks so much for the kind words!",
    final_response: "Thanks so much for the kind words!",
    sentiment: "positive",
    risk_level: "low",
    needs_human_review: false,
    human_review_required: false,
    ai_reason: "clean",
    referenced_details: [],
    ai_model: "gpt-4o-mini",
    publish_decision: "REQUIRE_APPROVAL",
    publish_decision_reason: "rating_requires_approval",
    processing_attempts: 1,
    last_error: null,
    published_at: null,
    published_by: null,
    approved_at: "2026-01-02T00:00:00Z",
    approved_by: "jane",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function googleReview(overrides: Partial<GoogleReview> = {}): GoogleReview {
  return {
    reviewId: "rev-001",
    starRating: "FIVE",
    comment: "Fast, friendly, and fair pricing.",
    createTime: "2026-01-01T00:00:00Z",
    updateTime: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-placeholder-value";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.ADMIN_PASSWORD = "console-password-example";
  process.env.MOCK_MODE = "true";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  resetEnvCache();

  findReviewById.mockReset();
  claimReviewForPublishing.mockReset();
  markPublished.mockReset();
  markPublishFailed.mockReset();
  markPublishBlockedByExistingReply.mockReset();
  recordEvent.mockReset();
  getReview.mockReset();
  updateReply.mockReset();
  getReviewSource.mockClear();

  markPublished.mockImplementation(async () => reviewRow({ status: "PUBLISHED" }));
  markPublishFailed.mockImplementation(async () => reviewRow({ google_reply_state: "PUBLISH_FAILED" }));
  markPublishBlockedByExistingReply.mockImplementation(async () =>
    reviewRow({ status: "PENDING_APPROVAL", google_reply_state: "EXISTING_REPLY_FOUND" }),
  );
});

describe("publishReview", () => {
  it("publishes an APPROVED review: claims it, checks Google live, posts the reply, and records published_at", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED" }));
    claimReviewForPublishing.mockResolvedValue(reviewRow({ status: "APPROVED", google_reply_state: "PUBLISH_PENDING" }));
    getReview.mockResolvedValue(googleReview()); // no reviewReply yet
    updateReply.mockResolvedValue({ comment: "Thanks so much for the kind words!", updateTime: "2026-08-20T00:00:00Z" });

    const { publishReview } = await import("@/reviews/publishing.service");
    const result = await publishReview("review-1", { actor: "jane" });

    expect(claimReviewForPublishing).toHaveBeenCalledWith("review-1", ["APPROVED", "GENERATED"]);
    expect(updateReply).toHaveBeenCalledWith("1", "1", "rev-001", "Thanks so much for the kind words!");
    expect(markPublished).toHaveBeenCalledWith(
      "review-1",
      expect.objectContaining({ finalResponse: "Thanks so much for the kind words!", publishedBy: "jane" }),
    );
    expect(result).toMatchObject({ outcome: "published", recovered: false });

    const events = recordEvent.mock.calls.map((call) => [call[1], call[3]]);
    expect(events).toEqual([["RESPONSE_PUBLISHED", "jane"]]);
  });

  it("publishes a GENERATED (auto-publish) review using the AI draft, since no human ever set final_response", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "GENERATED", final_response: null, approved_by: null, approved_at: null }));
    claimReviewForPublishing.mockResolvedValue(
      reviewRow({ status: "GENERATED", final_response: null, google_reply_state: "PUBLISH_PENDING" }),
    );
    getReview.mockResolvedValue(googleReview());
    updateReply.mockResolvedValue({ comment: "Thanks so much for the kind words!", updateTime: null });

    const { publishReview } = await import("@/reviews/publishing.service");
    const result = await publishReview("review-1");

    expect(updateReply).toHaveBeenCalledWith("1", "1", "rev-001", "Thanks so much for the kind words!");
    expect(markPublished).toHaveBeenCalledWith("review-1", expect.objectContaining({ publishedBy: "auto" }));
    expect(result).toMatchObject({ outcome: "published", recovered: false });
  });

  it("refuses to publish a review that was never approved or auto-publish-eligible", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "PENDING_APPROVAL" }));

    const { publishReview } = await import("@/reviews/publishing.service");
    await expect(publishReview("review-1")).rejects.toThrow(BadRequestError);
    expect(claimReviewForPublishing).not.toHaveBeenCalled();
  });

  it("throws when the review does not exist", async () => {
    findReviewById.mockResolvedValue(null);

    const { publishReview } = await import("@/reviews/publishing.service");
    await expect(publishReview("missing")).rejects.toThrow(BadRequestError);
  });

  it("re-checks state atomically right before calling Google: a review unapproved after the initial read is never published", async () => {
    // The read the caller (and this function's own pre-check) saw says
    // APPROVED — but by the time the atomic claim runs, someone has
    // unapproved it. This is the exact race requirement: the claim, not the
    // earlier read, is what decides eligibility.
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED" }));
    claimReviewForPublishing.mockRejectedValue(
      new ConflictError("Cannot claim the review for publishing.", { reviewId: "review-1" }),
    );

    const { publishReview } = await import("@/reviews/publishing.service");
    await expect(publishReview("review-1")).rejects.toThrow(ConflictError);

    expect(getReview).not.toHaveBeenCalled();
    expect(updateReply).not.toHaveBeenCalled();
  });

  it("never overwrites a different reply already on Google, and routes the review back to PENDING_APPROVAL", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED" }));
    claimReviewForPublishing.mockResolvedValue(reviewRow({ status: "APPROVED", google_reply_state: "PUBLISH_PENDING" }));
    getReview.mockResolvedValue(
      googleReview({ reviewReply: { comment: "A human already replied through Google directly.", updateTime: "2026-08-19T00:00:00Z" } }),
    );

    const { publishReview } = await import("@/reviews/publishing.service");
    const result = await publishReview("review-1", { actor: "jane" });

    expect(updateReply).not.toHaveBeenCalled();
    expect(markPublished).not.toHaveBeenCalled();
    expect(markPublishBlockedByExistingReply).toHaveBeenCalledWith("review-1", {
      existingReply: "A human already replied through Google directly.",
      existingReplyUpdateTime: "2026-08-19T00:00:00Z",
    });
    expect(result).toEqual({ outcome: "blocked_existing_reply" });

    const events = recordEvent.mock.calls.map((call) => [call[1], call[3]]);
    expect(events).toEqual([["PUBLISH_FAILED", "jane"]]);
  });

  it("recovers without re-posting when Google already shows exactly the reply this attempt intended to publish", async () => {
    // Simulates the double-reply scenario: a previous attempt's call to
    // Google succeeded, but the process never got to record published_at.
    // This retry must detect that and finish the bookkeeping, not call
    // updateReply a second time.
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED" }));
    claimReviewForPublishing.mockResolvedValue(reviewRow({ status: "APPROVED", google_reply_state: "PUBLISH_PENDING" }));
    getReview.mockResolvedValue(
      googleReview({ reviewReply: { comment: "Thanks so much for the kind words!", updateTime: "2026-08-20T00:00:00Z" } }),
    );

    const { publishReview } = await import("@/reviews/publishing.service");
    const result = await publishReview("review-1", { actor: "jane" });

    expect(updateReply).not.toHaveBeenCalled();
    expect(markPublished).toHaveBeenCalledWith(
      "review-1",
      expect.objectContaining({ finalResponse: "Thanks so much for the kind words!", publishedBy: "jane" }),
    );
    expect(result).toMatchObject({ outcome: "published", recovered: true });

    const events = recordEvent.mock.calls.map((call) => [call[1], call[3]]);
    expect(events).toEqual([["RESPONSE_PUBLISHED", "jane"]]);
  });

  it("marks the attempt publish-failed and leaves it retryable when the Google call itself fails", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED" }));
    claimReviewForPublishing.mockResolvedValue(reviewRow({ status: "APPROVED", google_reply_state: "PUBLISH_PENDING" }));
    getReview.mockResolvedValue(googleReview());
    updateReply.mockRejectedValue(new Error("Google returned HTTP 503."));

    const { publishReview } = await import("@/reviews/publishing.service");
    const result = await publishReview("review-1", { actor: "jane" });

    expect(markPublished).not.toHaveBeenCalled();
    expect(markPublishFailed).toHaveBeenCalledWith("review-1", "Google returned HTTP 503.");
    expect(result).toEqual({ outcome: "failed", error: "Google returned HTTP 503." });

    const events = recordEvent.mock.calls.map((call) => [call[1], call[3]]);
    expect(events).toEqual([["PUBLISH_FAILED", "jane"]]);
  });

  it("marks publish-failed (and stays retryable) when the live Google read itself fails", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED" }));
    claimReviewForPublishing.mockResolvedValue(reviewRow({ status: "APPROVED", google_reply_state: "PUBLISH_PENDING" }));
    getReview.mockRejectedValue(new Error("Google returned HTTP 500."));

    const { publishReview } = await import("@/reviews/publishing.service");
    const result = await publishReview("review-1");

    expect(updateReply).not.toHaveBeenCalled();
    expect(markPublishFailed).toHaveBeenCalledWith("review-1", "Google returned HTTP 500.");
    expect(result).toEqual({ outcome: "failed", error: "Google returned HTTP 500." });
  });

  it("if the post-publish database write itself throws, the failure is recorded as retryable rather than left unresolved", async () => {
    // This models the other half of the double-reply question: Google's call
    // succeeded (updateReply resolves), but markPublished — the write that
    // records it — throws. The function must not crash uncaught; it must
    // fall into the same publish-failed bookkeeping so a later retry can
    // self-heal via the "matches what's already on Google" recovery path.
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED" }));
    claimReviewForPublishing.mockResolvedValue(reviewRow({ status: "APPROVED", google_reply_state: "PUBLISH_PENDING" }));
    getReview.mockResolvedValue(googleReview());
    updateReply.mockResolvedValue({ comment: "Thanks so much for the kind words!", updateTime: null });
    markPublished.mockRejectedValueOnce(new Error("Supabase write timed out."));

    const { publishReview } = await import("@/reviews/publishing.service");
    const result = await publishReview("review-1", { actor: "jane" });

    expect(updateReply).toHaveBeenCalledTimes(1);
    expect(markPublishFailed).toHaveBeenCalledWith("review-1", "Supabase write timed out.");
    expect(result).toEqual({ outcome: "failed", error: "Supabase write timed out." });
  });

  it("falls back to 'unknown' for published_by if an APPROVED review somehow has no approved_by recorded", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED", approved_by: null }));
    claimReviewForPublishing.mockResolvedValue(
      reviewRow({ status: "APPROVED", approved_by: null, google_reply_state: "PUBLISH_PENDING" }),
    );
    getReview.mockResolvedValue(googleReview());
    updateReply.mockResolvedValue({ comment: "Thanks so much for the kind words!", updateTime: null });

    const { publishReview } = await import("@/reviews/publishing.service");
    await publishReview("review-1");

    expect(markPublished).toHaveBeenCalledWith("review-1", expect.objectContaining({ publishedBy: "unknown" }));
  });

  it("fails cleanly (without calling Google) when a claimed review somehow has no response text at all", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "GENERATED" }));
    claimReviewForPublishing.mockResolvedValue(
      reviewRow({ status: "GENERATED", final_response: null, ai_response: null, google_reply_state: "PUBLISH_PENDING" }),
    );

    const { publishReview } = await import("@/reviews/publishing.service");
    const result = await publishReview("review-1");

    expect(getReview).not.toHaveBeenCalled();
    expect(markPublishFailed).toHaveBeenCalledWith("review-1", "No generated response text was available to publish.");
    expect(result).toEqual({ outcome: "failed", error: "No generated response text was available to publish." });
  });
});
