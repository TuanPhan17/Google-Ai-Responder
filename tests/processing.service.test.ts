import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";
import { BadRequestError } from "@/utils/errors";
import type { ReviewRow } from "@/database/repositories/review.repository";

const findReviewById = vi.fn();
const markProcessing = vi.fn();
const saveGeneratedResponse = vi.fn();
const markProcessingFailed = vi.fn();
const recordEvent = vi.fn();

vi.mock("@/database/repositories/review.repository", () => ({
  findReviewById: (...args: unknown[]) => findReviewById(...args),
  markProcessing: (...args: unknown[]) => markProcessing(...args),
  saveGeneratedResponse: (...args: unknown[]) => saveGeneratedResponse(...args),
  markProcessingFailed: (...args: unknown[]) => markProcessingFailed(...args),
  recordEvent: (...args: unknown[]) => recordEvent(...args),
}));

const generateReviewResponse = vi.fn();
vi.mock("@/openai/review-response.service", () => ({
  generateReviewResponse: (...args: unknown[]) => generateReviewResponse(...args),
}));

const CLEAN_AI_OUTPUT = {
  reply: "Thanks so much for the kind words!",
  sentiment: "positive" as const,
  rating: 5,
  needsHumanReview: false,
  riskLevel: "low" as const,
  reason: "Positive review, no risk factors.",
  referencedDetails: ["fast service"],
};

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
    status: "RECEIVED",
    google_reply_state: "NONE",
    existing_google_reply: null,
    existing_reply_updated_at: null,
    ai_response: null,
    final_response: null,
    sentiment: null,
    risk_level: null,
    needs_human_review: null,
    human_review_required: false,
    ai_reason: null,
    referenced_details: [],
    ai_model: null,
    publish_decision: null,
    publish_decision_reason: null,
    processing_attempts: 0,
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

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-placeholder-value";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.ADMIN_PASSWORD = "console-password-example";
  process.env.MOCK_MODE = "true";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  // Reset to the production default (unset -> true) each test; the one test
  // that needs it off sets it explicitly for itself.
  delete process.env.REQUIRE_APPROVAL_FOR_ALL;
  resetEnvCache();

  findReviewById.mockReset();
  markProcessing.mockReset();
  saveGeneratedResponse.mockReset();
  markProcessingFailed.mockReset();
  recordEvent.mockReset();
  generateReviewResponse.mockReset();

  saveGeneratedResponse.mockImplementation(async () => reviewRow());
  markProcessingFailed.mockImplementation(async () => reviewRow({ status: "FAILED" }));
});

/**
 * Wires findReviewById and markProcessing to agree on the same stored row —
 * a real DB update+select returns every unchanged column, but a naive mock
 * that ignores its input would silently drop fields like review_text between
 * the two calls and produce a false negative on risk escalation.
 */
function mockStoredReview(row: ReviewRow) {
  findReviewById.mockResolvedValue(row);
  markProcessing.mockImplementation(async (_id: string, nextAttempt: number) => ({
    ...row,
    status: "PROCESSING" as const,
    processing_attempts: nextAttempt,
  }));
}

const PERMISSIVE_SETTINGS = { autoPublishFiveStar: true, autoPublishFourStar: true, minAutoPublishRating: 4 };

