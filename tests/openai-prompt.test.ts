import { describe, expect, it } from "vitest";

import { buildSystemPrompt, buildUserPrompt } from "@/openai/prompt";
import type { BusinessContext } from "@/types/business";
import type { NormalizedReview } from "@/types/review";

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

function business(overrides: Partial<BusinessContext> = {}): BusinessContext {
  return {
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
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("states the model has no final authority over publishing", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/do not decide whether the reply gets published/i);
  });

  it("instructs the model never to invent details", () => {
    expect(buildSystemPrompt()).toMatch(/never invent details/i);
  });

  it("instructs the model never to promise remedies outside approved policy", () => {
    expect(buildSystemPrompt()).toMatch(/never promise a refund.*unless it appears in the approved business policies/i);
  });

  it("defines needsHumanReview and riskLevel semantics", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/needsHumanReview/);
    expect(prompt).toMatch(/riskLevel/);
  });
});

describe("buildUserPrompt", () => {
  it("includes the review text and reviewer first name when present", () => {
    const prompt = buildUserPrompt(review(), business());
    expect(prompt).toContain("Mike got my car fixed ahead of schedule, fast service!");
    expect(prompt).toContain("Sarah");
  });

  it("flags a star-only review instead of fabricating text", () => {
    const prompt = buildUserPrompt(review({ reviewText: null }), business());
    expect(prompt).toMatch(/star-only review with no written comment/i);
    expect(prompt).toMatch(/do not invent a reason for the rating/i);
  });

  it("tells the model no verified business information exists when business is null", () => {
    const prompt = buildUserPrompt(review(), null);
    expect(prompt).toMatch(/no verified business information was supplied/i);
    expect(prompt).not.toContain("Riverside Auto Group");
  });

  it("includes phrases to avoid and approved policies when supplied", () => {
    const prompt = buildUserPrompt(
      review(),
      business({ phrasesToAvoid: ["we sincerely apologize"], approvedPolicies: ["free re-detail within 7 days"] }),
    );
    expect(prompt).toContain("we sincerely apologize");
    expect(prompt).toContain("free re-detail within 7 days");
  });

  it("never fabricates contact details that were not supplied", () => {
    const prompt = buildUserPrompt(review(), business({ contactPhone: null, contactEmail: null }));
    expect(prompt).not.toMatch(/contact phone/i);
    expect(prompt).not.toMatch(/contact email/i);
  });
});
