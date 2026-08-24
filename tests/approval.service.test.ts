import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";
import { BadRequestError } from "@/utils/errors";
import type { ReviewRow } from "@/database/repositories/review.repository";

const findReviewById = vi.fn();
const markApproved = vi.fn();
const markRejected = vi.fn();
const updateFinalResponse = vi.fn();
const markProcessing = vi.fn();
const saveGeneratedResponse = vi.fn();
const markProcessingFailed = vi.fn();
const recordEvent = vi.fn();

vi.mock("@/database/repositories/review.repository", () => ({
  findReviewById: (...args: unknown[]) => findReviewById(...args),
  markApproved: (...args: unknown[]) => markApproved(...args),
  markRejected: (...args: unknown[]) => markRejected(...args),
  updateFinalResponse: (...args: unknown[]) => updateFinalResponse(...args),
  markProcessing: (...args: unknown[]) => markProcessing(...args),
  saveGeneratedResponse: (...args: unknown[]) => saveGeneratedResponse(...args),
  markProcessingFailed: (...args: unknown[]) => markProcessingFailed(...args),
  recordEvent: (...args: unknown[]) => recordEvent(...args),
}));

const generateReviewResponse = vi.fn();
vi.mock("@/openai/review-response.service", () => ({
  generateReviewResponse: (...args: unknown[]) => generateReviewResponse(...args),
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
    status: "PENDING_APPROVAL",
    google_reply_state: "NONE",
    existing_google_reply: null,
    existing_reply_updated_at: null,
    ai_response: "Thanks so much for the kind words!",
    final_response: null,
    sentiment: "positive",
    risk_level: "low",
    needs_human_review: false,
    ai_reason: "clean",
    referenced_details: [],
    ai_model: "gpt-4o-mini",
    publish_decision: "REQUIRE_APPROVAL",
    publish_decision_reason: "rating_requires_approval",
    processing_attempts: 1,
    last_error: null,
    published_at: null,
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
  resetEnvCache();

  findReviewById.mockReset();
  markApproved.mockReset();
  markRejected.mockReset();
  updateFinalResponse.mockReset();
  markProcessing.mockReset();
  saveGeneratedResponse.mockReset();
  markProcessingFailed.mockReset();
  recordEvent.mockReset();
  generateReviewResponse.mockReset();

  markApproved.mockImplementation(async (_id: string, update: { finalResponse: string; approvedBy: string }) =>
    reviewRow({ status: "APPROVED", final_response: update.finalResponse, approved_by: update.approvedBy }),
  );
  markRejected.mockImplementation(async () => reviewRow({ status: "REJECTED" }));
  updateFinalResponse.mockImplementation(async (_id: string, text: string) =>
    reviewRow({ status: "PENDING_APPROVAL", final_response: text }),
  );
  saveGeneratedResponse.mockImplementation(async () => reviewRow());
  markProcessingFailed.mockImplementation(async () => reviewRow({ status: "FAILED" }));
});

describe("approveReview", () => {
  it("approves a pending review, falling back to the AI draft as the final response", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "PENDING_APPROVAL", final_response: null }));

    const { approveReview } = await import("@/reviews/approval.service");
    const result = await approveReview("review-1", { actor: "jane" });

    expect(markApproved).toHaveBeenCalledWith("review-1", {
      finalResponse: "Thanks so much for the kind words!",
      approvedBy: "jane",
    });
    expect(result.review.status).toBe("APPROVED");

    const events = recordEvent.mock.calls.map((call) => [call[1], call[3]]);
    expect(events).toEqual([["APPROVED", "jane"]]);
  });

  it("approves using a previously human-edited response instead of the AI draft", async () => {
    findReviewById.mockResolvedValue(
      reviewRow({ status: "PENDING_APPROVAL", ai_response: "original draft", final_response: "edited by human" }),
    );

    const { approveReview } = await import("@/reviews/approval.service");
    await approveReview("review-1");

    expect(markApproved).toHaveBeenCalledWith("review-1", {
      finalResponse: "edited by human",
      approvedBy: "admin",
    });
  });

  it("allows approving a GENERATED (auto-publish-eligible) review directly", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "GENERATED" }));

    const { approveReview } = await import("@/reviews/approval.service");
    await expect(approveReview("review-1")).resolves.toBeDefined();
  });

  it("refuses to approve a review with no generated response at all", async () => {
    findReviewById.mockResolvedValue(
      reviewRow({ status: "GENERATED", ai_response: null, final_response: null }),
    );

    const { approveReview } = await import("@/reviews/approval.service");
    await expect(approveReview("review-1")).rejects.toThrow(BadRequestError);
    expect(markApproved).not.toHaveBeenCalled();
  });

  it("refuses to approve a review that is still RECEIVED", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "RECEIVED" }));

    const { approveReview } = await import("@/reviews/approval.service");
    await expect(approveReview("review-1")).rejects.toThrow(BadRequestError);
    expect(markApproved).not.toHaveBeenCalled();
  });

  it("refuses to approve a review that was already published", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "PUBLISHED" }));

    const { approveReview } = await import("@/reviews/approval.service");
    await expect(approveReview("review-1")).rejects.toThrow(BadRequestError);
  });

  it("throws when the review does not exist", async () => {
    findReviewById.mockResolvedValue(null);

    const { approveReview } = await import("@/reviews/approval.service");
    await expect(approveReview("missing")).rejects.toThrow(BadRequestError);
  });
});

