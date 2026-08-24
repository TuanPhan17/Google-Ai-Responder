import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";
import { ConflictError } from "@/utils/errors";
import type { ReviewRow } from "@/database/repositories/review.repository";
import type { GoogleReview } from "@/schemas/google";

const findAutoPublishEligibleReviewIds = vi.fn();
const findStalePublishPendingReviewIds = vi.fn();
const claimStalePublishPendingReview = vi.fn();
const markPublished = vi.fn();
const markPublishFailed = vi.fn();
const markPublishBlockedByExistingReply = vi.fn();
const recordEvent = vi.fn();

vi.mock("@/database/repositories/review.repository", () => ({
  findAutoPublishEligibleReviewIds: (...args: unknown[]) => findAutoPublishEligibleReviewIds(...args),
  findStalePublishPendingReviewIds: (...args: unknown[]) => findStalePublishPendingReviewIds(...args),
  claimStalePublishPendingReview: (...args: unknown[]) => claimStalePublishPendingReview(...args),
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

// `publishReview` is mocked (it's exercised in full by publishing.service.test.ts); `finalizeClaimedPublish`
// is left real so the sweep's stale-row recovery path exercises the exact same logic publishReview itself
// uses after a normal claim, per sweep.service.ts's doc comment.
const publishReview = vi.fn();

vi.mock("@/reviews/publishing.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/reviews/publishing.service")>();
  return {
    ...actual,
    publishReview: (...args: unknown[]) => publishReview(...args),
  };
});

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
    status: "GENERATED",
    google_reply_state: "PUBLISH_PENDING",
    existing_google_reply: null,
    existing_reply_updated_at: null,
    ai_response: "Thanks so much for the kind words!",
    final_response: null,
    sentiment: "positive",
    risk_level: "low",
    needs_human_review: false,
    human_review_required: false,
    ai_reason: "clean",
    referenced_details: [],
    ai_model: "gpt-4o-mini",
    publish_decision: "AUTO_PUBLISH",
    publish_decision_reason: "clean_5_star",
    processing_attempts: 1,
    last_error: null,
    published_at: null,
    published_by: null,
    approved_at: null,
    approved_by: null,
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
  delete process.env.GOOGLE_API_TIMEOUT_MS;
  delete process.env.GOOGLE_API_MAX_ATTEMPTS;
  // Off by default in this file so the existing sweep-mechanics tests below
  // (claim races, batch tallying, limits) keep exercising the underlying
  // auto-publish engine, same as before REQUIRE_APPROVAL_FOR_ALL existed.
  // The one test that needs the shipped default (true) sets it explicitly.
  process.env.REQUIRE_APPROVAL_FOR_ALL = "false";
  resetEnvCache();

  findAutoPublishEligibleReviewIds.mockReset();
  findStalePublishPendingReviewIds.mockReset();
  claimStalePublishPendingReview.mockReset();
  markPublished.mockReset();
  markPublishFailed.mockReset();
  markPublishBlockedByExistingReply.mockReset();
  recordEvent.mockReset();
  getReview.mockReset();
  updateReply.mockReset();
  getReviewSource.mockClear();
  publishReview.mockReset();

  markPublished.mockImplementation(async () => reviewRow({ status: "PUBLISHED" }));
  markPublishFailed.mockImplementation(async () => reviewRow({ google_reply_state: "PUBLISH_FAILED" }));
  markPublishBlockedByExistingReply.mockImplementation(async () =>
    reviewRow({ status: "PENDING_APPROVAL", google_reply_state: "EXISTING_REPLY_FOUND" }),
  );
});

