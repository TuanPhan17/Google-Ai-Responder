import { describe, expect, it } from "vitest";

import { classifyRisk, scanForHighRiskKeywords } from "@/policies/risk-classifier";

describe("scanForHighRiskKeywords", () => {
  it("returns no matches for ordinary positive text", () => {
    expect(scanForHighRiskKeywords("Fast service and a clean waiting area, will be back!")).toEqual([]);
  });

  it("returns no matches for null (star-only review)", () => {
    expect(scanForHighRiskKeywords(null)).toEqual([]);
  });

  it("flags a legal threat", () => {
    const matches = scanForHighRiskKeywords("If this isn't fixed I will get my attorney involved.");
    expect(matches.map((m) => m.category)).toContain("legal_threat");
  });

  it("flags a fraud allegation", () => {
    const matches = scanForHighRiskKeywords("This place is a total scam, they ripped me off.");
    expect(matches.map((m) => m.category)).toContain("fraud");
  });

  it("flags a safety/injury incident", () => {
    const matches = scanForHighRiskKeywords("I slipped in the lobby and was injured, had to go to the hospital.");
    expect(matches.map((m) => m.category)).toContain("safety_incident");
  });

  it("flags harassment and discrimination separately when both are present", () => {
    const matches = scanForHighRiskKeywords("The manager harassed me and made a racist comment.");
    const categories = matches.map((m) => m.category);
    expect(categories).toContain("harassment");
    expect(categories).toContain("discrimination");
  });

  it("can match more than one category in the same review", () => {
    const matches = scanForHighRiskKeywords(
      "They stole parts from my car and when I called the police they threatened to sue me for defamation.",
    );
    const categories = matches.map((m) => m.category);
    expect(categories).toContain("theft");
    expect(categories).toContain("law_enforcement");
    expect(categories).toContain("legal_threat");
  });
});

describe("classifyRisk", () => {
  it("passes through the AI's risk level unchanged when nothing risky is found", () => {
    const result = classifyRisk({
      reviewText: "Great experience, fast and friendly.",
      aiRiskLevel: "low",
      aiNeedsHumanReview: false,
    });
    expect(result).toEqual({ riskLevel: "low", needsHumanReview: false, keywordMatches: [] });
  });

  it("escalates to high when the model says low but the text names a lawsuit", () => {
    // Simulates the model getting it wrong (or being manipulated) — the
    // deterministic scan must still catch it. This is the core Phase 3
    // guarantee: the model never has final authority over risk.
    const result = classifyRisk({
      reviewText: "Great service! Though I am now considering hiring an attorney over an unrelated matter.",
      aiRiskLevel: "low",
      aiNeedsHumanReview: false,
    });

    expect(result.riskLevel).toBe("high");
    expect(result.needsHumanReview).toBe(true);
    expect(result.keywordMatches.length).toBeGreaterThan(0);
  });

  it("never downgrades a risk level the model already assigned", () => {
    const result = classifyRisk({
      reviewText: "Everything was fine.",
      aiRiskLevel: "medium",
      aiNeedsHumanReview: true,
    });

    expect(result.riskLevel).toBe("medium");
    expect(result.needsHumanReview).toBe(true);
  });

  it("keeps needsHumanReview true if the model set it, even with no keyword matches", () => {
    const result = classifyRisk({
      reviewText: "Fine, I guess.",
      aiRiskLevel: "low",
      aiNeedsHumanReview: true,
    });
    expect(result.needsHumanReview).toBe(true);
    expect(result.riskLevel).toBe("low");
  });

  it("sets needsHumanReview true whenever the combined risk level is not low, even if the model said false", () => {
    const result = classifyRisk({
      reviewText: "The mechanic threatened me when I asked questions.",
      aiRiskLevel: "low",
      aiNeedsHumanReview: false,
    });
    expect(result.riskLevel).not.toBe("low");
    expect(result.needsHumanReview).toBe(true);
  });
});