describe("rejectReview", () => {
  it("rejects a pending review and records the reason on the audit trail", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "PENDING_APPROVAL" }));

    const { rejectReview } = await import("@/reviews/approval.service");
    const result = await rejectReview("review-1", { actor: "jane", reason: "not accurate" });

    expect(result.review.status).toBe("REJECTED");
    expect(recordEvent).toHaveBeenCalledWith(
      "review-1",
      "REJECTED",
      { previousStatus: "PENDING_APPROVAL", reason: "not accurate" },
      "jane",
    );
  });

  it("allows rejecting a review stuck in FAILED", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "FAILED" }));

    const { rejectReview } = await import("@/reviews/approval.service");
    await expect(rejectReview("review-1")).resolves.toBeDefined();
  });

  it("refuses to reject an already-published review", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "PUBLISHED" }));

    const { rejectReview } = await import("@/reviews/approval.service");
    await expect(rejectReview("review-1")).rejects.toThrow(BadRequestError);
    expect(markRejected).not.toHaveBeenCalled();
  });
});

describe("editReviewResponse", () => {
  it("saves the edited text and keeps the review in PENDING_APPROVAL", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "GENERATED" }));

    const { editReviewResponse } = await import("@/reviews/approval.service");
    const result = await editReviewResponse("review-1", "  A hand-edited reply.  ", { actor: "jane" });

    expect(updateFinalResponse).toHaveBeenCalledWith("review-1", "A hand-edited reply.");
    expect(result.review.status).toBe("PENDING_APPROVAL");
    expect(recordEvent).toHaveBeenCalledWith(
      "review-1",
      "RESPONSE_EDITED_BY_HUMAN",
      expect.objectContaining({ newLength: "A hand-edited reply.".length }),
      "jane",
    );
  });

  it("rejects an empty or whitespace-only edit", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "PENDING_APPROVAL" }));

    const { editReviewResponse } = await import("@/reviews/approval.service");
    await expect(editReviewResponse("review-1", "   ")).rejects.toThrow(BadRequestError);
    expect(updateFinalResponse).not.toHaveBeenCalled();
  });

  it("rejects an edit longer than the business's configured max length", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "PENDING_APPROVAL" }));

    const { editReviewResponse } = await import("@/reviews/approval.service");
    await expect(
      editReviewResponse("review-1", "x".repeat(50), {
        business: {
          businessName: null,
          businessDescription: null,
          brandVoice: null,
          preferredTone: null,
          maxResponseChars: 10,
          contactPhone: null,
          contactEmail: null,
          escalationInstructions: null,
          phrasesToAvoid: [],
          approvedPolicies: [],
          locationNotes: null,
        },
      }),
    ).rejects.toThrow(BadRequestError);
    expect(updateFinalResponse).not.toHaveBeenCalled();
  });

  it("refuses to edit a review that has already been approved", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "APPROVED" }));

    const { editReviewResponse } = await import("@/reviews/approval.service");
    await expect(editReviewResponse("review-1", "new text")).rejects.toThrow(BadRequestError);
  });
});