describe("publishEligibleGeneratedReviews", () => {
  it("calls publishReview for every eligible id and tallies the outcomes", async () => {
    findAutoPublishEligibleReviewIds.mockResolvedValue(["review-1", "review-2"]);
    publishReview.mockImplementation(async (reviewId: string) =>
      reviewId === "review-1"
        ? { outcome: "published", publishedAt: "2026-08-23T00:00:00Z", recovered: false }
        : { outcome: "blocked_existing_reply" },
    );

    const { publishEligibleGeneratedReviews } = await import("@/reviews/sweep.service");
    const result = await publishEligibleGeneratedReviews();

    expect(publishReview).toHaveBeenCalledWith("review-1", { actor: "system-auto-publish" });
    expect(publishReview).toHaveBeenCalledWith("review-2", { actor: "system-auto-publish" });
    expect(result).toEqual({
      scanned: 2,
      outcomes: { published: 1, blocked_existing_reply: 1 },
    });
  });

  it("counts a lost claim race as skipped instead of failing the whole batch", async () => {
    findAutoPublishEligibleReviewIds.mockResolvedValue(["review-1", "review-2"]);
    publishReview.mockImplementation(async (reviewId: string) => {
      if (reviewId === "review-1") {
        throw new ConflictError("Cannot claim the review for publishing.", { reviewId });
      }
      return { outcome: "published", publishedAt: "2026-08-23T00:00:00Z", recovered: false };
    });

    const { publishEligibleGeneratedReviews } = await import("@/reviews/sweep.service");
    const result = await publishEligibleGeneratedReviews();

    expect(result).toEqual({ scanned: 2, outcomes: { skipped: 1, published: 1 } });
  });

  it("does nothing when there are no eligible reviews", async () => {
    findAutoPublishEligibleReviewIds.mockResolvedValue([]);

    const { publishEligibleGeneratedReviews } = await import("@/reviews/sweep.service");
    const result = await publishEligibleGeneratedReviews();

    expect(publishReview).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, outcomes: {} });
  });

  it("passes a caller-supplied limit through to the candidate lookup", async () => {
    findAutoPublishEligibleReviewIds.mockResolvedValue([]);

    const { publishEligibleGeneratedReviews } = await import("@/reviews/sweep.service");
    await publishEligibleGeneratedReviews(5);

    expect(findAutoPublishEligibleReviewIds).toHaveBeenCalledWith(5);
  });

  // Product decision: every review requires human approval before
  // publishing (REQUIRE_APPROVAL_FOR_ALL, default true — src/config/env.ts).
  // With it on, GENERATED rows can't be created by the normal pipeline any
  // more, but this function checks the flag directly rather than relying on
  // that emergent behavior — see its doc comment for why (a stale GENERATED
  // row left over from before the flag was turned on). Proves the guard
  // short-circuits before even querying the repository.
  it("finds nothing eligible, without querying, when REQUIRE_APPROVAL_FOR_ALL is on (the shipped default)", async () => {
    process.env.REQUIRE_APPROVAL_FOR_ALL = "true";
    resetEnvCache();

    const { publishEligibleGeneratedReviews } = await import("@/reviews/sweep.service");
    const result = await publishEligibleGeneratedReviews();

    expect(findAutoPublishEligibleReviewIds).not.toHaveBeenCalled();
    expect(publishReview).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, outcomes: {} });
  });
});

