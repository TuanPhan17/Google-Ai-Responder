import { describe, expect, it } from "vitest";

import { MOCK_FIXTURES, fixturesAsListResponse } from "@/mocks/fixtures";
import { googleReviewSchema } from "@/schemas/google";

/**
 * Fixtures are only useful if they are indistinguishable from real Google
 * payloads. If one drifts from the schema, every test built on it starts
 * proving something about a shape Google never sends.
 */
describe("mock fixtures", () => {
  it("covers all fourteen specified scenarios", () => {
    expect(MOCK_FIXTURES).toHaveLength(14);
  });

  it("every fixture parses against the real Google review schema", () => {
    for (const fixture of MOCK_FIXTURES) {
      const result = googleReviewSchema.safeParse(fixture.review);
      expect(result.success, `${fixture.key} failed schema validation`).toBe(true);
    }
  });

  it("the star-only fixture genuinely omits the comment field", () => {
    const starOnly = MOCK_FIXTURES.find((f) => f.key === "five-star-no-text")!;
    expect("comment" in starOnly.review).toBe(false);
  });

  it("the duplicate fixture reuses an existing reviewId verbatim", () => {
    const original = MOCK_FIXTURES.find((f) => f.key === "positive-detailed")!;
    const duplicate = MOCK_FIXTURES.find((f) => f.key === "duplicate-event")!;

    expect(duplicate.review.reviewId).toBe(original.review.reviewId);
    expect(duplicate.review.updateTime).toBe(original.review.updateTime);
  });

  it("the edited fixture shares an ID but carries a later updateTime", () => {
    const original = MOCK_FIXTURES.find((f) => f.key === "four-star-minor-criticism")!;
    const edited = MOCK_FIXTURES.find((f) => f.key === "edited-review")!;

    expect(edited.review.reviewId).toBe(original.review.reviewId);
    expect(edited.review.updateTime > original.review.updateTime).toBe(true);
  });

  it("collapses duplicates when presented as a Google list response", () => {
    const listed = fixturesAsListResponse();
    const ids = listed.map((review) => review.reviewId);

    expect(new Set(ids).size).toBe(ids.length);
    // The edited version wins, since Google only ever shows the current text.
    expect(listed.find((r) => r.reviewId === "rev-003")?.starRating).toBe("TWO");
  });
});
