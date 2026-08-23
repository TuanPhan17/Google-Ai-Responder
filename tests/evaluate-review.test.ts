import { describe, expect, it } from "vitest";

import { evaluateReviewForPublishing } from "@/policies/evaluate-review";

describe("evaluateReviewForPublishing", () => {
  it("auto-publishes a genuinely clean 5-star review", () => {
    const result = evaluateReviewForPublishing({
      rating: 5,
      reviewText: "Fast, friendly, and fair pricing. Highly recommend!",
      hasExistingGoogleReply: false,
      aiOutput: { riskLevel: "low", needsHumanReview: false },
      settings: { autoPublishFiveStar: true, autoPublishFourStar: true, minAutoPublishRating: 4 },
    });

    expect(result.decision).toBe("AUTO_PUBLISH");
    expect(result.riskLevel).toBe("low");
    expect(result.keywordMatches).toEqual([]);
  });

  it("routes a 5-star review to approval when the text itself contains a legal threat, even if the model missed it", () => {
    const result = evaluateReviewForPublishing({
      rating: 5,
      reviewText: "Loved the service, but I'm still consulting a lawyer about an unrelated billing dispute.",
      hasExistingGoogleReply: false,
      // The model incorrectly said this was safe — the deterministic layer
      // must still catch it before the publishing policy ever sees "low".
      aiOutput: { riskLevel: "low", needsHumanReview: false },
      settings: { autoPublishFiveStar: true, autoPublishFourStar: true, minAutoPublishRating: 4 },
    });

    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.riskLevel).toBe("high");
    expect(result.keywordMatches.some((m) => m.category === "legal_threat")).toBe(true);
    expect(result.reasons).toContain("risk_high");
  });

  it("blocks when Google already has a reply, regardless of the AI output", () => {
    const result = evaluateReviewForPublishing({
      rating: 5,
      reviewText: "Great job!",
      hasExistingGoogleReply: true,
      aiOutput: { riskLevel: "low", needsHumanReview: false },
    });

    expect(result.decision).toBe("BLOCKED");
  });

  it("requires approval for a 2-star review even with a spotless AI classification", () => {
    const result = evaluateReviewForPublishing({
      rating: 2,
      reviewText: "It was okay, not great.",
      hasExistingGoogleReply: false,
      aiOutput: { riskLevel: "low", needsHumanReview: false },
      settings: { autoPublishFiveStar: true, autoPublishFourStar: true, minAutoPublishRating: 4 },
    });

    expect(result.decision).toBe("REQUIRE_APPROVAL");
  });
});