describe("regenerateReviewResponse", () => {
  const NEW_AI_OUTPUT = {
    reply: "A brand-new draft.",
    sentiment: "positive" as const,
    rating: 5,
    needsHumanReview: false,
    riskLevel: "low" as const,
    reason: "Still clean.",
    referencedDetails: [],
  };

  it("re-runs generation for a review sitting in PENDING_APPROVAL and records RESPONSE_REGENERATED first", async () => {
    const row = reviewRow({ status: "PENDING_APPROVAL", processing_attempts: 1 });
    findReviewById.mockResolvedValue(row);
    markProcessing.mockImplementation(async (_id: string, nextAttempt: number) => ({
      ...row,
      status: "PROCESSING" as const,
      processing_attempts: nextAttempt,
    }));
    generateReviewResponse.mockResolvedValue(NEW_AI_OUTPUT);

    const { regenerateReviewResponse } = await import("@/reviews/approval.service");
    const result = await regenerateReviewResponse("review-1", { actor: "jane" });

    expect(result.outcome).toBe("generated");
    expect(markProcessing).toHaveBeenCalledWith("review-1", 2);

    const events = recordEvent.mock.calls.map((call) => call[1]);
    expect(events).toEqual([
      "RESPONSE_REGENERATED",
      "AI_GENERATION_STARTED",
      "AI_GENERATION_COMPLETED",
      "AUTO_PUBLISH_DECISION",
    ]);
  });

  it("allows regenerating a review that previously FAILED", async () => {
    const row = reviewRow({ status: "FAILED", processing_attempts: 1 });
    findReviewById.mockResolvedValue(row);
    markProcessing.mockImplementation(async (_id: string, nextAttempt: number) => ({
      ...row,
      status: "PROCESSING" as const,
      processing_attempts: nextAttempt,
    }));
    generateReviewResponse.mockResolvedValue(NEW_AI_OUTPUT);

    const { regenerateReviewResponse } = await import("@/reviews/approval.service");
    const result = await regenerateReviewResponse("review-1");

    expect(result.outcome).toBe("generated");
  });

  it("still enforces publishing safety invariants on the regenerated output (1-star never auto-publishes)", async () => {
    const row = reviewRow({ status: "PENDING_APPROVAL", rating: 1, processing_attempts: 1 });
    findReviewById.mockResolvedValue(row);
    markProcessing.mockImplementation(async (_id: string, nextAttempt: number) => ({
      ...row,
      status: "PROCESSING" as const,
      processing_attempts: nextAttempt,
    }));
    generateReviewResponse.mockResolvedValue({ ...NEW_AI_OUTPUT, rating: 1 });

    const { regenerateReviewResponse } = await import("@/reviews/approval.service");
    const result = await regenerateReviewResponse("review-1", {
      settings: { autoPublishFiveStar: true, autoPublishFourStar: true, minAutoPublishRating: 4 },
    });

    expect(result).toMatchObject({ status: "PENDING_APPROVAL", decision: "REQUIRE_APPROVAL" });
  });

  it("refuses to regenerate a review that is still RECEIVED (that's processReview's job)", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "RECEIVED" }));

    const { regenerateReviewResponse } = await import("@/reviews/approval.service");
    await expect(regenerateReviewResponse("review-1")).rejects.toThrow(BadRequestError);
    expect(markProcessing).not.toHaveBeenCalled();
  });

  it("refuses to regenerate an already-published review", async () => {
    findReviewById.mockResolvedValue(reviewRow({ status: "PUBLISHED" }));

    const { regenerateReviewResponse } = await import("@/reviews/approval.service");
    await expect(regenerateReviewResponse("review-1")).rejects.toThrow(BadRequestError);
  });
});