describe("processReview", () => {
  it("auto-publishes a genuinely clean 5-star review when settings allow it and REQUIRE_APPROVAL_FOR_ALL is off", async () => {
    process.env.REQUIRE_APPROVAL_FOR_ALL = "false";
    resetEnvCache();
    mockStoredReview(reviewRow());
    generateReviewResponse.mockResolvedValue(CLEAN_AI_OUTPUT);

    const { processReview } = await import("@/reviews/processing.service");
    const result = await processReview("review-1", { settings: PERMISSIVE_SETTINGS });

    expect(result).toEqual({ outcome: "generated", status: "GENERATED", decision: "AUTO_PUBLISH" });

    expect(markProcessing).toHaveBeenCalledWith("review-1", 1);

    const [, update] = saveGeneratedResponse.mock.calls[0] as [string, Record<string, unknown>];
    expect(update).toMatchObject({
      aiResponse: CLEAN_AI_OUTPUT.reply,
      sentiment: "positive",
      riskLevel: "low",
      needsHumanReview: false,
      aiModel: "gpt-4o-mini",
      publishDecision: "AUTO_PUBLISH",
      status: "GENERATED",
    });

    const events = recordEvent.mock.calls.map((call) => call[1]);
    expect(events).toEqual(["AI_GENERATION_STARTED", "AI_GENERATION_COMPLETED", "AUTO_PUBLISH_DECISION"]);
  });

  it("requires approval for a clean 5-star review when no settings are configured yet (Phase 8 not built)", async () => {
    // This is the real, current end-to-end behavior with no caller-supplied
    // settings: safe-by-default means nothing auto-publishes at all yet.
    mockStoredReview(reviewRow());
    generateReviewResponse.mockResolvedValue(CLEAN_AI_OUTPUT);

    const { processReview } = await import("@/reviews/processing.service");
    const result = await processReview("review-1");

    expect(result).toMatchObject({ status: "PENDING_APPROVAL", decision: "REQUIRE_APPROVAL" });
  });

  // Product decision: every review requires human approval before
  // publishing (REQUIRE_APPROVAL_FOR_ALL, default true — src/config/env.ts).
  // Unlike the test above, this one proves the blanket requirement holds
  // even when settings *would* otherwise allow auto-publishing — it isn't
  // just "no settings configured yet."
  it("still requires approval for a genuinely clean 5-star review even with fully permissive settings, because REQUIRE_APPROVAL_FOR_ALL defaults to true", async () => {
    mockStoredReview(reviewRow());
    generateReviewResponse.mockResolvedValue(CLEAN_AI_OUTPUT);

    const { processReview } = await import("@/reviews/processing.service");
    const result = await processReview("review-1", { settings: PERMISSIVE_SETTINGS });

    expect(result).toEqual({ outcome: "generated", status: "PENDING_APPROVAL", decision: "REQUIRE_APPROVAL" });

    const [, update] = saveGeneratedResponse.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.publishDecisionReason).toContain("manual_approval_required");
  });

  it("never marks a 1-star review GENERATED-for-auto-publish, even with a spotless AI classification", async () => {
    mockStoredReview(reviewRow({ rating: 1 }));
    generateReviewResponse.mockResolvedValue({ ...CLEAN_AI_OUTPUT, rating: 1 });

    const { processReview } = await import("@/reviews/processing.service");
    const result = await processReview("review-1", { settings: PERMISSIVE_SETTINGS });

    expect(result).toEqual({ outcome: "generated", status: "PENDING_APPROVAL", decision: "REQUIRE_APPROVAL" });
    const [, update] = saveGeneratedResponse.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.status).toBe("PENDING_APPROVAL");
  });

  it("escalates risk from review text the model missed, all the way through to the persisted row", async () => {
    mockStoredReview(
      reviewRow({ review_text: "Great work, though I am now talking to my attorney about something unrelated." }),
    );
    generateReviewResponse.mockResolvedValue(CLEAN_AI_OUTPUT); // model says low risk

    const { processReview } = await import("@/reviews/processing.service");
    await processReview("review-1", { settings: PERMISSIVE_SETTINGS });

    const [, update] = saveGeneratedResponse.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.riskLevel).toBe("high");
    expect(update.needsHumanReview).toBe(true);
    expect(update.status).toBe("PENDING_APPROVAL");
  });

  it("blocks auto-publish when Google already has a reply, regardless of the AI output or settings", async () => {
    mockStoredReview(reviewRow({ google_reply_state: "EXISTING_REPLY_FOUND" }));
    generateReviewResponse.mockResolvedValue(CLEAN_AI_OUTPUT);

    const { processReview } = await import("@/reviews/processing.service");
    const result = await processReview("review-1", { settings: PERMISSIVE_SETTINGS });

    expect(result).toMatchObject({ decision: "BLOCKED", status: "PENDING_APPROVAL" });
  });

  it("is idempotent: skips a review that is not in RECEIVED state without calling the AI service", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "GENERATED" }));

    const { processReview } = await import("@/reviews/processing.service");
    const result = await processReview("review-1");

    expect(result).toEqual({ outcome: "skipped", reason: "not_in_received_state", status: "GENERATED" });
    expect(generateReviewResponse).not.toHaveBeenCalled();
    expect(markProcessing).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("marks the review FAILED and records the failure when generation throws", async () => {
    mockStoredReview(reviewRow());
    generateReviewResponse.mockRejectedValue(new Error("provider unavailable"));

    const { processReview } = await import("@/reviews/processing.service");
    const result = await processReview("review-1");

    expect(result).toEqual({ outcome: "failed", error: "provider unavailable" });
    expect(markProcessingFailed).toHaveBeenCalledWith("review-1", "provider unavailable");
    expect(saveGeneratedResponse).not.toHaveBeenCalled();

    const events = recordEvent.mock.calls.map((call) => call[1]);
    expect(events).toEqual(["AI_GENERATION_STARTED", "AI_GENERATION_FAILED"]);
  });

  it("throws when the review does not exist", async () => {
    findReviewById.mockResolvedValue(null);

    const { processReview } = await import("@/reviews/processing.service");
    await expect(processReview("missing")).rejects.toThrow(BadRequestError);
  });
});
