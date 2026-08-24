import { describe, expect, it } from "vitest";

import { decidePublishing, type PublishingPolicyInput } from "@/policies/publishing-policy";
import type { PublishingSettings } from "@/types/business";
import type { RiskLevel } from "@/types/review";

const PERMISSIVE_SETTINGS: PublishingSettings = {
  autoPublishFiveStar: true,
  autoPublishFourStar: true,
  minAutoPublishRating: 4,
};

function baseInput(overrides: Partial<PublishingPolicyInput> = {}): PublishingPolicyInput {
  return {
    rating: 5,
    riskLevel: "low",
    needsHumanReview: false,
    hasExistingGoogleReply: false,
    settings: PERMISSIVE_SETTINGS,
    // The rest of this file's inputs are already maximally permissive
    // (PERMISSIVE_SETTINGS, low risk, no existing reply) specifically to
    // exercise the underlying auto-publish engine — so this default opts
    // out of the separate, blanket REQUIRE_APPROVAL_FOR_ALL product decision
    // too. Its own default (decidePublishing treats an omitted value as
    // `true`) is covered by the "product decision" describe block below.
    requireApprovalForAll: false,
    ...overrides,
  };
}

describe("decidePublishing — mandatory safety invariants", () => {
  // CLAUDE.md: "1-, 2-, and 3-star reviews can never auto-publish. No
  // configuration, no settings flag, no override." Fuzz across every risk
  // level, human-review flag, and settings combination a business could
  // configure (including a deliberately over-permissive settings object) to
  // prove no combination lets a low rating slip through.
  it("never auto-publishes 1-3 star reviews, under any risk/settings combination", () => {
    const riskLevels: RiskLevel[] = ["low", "medium", "high"];
    const settingsOptions: Array<PublishingSettings | null | undefined> = [
      PERMISSIVE_SETTINGS,
      { autoPublishFiveStar: false, autoPublishFourStar: false, minAutoPublishRating: 4 },
      null,
      undefined,
      // A settings row an attacker/bug tried to relax below the DB's own floor.
      { autoPublishFiveStar: true, autoPublishFourStar: true, minAutoPublishRating: 1 as number },
    ];

    for (const rating of [1, 2, 3]) {
      for (const riskLevel of riskLevels) {
        for (const needsHumanReview of [true, false]) {
          for (const settings of settingsOptions) {
            for (const requireApprovalForAll of [true, false]) {
              const result = decidePublishing(
                baseInput({ rating, riskLevel, needsHumanReview, settings, requireApprovalForAll }),
              );
              expect(
                result.decision,
                `rating=${rating} risk=${riskLevel} needsHumanReview=${needsHumanReview} settings=${JSON.stringify(settings)} requireApprovalForAll=${requireApprovalForAll}`,
              ).not.toBe("AUTO_PUBLISH");
            }
          }
        }
      }
    }
  });

  it("never auto-publishes an unknown (null) rating", () => {
    const result = decidePublishing(baseInput({ rating: null }));
    expect(result.decision).not.toBe("AUTO_PUBLISH");
    expect(result.reasons).toContain("rating_unknown");
  });

  // CLAUDE.md: "Medium and high risk never auto-publish, regardless of rating."
  it("never auto-publishes a medium or high risk review, even a 5-star", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      for (const riskLevel of ["medium", "high"] as RiskLevel[]) {
        const result = decidePublishing(baseInput({ rating, riskLevel, needsHumanReview: false }));
        expect(result.decision, `rating=${rating} risk=${riskLevel}`).not.toBe("AUTO_PUBLISH");
      }
    }
  });

  it("never auto-publishes when needsHumanReview is true, regardless of rating or risk", () => {
    for (const rating of [4, 5]) {
      const result = decidePublishing(baseInput({ rating, riskLevel: "low", needsHumanReview: true }));
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      expect(result.reasons).toContain("needs_human_review");
    }
  });

  // CLAUDE.md: "Never publish over an existing Google reply."
  it("always blocks when a Google reply already exists, regardless of everything else", () => {
    const otherwiseIdealInputs: PublishingPolicyInput[] = [
      baseInput({ hasExistingGoogleReply: true }),
      baseInput({ hasExistingGoogleReply: true, rating: 1, riskLevel: "high", needsHumanReview: true }),
      baseInput({ hasExistingGoogleReply: true, settings: PERMISSIVE_SETTINGS }),
    ];

    for (const input of otherwiseIdealInputs) {
      const result = decidePublishing(input);
      expect(result.decision).toBe("BLOCKED");
      expect(result.reasons).toEqual(["existing_google_reply"]);
    }
  });
});

