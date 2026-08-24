import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Direct coverage of the Phase 4/5 repository functions against a fake
 * Supabase client. The rest of review.repository.ts has no equivalent direct
 * test (only processing.service.test.ts and approval.service.test.ts exercise
 * it, via mocks) — these are worth having because a column-name typo here
 * (e.g. `risk_level` vs `riskLevel`) would otherwise only surface against a
 * real database, and because the fake client can simulate the one thing the
 * mocked tests can't: a real UPDATE ... WHERE matching zero rows.
 */
interface FakeUpdateRecord {
  table: string;
  payload: Record<string, unknown>;
  id?: string;
  statusFilter?: string[];
  publishedAtFilter?: null;
  replyStateFilter?: string[];
}

/**
 * `forceNextUpdateResult` lets a test stand in for the one thing this fake
 * can't derive on its own: a real Postgres UPDATE ... WHERE that matches zero
 * rows because another writer already changed the row. That's exactly the
 * race the approval-workflow WHERE clauses (see throwOnZeroRowsOrError in
 * review.repository.ts) are meant to catch.
 */
function createFakeDb() {
  const updates: FakeUpdateRecord[] = [];
  const selects: Array<{ table: string; id: string }> = [];
  let forcedResult: { data: unknown; error: { code: string } } | null = null;

  return {
    updates,
    selects,
    forceNextUpdateResult(result: { data: unknown; error: { code: string } } | null) {
      forcedResult = result;
    },
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          const record: FakeUpdateRecord = { table, payload };
          const builder = {
            eq(col: string, value: unknown) {
              if (col === "id") record.id = value as string;
              if (col === "status") record.statusFilter = [value as string];
              if (col === "google_reply_state") record.replyStateFilter = [value as string];
              return builder;
            },
            in(col: string, values: string[]) {
              if (col === "status") record.statusFilter = values;
              if (col === "google_reply_state") record.replyStateFilter = values;
              return builder;
            },
            is(col: string, value: null) {
              if (col === "published_at") record.publishedAtFilter = value;
              return builder;
            },
            select: () => ({
              single: async () => {
                updates.push(record);
                if (forcedResult) {
                  const result = forcedResult;
                  forcedResult = null;
                  return result;
                }
                return { data: { id: record.id, ...payload }, error: null };
              },
            }),
          };
          return builder;
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
  PG_NO_ROWS: "PGRST116",
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
      humanReviewRequired: true,
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
          human_review_required: true,
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

describe("markApproved", () => {
  it("sets status APPROVED, stamps the final response/approver/timestamp, and scopes the write to the allowed statuses", async () => {
    const { markApproved } = await import("@/database/repositories/review.repository");
    await markApproved("review-1", { finalResponse: "Thanks!", approvedBy: "jane" }, ["GENERATED", "PENDING_APPROVAL"]);

    const [update] = fakeDb.updates;
    expect(update?.table).toBe("reviews");
    expect(update?.statusFilter).toEqual(["GENERATED", "PENDING_APPROVAL"]);
    expect(update?.payload).toMatchObject({
      status: "APPROVED",
      final_response: "Thanks!",
      approved_by: "jane",
    });
    expect(typeof update?.payload.approved_at).toBe("string");
  });

  it("throws ConflictError, not DatabaseError, when the UPDATE matches zero rows", async () => {
    const { ConflictError } = await import("@/utils/errors");
    fakeDb.forceNextUpdateResult({ data: null, error: { code: "PGRST116" } });

    const { markApproved } = await import("@/database/repositories/review.repository");
    await expect(
      markApproved("review-1", { finalResponse: "Thanks!", approvedBy: "jane" }, ["GENERATED", "PENDING_APPROVAL"]),
    ).rejects.toThrow(ConflictError);
  });
});

describe("markRejected", () => {
  it("sets status REJECTED, scoped to the allowed statuses", async () => {
    const { markRejected } = await import("@/database/repositories/review.repository");
    await markRejected("review-1", ["GENERATED", "PENDING_APPROVAL", "FAILED"]);

    expect(fakeDb.updates).toEqual([
      {
        table: "reviews",
        id: "review-1",
        statusFilter: ["GENERATED", "PENDING_APPROVAL", "FAILED"],
        payload: { status: "REJECTED" },
      },
    ]);
  });

  it("throws ConflictError when the UPDATE matches zero rows", async () => {
    const { ConflictError } = await import("@/utils/errors");
    fakeDb.forceNextUpdateResult({ data: null, error: { code: "PGRST116" } });

    const { markRejected } = await import("@/database/repositories/review.repository");
    await expect(markRejected("review-1", ["GENERATED", "PENDING_APPROVAL", "FAILED"])).rejects.toThrow(
      ConflictError,
    );
  });
});

describe("updateFinalResponse", () => {
  it("saves the edited text, resets status to PENDING_APPROVAL, and scopes the write to the allowed statuses", async () => {
    const { updateFinalResponse } = await import("@/database/repositories/review.repository");
    await updateFinalResponse("review-1", "A hand-edited reply.", ["GENERATED", "PENDING_APPROVAL"]);

    expect(fakeDb.updates).toEqual([
      {
        table: "reviews",
        id: "review-1",
        statusFilter: ["GENERATED", "PENDING_APPROVAL"],
        payload: { final_response: "A hand-edited reply.", status: "PENDING_APPROVAL" },
      },
    ]);
  });

  it("throws ConflictError when the UPDATE matches zero rows", async () => {
    const { ConflictError } = await import("@/utils/errors");
    fakeDb.forceNextUpdateResult({ data: null, error: { code: "PGRST116" } });

    const { updateFinalResponse } = await import("@/database/repositories/review.repository");
    await expect(
      updateFinalResponse("review-1", "A hand-edited reply.", ["GENERATED", "PENDING_APPROVAL"]),
    ).rejects.toThrow(ConflictError);
  });
});

describe("markUnapproved", () => {
  it("sets status back to PENDING_APPROVAL, clears approval fields, and scopes the write to APPROVED + published_at IS NULL + not mid-publish", async () => {
    const { markUnapproved } = await import("@/database/repositories/review.repository");
    await markUnapproved("review-1");

    const [update] = fakeDb.updates;
    expect(update?.table).toBe("reviews");
    expect(update?.statusFilter).toEqual(["APPROVED"]);
    expect(update?.publishedAtFilter).toBeNull();
    // PUBLISH_PENDING is excluded: a publish attempt currently holds the row.
    expect(update?.replyStateFilter).toEqual(["NONE", "EXISTING_REPLY_FOUND", "PUBLISHED", "PUBLISH_FAILED"]);
    expect(update?.payload).toEqual({
      status: "PENDING_APPROVAL",
      approved_by: null,
      approved_at: null,
    });
  });

  it("throws ConflictError when the review is already published or not currently approved", async () => {
    const { ConflictError } = await import("@/utils/errors");
    fakeDb.forceNextUpdateResult({ data: null, error: { code: "PGRST116" } });

    const { markUnapproved } = await import("@/database/repositories/review.repository");
    await expect(markUnapproved("review-1")).rejects.toThrow(ConflictError);
  });
});

describe("claimReviewForPublishing", () => {
  it("moves google_reply_state to PUBLISH_PENDING, scoped to the allowed statuses, claimable reply states, and published_at IS NULL", async () => {
    const { claimReviewForPublishing } = await import("@/database/repositories/review.repository");
    await claimReviewForPublishing("review-1", ["APPROVED", "GENERATED"]);

    const [update] = fakeDb.updates;
    expect(update?.table).toBe("reviews");
    expect(update?.statusFilter).toEqual(["APPROVED", "GENERATED"]);
    expect(update?.publishedAtFilter).toBeNull();
    expect(update?.replyStateFilter).toEqual(["NONE", "PUBLISH_FAILED"]);
    expect(update?.payload).toEqual({ google_reply_state: "PUBLISH_PENDING" });
  });

  it("throws ConflictError when the row is no longer eligible (unapproved, already claimed, or already published)", async () => {
    const { ConflictError } = await import("@/utils/errors");
    fakeDb.forceNextUpdateResult({ data: null, error: { code: "PGRST116" } });

    const { claimReviewForPublishing } = await import("@/database/repositories/review.repository");
    await expect(claimReviewForPublishing("review-1", ["APPROVED", "GENERATED"])).rejects.toThrow(ConflictError);
  });
});

describe("markPublished", () => {
  it("sets status PUBLISHED, stamps final_response/published_at, and only writes over a held PUBLISH_PENDING claim", async () => {
    const { markPublished } = await import("@/database/repositories/review.repository");
    await markPublished("review-1", {
      finalResponse: "Thanks!",
      publishedAt: "2026-08-20T00:00:00.000Z",
      publishedBy: "jane",
    });

    const [update] = fakeDb.updates;
    expect(update?.table).toBe("reviews");
    expect(update?.replyStateFilter).toEqual(["PUBLISH_PENDING"]);
    expect(update?.payload).toEqual({
      status: "PUBLISHED",
      final_response: "Thanks!",
      published_at: "2026-08-20T00:00:00.000Z",
      published_by: "jane",
      google_reply_state: "PUBLISHED",
    });
  });

  it("throws ConflictError when the row does not currently hold a publish claim", async () => {
    const { ConflictError } = await import("@/utils/errors");
    fakeDb.forceNextUpdateResult({ data: null, error: { code: "PGRST116" } });

    const { markPublished } = await import("@/database/repositories/review.repository");
    await expect(
      markPublished("review-1", {
        finalResponse: "Thanks!",
        publishedAt: "2026-08-20T00:00:00.000Z",
        publishedBy: "jane",
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("markPublishFailed", () => {
  it("sets google_reply_state PUBLISH_FAILED and records the error, without touching status", async () => {
    const { markPublishFailed } = await import("@/database/repositories/review.repository");
    await markPublishFailed("review-1", "Google returned HTTP 503.");

    const [update] = fakeDb.updates;
    expect(update?.replyStateFilter).toEqual(["PUBLISH_PENDING"]);
    expect(update?.payload).toEqual({
      google_reply_state: "PUBLISH_FAILED",
      last_error: "Google returned HTTP 503.",
    });
    expect(update?.payload.status).toBeUndefined();
  });
});

describe("markPublishBlockedByExistingReply", () => {
  it("routes the review back to PENDING_APPROVAL and records what Google actually has", async () => {
    const { markPublishBlockedByExistingReply } = await import("@/database/repositories/review.repository");
    await markPublishBlockedByExistingReply("review-1", {
      existingReply: "Someone already replied to this.",
      existingReplyUpdateTime: "2026-08-19T00:00:00.000Z",
    });

    const [update] = fakeDb.updates;
    expect(update?.replyStateFilter).toEqual(["PUBLISH_PENDING"]);
    expect(update?.payload).toEqual({
      status: "PENDING_APPROVAL",
      google_reply_state: "EXISTING_REPLY_FOUND",
      existing_google_reply: "Someone already replied to this.",
      existing_reply_updated_at: "2026-08-19T00:00:00.000Z",
    });
  });
});
