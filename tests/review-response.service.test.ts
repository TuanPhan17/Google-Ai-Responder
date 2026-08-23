import { describe, expect, it, vi } from "vitest";

import type { NormalizedReview } from "@/types/review";
import type { BusinessContext } from "@/types/business";
import { reviewResponseJsonSchema, reviewResponseSchema } from "@/schemas/openai";

const VALID_OUTPUT = {
  reply: "Thanks for the kind words!",
  sentiment: "positive" as const,
  rating: 5,
  needsHumanReview: false,
  riskLevel: "low" as const,
  reason: "Positive review with no risk factors.",
  referencedDetails: ["fast service"],
};

const openAiStructuredRequest = vi.fn();
vi.mock("@/openai/client", () => ({
  openAiStructuredRequest: (...args: unknown[]) => openAiStructuredRequest(...args),
}));

function review(overrides: Partial<NormalizedReview> = {}): NormalizedReview {
  return {
    googleReviewId: "rev-1",
    googleReviewName: "accounts/1/locations/1/reviews/rev-1",
    googleAccountId: "1",
    googleLocationId: "1",
    locationTitle: "Riverside Auto",
    reviewerName: "Sarah Johnson",
    reviewerFirstName: "Sarah",
    reviewerIsAnonymous: false,
    rating: 5,
    reviewText: "Mike got my car fixed ahead of schedule, fast service!",
    reviewCreateTime: "2026-01-01T00:00:00Z",
    reviewUpdateTime: "2026-01-01T00:00:00Z",
    existingReplyText: null,
    existingReplyUpdateTime: null,
    ...overrides,
  };
}

const business: BusinessContext = {
  businessName: "Riverside Auto Group",
  businessDescription: null,
  brandVoice: null,
  preferredTone: null,
  maxResponseChars: null,
  contactPhone: null,
  contactEmail: null,
  escalationInstructions: null,
  phrasesToAvoid: [],
  approvedPolicies: [],
  locationNotes: null,
};

describe("generateReviewResponse", () => {
  it("returns the client's validated output unchanged", async () => {
    openAiStructuredRequest.mockResolvedValueOnce(VALID_OUTPUT);

    const { generateReviewResponse } = await import("@/openai/review-response.service");
    const result = await generateReviewResponse({ review: review(), business });

    expect(result).toEqual(VALID_OUTPUT);
  });

  it("requests the review-response schema in strict Structured Outputs form", async () => {
    openAiStructuredRequest.mockResolvedValueOnce(VALID_OUTPUT);

    const { generateReviewResponse } = await import("@/openai/review-response.service");
    await generateReviewResponse({ review: review(), business });

    const [request, schema] = openAiStructuredRequest.mock.calls.at(-1) as [
      { jsonSchema: unknown; messages: Array<{ role: string; content: string }> },
      unknown,
    ];
    expect(request.jsonSchema).toEqual(reviewResponseJsonSchema);
    expect(schema).toBe(reviewResponseSchema);
  });

  it("puts the review's actual text and rating into the prompt sent to the model", async () => {
    openAiStructuredRequest.mockResolvedValueOnce(VALID_OUTPUT);

    const { generateReviewResponse } = await import("@/openai/review-response.service");
    await generateReviewResponse({
      review: review({ reviewText: "Terrible experience, the tires were never rotated." }),
      business,
    });

    const [request] = openAiStructuredRequest.mock.calls.at(-1) as [
      { messages: Array<{ role: string; content: string }> },
    ];
    const userMessage = request.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("Terrible experience, the tires were never rotated.");
  });

  it("does not fabricate review content for a star-only review", async () => {
    openAiStructuredRequest.mockResolvedValueOnce({ ...VALID_OUTPUT, referencedDetails: [] });

    const { generateReviewResponse } = await import("@/openai/review-response.service");
    await generateReviewResponse({ review: review({ reviewText: null }), business: null });

    const [request] = openAiStructuredRequest.mock.calls.at(-1) as [
      { messages: Array<{ role: string; content: string }> },
    ];
    const userMessage = request.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toMatch(/star-only review with no written comment/i);
  });

  it("propagates errors from the client instead of swallowing them", async () => {
    openAiStructuredRequest.mockRejectedValueOnce(new Error("boom"));

    const { generateReviewResponse } = await import("@/openai/review-response.service");
    await expect(generateReviewResponse({ review: review(), business })).rejects.toThrow("boom");
  });
});