describe("recoverStalePublishPendingReviews", () => {
  it("force-reclaims a stale row and resolves it via the same live-Google-check path an ordinary retry uses", async () => {
    findStalePublishPendingReviewIds.mockResolvedValue(["review-1"]);
    claimStalePublishPendingReview.mockResolvedValue(
      reviewRow({ status: "GENERATED", ai_response: "Thanks so much for the kind words!", final_response: null }),
    );
    getReview.mockResolvedValue(googleReview()); // no reply on Google yet
    updateReply.mockResolvedValue({ comment: "Thanks so much for the kind words!", updateTime: "2026-08-23T00:00:00Z" });

    const { recoverStalePublishPendingReviews } = await import("@/reviews/sweep.service");
    const result = await recoverStalePublishPendingReviews();

    expect(updateReply).toHaveBeenCalledWith("1", "1", "rev-001", "Thanks so much for the kind words!");
    expect(markPublished).toHaveBeenCalledWith(
      "review-1",
      expect.objectContaining({ finalResponse: "Thanks so much for the kind words!", publishedBy: "auto" }),
    );
    expect(recordEvent).toHaveBeenCalledWith("review-1", "RESPONSE_PUBLISHED", { recovered: false }, "system-sweep");
    expect(result).toEqual({ scanned: 1, reclaimed: 1, outcomes: { published: 1 } });
  });

  // A human-approved review can get stuck at PUBLISH_PENDING exactly the same
  // way a GENERATED one can (approved, claimed, then the process died before
  // recording published_at — see publishing.service.ts's module doc comment).
  // The sweep's recovery path must credit the human who approved it, not
  // "auto" — proves published_by survives the force-reclaim path, not just
  // the ordinary publishReview one.
  it("credits the approving human, not 'auto', when the sweep recovers a stuck APPROVED publish", async () => {
    findStalePublishPendingReviewIds.mockResolvedValue(["review-1"]);
    claimStalePublishPendingReview.mockResolvedValue(
      reviewRow({
        status: "APPROVED",
        final_response: "Thanks so much for the kind words!",
        approved_by: "jane",
      }),
    );
    getReview.mockResolvedValue(googleReview());
    updateReply.mockResolvedValue({ comment: "Thanks so much for the kind words!", updateTime: "2026-08-23T00:00:00Z" });

    const { recoverStalePublishPendingReviews } = await import("@/reviews/sweep.service");
    await recoverStalePublishPendingReviews();

    expect(markPublished).toHaveBeenCalledWith("review-1", expect.objectContaining({ publishedBy: "jane" }));
  });

  it("recovers without reposting when Google already shows the exact reply — proof the earlier, crashed attempt's write succeeded", async () => {
    findStalePublishPendingReviewIds.mockResolvedValue(["review-1"]);
    claimStalePublishPendingReview.mockResolvedValue(
      reviewRow({ status: "GENERATED", ai_response: "Thanks so much for the kind words!", final_response: null }),
    );
    getReview.mockResolvedValue(
      googleReview({ reviewReply: { comment: "Thanks so much for the kind words!", updateTime: "2026-08-22T00:00:00Z" } }),
    );

    const { recoverStalePublishPendingReviews } = await import("@/reviews/sweep.service");
    const result = await recoverStalePublishPendingReviews();

    expect(updateReply).not.toHaveBeenCalled();
    expect(markPublished).toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, reclaimed: 1, outcomes: { published: 1 } });
  });

  it("skips a candidate another sweep tick (or an ordinary retry) already resolved, without calling Google", async () => {
    findStalePublishPendingReviewIds.mockResolvedValue(["review-1"]);
    claimStalePublishPendingReview.mockResolvedValue(null);

    const { recoverStalePublishPendingReviews } = await import("@/reviews/sweep.service");
    const result = await recoverStalePublishPendingReviews();

    expect(getReviewSource).not.toHaveBeenCalled();
    expect(markPublished).not.toHaveBeenCalled();
    expect(markPublishFailed).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, reclaimed: 0, outcomes: {} });
  });

  it("passes the same staleness threshold to both the candidate lookup and each claim attempt", async () => {
    findStalePublishPendingReviewIds.mockResolvedValue(["review-1"]);
    claimStalePublishPendingReview.mockResolvedValue(null);

    const { recoverStalePublishPendingReviews } = await import("@/reviews/sweep.service");
    await recoverStalePublishPendingReviews(10 * 60 * 1000, 5);

    expect(findStalePublishPendingReviewIds).toHaveBeenCalledWith(10 * 60 * 1000, 5);
    expect(claimStalePublishPendingReview).toHaveBeenCalledWith("review-1", 10 * 60 * 1000);
  });

  it("derives the default staleness threshold from the Google retry budget, not a flat guess", async () => {
    process.env.GOOGLE_API_TIMEOUT_MS = "30000";
    process.env.GOOGLE_API_MAX_ATTEMPTS = "5";
    resetEnvCache();

    findStalePublishPendingReviewIds.mockResolvedValue([]);

    const { recoverStalePublishPendingReviews } = await import("@/reviews/sweep.service");
    await recoverStalePublishPendingReviews();

    // 30000 * 5 * 2 (two sequential Google calls) + 5-minute safety margin.
    const expectedThreshold = 30_000 * 5 * 2 + 5 * 60 * 1000;
    expect(findStalePublishPendingReviewIds).toHaveBeenCalledWith(expectedThreshold, expect.any(Number));
  });

  it("catches a double-claim race (the original in-flight caller and this sweep both resolving the same row) instead of aborting the batch", async () => {
    // finalizeClaimedPublish only throws uncaught when its own catch block's
    // markPublishFailed *also* loses its WHERE-clause race — the scenario
    // where the row was never actually abandoned, just claimed by two
    // writers at once. One review hitting this must not stop the rest of
    // the sweep batch from running.
    findStalePublishPendingReviewIds.mockResolvedValue(["review-1", "review-2"]);
    claimStalePublishPendingReview.mockImplementation(async (reviewId: string) =>
      reviewRow({ id: reviewId, status: "GENERATED", ai_response: "Thanks so much for the kind words!", final_response: null }),
    );
    getReview.mockResolvedValue(googleReview());
    updateReply.mockResolvedValue({ comment: "Thanks so much for the kind words!", updateTime: "2026-08-23T00:00:00Z" });
    markPublished.mockRejectedValueOnce(new Error("Cannot mark the review published: status changed."));
    markPublishFailed.mockRejectedValueOnce(new Error("Cannot mark the review publish-failed: status changed."));

    const { recoverStalePublishPendingReviews } = await import("@/reviews/sweep.service");
    const result = await recoverStalePublishPendingReviews();

    expect(result.reclaimed).toBe(2);
    expect(result.outcomes).toEqual({ skipped: 1, published: 1 });
  });

  it("still tallies a failure (Google call throws) as failed rather than leaving the batch unresolved", async () => {
    findStalePublishPendingReviewIds.mockResolvedValue(["review-1"]);
    claimStalePublishPendingReview.mockResolvedValue(
      reviewRow({ status: "GENERATED", ai_response: "Thanks so much for the kind words!", final_response: null }),
    );
    getReview.mockRejectedValue(new Error("Google returned HTTP 500."));

    const { recoverStalePublishPendingReviews } = await import("@/reviews/sweep.service");
    const result = await recoverStalePublishPendingReviews();

    expect(markPublishFailed).toHaveBeenCalledWith("review-1", "Google returned HTTP 500.");
    expect(result).toEqual({ scanned: 1, reclaimed: 1, outcomes: { failed: 1 } });
  });
});

describe("runBackgroundSweep", () => {
  it("runs stale-row recovery before the auto-publish pass and reports both", async () => {
    findStalePublishPendingReviewIds.mockResolvedValue([]);
    findAutoPublishEligibleReviewIds.mockResolvedValue([]);

    const { runBackgroundSweep } = await import("@/reviews/sweep.service");
    const result = await runBackgroundSweep();

    expect(result).toEqual({
      stalePublishPending: { scanned: 0, reclaimed: 0, outcomes: {} },
      autoPublish: { scanned: 0, outcomes: {} },
    });
  });
});
