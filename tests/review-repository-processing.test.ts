import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Direct coverage of the four Phase 4 repository functions against a fake
 * Supabase client. The rest of review.repository.ts has no equivalent direct
 * test (only processing.service.test.ts exercises it, via mocks) — these are
 * worth having because a column-name typo here (e.g. `risk_level` vs
 * `riskLevel`) would otherwise only surface against a real database.
 */
function createFakeDb() {
  const updates: Array<{ table: string; payload: Record<string, unknown>; id: string }> = [];
  const selects: Array<{ table: string; id: string }> = [];

  return {
    updates,
    selects,
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            eq: (_col: string, id: string) => {
              updates.push({ table, payload, id });
              return {
                select: () => ({
                  single: async () => ({ data: { id, ...payload }, error: null }),
                }),
              };
            },
          };
        },
        select() {
          return {
            eq: (_col: string, id: string) => {
              selects.push({ table, id });
              return { maybeSingle: async () => ({ data: { id }, error: null }) };
            },
          };
        },
      };
    },
  };
}

let fakeDb: ReturnType<typeof createFakeDb>;

vi.mock("@/database/supabase", () => ({
  getDb: () => fakeDb,
}));

beforeEach(() => {
  fakeDb = createFakeDb();
});

describe("findReviewById", () => {
  it("looks up the reviews table by primary key", async () => {
    const { findReviewById } = await import("@/database/repositories/review.repository");
    await findReviewById("review-1");

    expect(fakeDb.selects).toEqual([{ table: "reviews", id: "review-1" }]);
  });
});

describe("markProcessing", () => {
  it("sets status PROCESSING and the given attempt count", async () => {
    const { markProcessing } = await import("@/database/repositories/review.repository");
    await markProcessing("review-1", 3);

    expect(fakeDb.updates).toEqual([
      { table: "reviews", id: "review-1", payload: { status: "PROCESSING", processing_attempts: 3 } },
    ]);
  });
});

describe("saveGeneratedResponse", () => {
  it("maps every field to its snake_case column and clears last_error", async () => {
    const { saveGeneratedResponse } = await import("@/database/repositories/review.repository");
    await saveGeneratedResponse("review-1", {
      aiResponse: "Thanks!",
      sentiment: "positive",
      riskLevel: "low",
      needsHumanReview: false,
      aiReason: "no concerns",
      referencedDetails: ["fast service"],
      aiModel: "gpt-4o-mini",
      publishDecision: "AUTO_PUBLISH",
      publishDecisionReason: "eligible",
      status: "GENERATED",
    });

    expect(fakeDb.updates).toEqual([
      {
        table: "reviews",
        id: "review-1",
        payload: {
          ai_response: "Thanks!",
          sentiment: "positive",
          risk_level: "low",
          needs_human_review: false,
          ai_reason: "no concerns",
          referenced_details: ["fast service"],
          ai_model: "gpt-4o-mini",
          publish_decision: "AUTO_PUBLISH",
          publish_decision_reason: "eligible",
          status: "GENERATED",
          last_error: null,
        },
      },
    ]);
  });
});

describe("markProcessingFailed", () => {
  it("sets status FAILED and stores the error, truncated to 2000 chars", async () => {
    const { markProcessingFailed } = await import("@/database/repositories/review.repository");
    const longError = "x".repeat(3000);

    await markProcessingFailed("review-1", longError);

    const [update] = fakeDb.updates;
    expect(update?.payload.status).toBe("FAILED");
    expect((update?.payload.last_error as string).length).toBe(2000);
  });
});