describe("decidePublishing — the auto-publish happy path", () => {
  it("auto-publishes a low-risk 5-star with no existing reply when settings allow it", () => {
    const result = decidePublishing(baseInput());
    expect(result.decision).toBe("AUTO_PUBLISH");
  });

  it("auto-publishes a low-risk 4-star when four-star auto-publish is enabled", () => {
    const result = decidePublishing(baseInput({ rating: 4 }));
    expect(result.decision).toBe("AUTO_PUBLISH");
  });

  it("requires approval for a 5-star when auto-publish is disabled in settings", () => {
    const result = decidePublishing(
      baseInput({ settings: { autoPublishFiveStar: false, autoPublishFourStar: false, minAutoPublishRating: 4 } }),
    );
    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasons).toContain("auto_publish_five_star_disabled");
  });

  it("requires approval for a 4-star when four-star auto-publish is disabled", () => {
    const result = decidePublishing(
      baseInput({
        rating: 4,
        settings: { autoPublishFiveStar: true, autoPublishFourStar: false, minAutoPublishRating: 4 },
      }),
    );
    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasons).toContain("auto_publish_four_star_disabled");
  });

  it("defaults to no auto-publish at all when no settings row exists", () => {
    const result = decidePublishing(baseInput({ settings: null }));
    expect(result.decision).toBe("REQUIRE_APPROVAL");
  });

  it("honors a stricter minAutoPublishRating of 5, blocking a 4-star even with four-star auto-publish on", () => {
    const result = decidePublishing(
      baseInput({
        rating: 4,
        settings: { autoPublishFiveStar: true, autoPublishFourStar: true, minAutoPublishRating: 5 },
      }),
    );
    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasons).toContain("below_min_auto_publish_rating");
  });
});

// Product decision: every review requires human approval before publishing.
// There is no automatic publish path in the shipped product — see
// REQUIRE_APPROVAL_FOR_ALL in src/config/env.ts and docs/SPEC.md. The
// auto-publish engine above still exists and is still fully exercised by its
// own tests; `requireApprovalForAll` is the only thing gating it off.
describe("decidePublishing — REQUIRE_APPROVAL_FOR_ALL (manual approval for everything)", () => {
  it("requires approval for an otherwise-ideal 5-star review when requireApprovalForAll is omitted (defaults to true)", () => {
    const result = decidePublishing({
      rating: 5,
      riskLevel: "low",
      needsHumanReview: false,
      hasExistingGoogleReply: false,
      settings: PERMISSIVE_SETTINGS,
      // requireApprovalForAll deliberately omitted — this is the production default.
    });

    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasons).toContain("manual_approval_required");
  });

  it("requires approval for a spotless 5-star review even with fully permissive settings when the flag is explicitly true", () => {
    const result = decidePublishing(baseInput({ requireApprovalForAll: true }));

    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasons).toEqual(["manual_approval_required"]);
  });

  it("still auto-publishes a spotless 5-star review when the flag is explicitly turned off", () => {
    const result = decidePublishing(baseInput({ requireApprovalForAll: false }));

    expect(result.decision).toBe("AUTO_PUBLISH");
  });

  it("still blocks over an existing Google reply even when the flag is off", () => {
    const result = decidePublishing(baseInput({ requireApprovalForAll: false, hasExistingGoogleReply: true }));

    expect(result.decision).toBe("BLOCKED");
  });
});
