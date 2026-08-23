import { describe, expect, it } from "vitest";

import {
  extractFirstName,
  hasContentChanged,
  mapGoogleReview,
  normalizeText,
  starRatingToNumber,
} from "@/reviews/mapper";
import { getFixture, MOCK_ACCOUNT_ID, MOCK_LOCATION_ID } from "@/mocks/fixtures";
import { googleReviewSchema } from "@/schemas/google";

const context = { googleAccountId: MOCK_ACCOUNT_ID, googleLocationId: MOCK_LOCATION_ID };

describe("starRatingToNumber", () => {
  it("maps Google's enum to a comparable number", () => {
    expect(starRatingToNumber("ONE")).toBe(1);
    expect(starRatingToNumber("FIVE")).toBe(5);
  });

  it("returns null for an unspecified rating rather than guessing", () => {
    expect(starRatingToNumber("STAR_RATING_UNSPECIFIED")).toBeNull();
  });
});

describe("normalizeText", () => {
  it("treats a missing comment as no text", () => {
    expect(normalizeText(undefined)).toBeNull();
  });

  it("treats whitespace-only text as no text", () => {
    // This is the one that matters: whitespace answering "is there something to
    // reference?" with yes is how a bot ends up inventing an experience.
    expect(normalizeText("   \n\t ")).toBeNull();
  });

  it("trims but preserves real text", () => {
    expect(normalizeText("  great service  ")).toBe("great service");
  });
});

describe("extractFirstName", () => {
  it("takes the first token of a normal display name", () => {
    expect(extractFirstName("Sarah Whitfield")).toBe("Sarah");
  });

  it("supports non-ASCII names", () => {
    expect(extractFirstName("Sofía Márquez")).toBe("Sofía");
  });

  it("declines initials, handles and anything with symbols", () => {
    expect(extractFirstName("D. Reyes")).toBeNull();
    expect(extractFirstName("xX_driver_Xx")).toBeNull();
    expect(extractFirstName("user1234")).toBeNull();
    expect(extractFirstName("L")).toBeNull();
  });

  it("returns null when there is no name at all", () => {
    expect(extractFirstName(undefined)).toBeNull();
    expect(extractFirstName("   ")).toBeNull();
  });
});

describe("mapGoogleReview", () => {
  it("keeps a star-only review free of invented text", () => {
    const fixture = getFixture("five-star-no-text")!;
    const mapped = mapGoogleReview(fixture.review, context);

    expect(mapped.reviewText).toBeNull();
    expect(mapped.rating).toBe(5);
    expect(mapped.reviewerFirstName).toBe("Jason");
  });

  it("drops the name for an anonymous reviewer", () => {
    const fixture = getFixture("fraud-accusation")!;
    const mapped = mapGoogleReview(fixture.review, context);

    expect(mapped.reviewerIsAnonymous).toBe(true);
    expect(mapped.reviewerName).toBeNull();
    expect(mapped.reviewerFirstName).toBeNull();
  });

  it("captures an existing Google reply", () => {
    const fixture = getFixture("already-replied")!;
    const mapped = mapGoogleReview(fixture.review, context);

    expect(mapped.existingReplyText).toContain("glad we could get you sorted");
    expect(mapped.existingReplyUpdateTime).toBe("2026-08-04T16:30:00Z");
  });

  it("builds the v4 resource name when Google omits it", () => {
    const mapped = mapGoogleReview(
      googleReviewSchema.parse({
        reviewId: "abc",
        starRating: "FOUR",
        createTime: "2026-01-01T00:00:00Z",
        updateTime: "2026-01-01T00:00:00Z",
      }),
      context,
    );

    expect(mapped.googleReviewName).toBe(
      `accounts/${MOCK_ACCOUNT_ID}/locations/${MOCK_LOCATION_ID}/reviews/abc`,
    );
  });
});

describe("hasContentChanged", () => {
  it("detects the edited-review fixture as a real change", () => {
    const original = mapGoogleReview(getFixture("four-star-minor-criticism")!.review, context);
    const edited = mapGoogleReview(getFixture("edited-review")!.review, context);

    expect(hasContentChanged({ rating: original.rating, reviewText: original.reviewText }, edited)).toBe(true);
  });

  it("treats a duplicate delivery as unchanged", () => {
    const first = mapGoogleReview(getFixture("positive-detailed")!.review, context);
    const duplicate = mapGoogleReview(getFixture("duplicate-event")!.review, context);

    expect(hasContentChanged({ rating: first.rating, reviewText: first.reviewText }, duplicate)).toBe(false);
  });
});
