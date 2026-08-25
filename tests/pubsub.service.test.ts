import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";
import type { GoogleReview } from "@/schemas/google";

const findReviewById = vi.fn();
const listSyncedLocations = vi.fn();
const recordEvent = vi.fn();

vi.mock("@/database/repositories/review.repository", () => ({
  findReviewById: (...args: unknown[]) => findReviewById(...args),
  listSyncedLocations: (...args: unknown[]) => listSyncedLocations(...args),
  recordEvent: (...args: unknown[]) => recordEvent(...args),
}));

const ingestReview = vi.fn();
vi.mock("@/reviews/ingest.service", () => ({
  ingestReview: (...args: unknown[]) => ingestReview(...args),
}));

const processReview = vi.fn();
vi.mock("@/reviews/processing.service", () => ({
  processReview: (...args: unknown[]) => processReview(...args),
}));

const getReview = vi.fn();
const listReviews = vi.fn();
vi.mock("@/reviews/review-source", () => ({
  getReviewSource: () => ({ kind: "mock", getReview, listReviews }),
}));

const resolveLocationConfig = vi.fn();
vi.mock("@/reviews/settings.service", () => ({
  resolveLocationConfig: (...args: unknown[]) => resolveLocationConfig(...args),
}));

function googleReview(reviewId: string): GoogleReview {
  return {
    name: `accounts/acct-1/locations/loc-1/reviews/${reviewId}`,
    reviewId,
    reviewer: { displayName: "Sarah Whitfield", isAnonymous: false },
    starRating: "FIVE",
    comment: "Great service.",
    createTime: "2026-01-01T00:00:00Z",
    updateTime: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-placeholder-value";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.ADMIN_PASSWORD = "console-password-example";
  process.env.MOCK_MODE = "true";
  resetEnvCache();

  findReviewById.mockReset();
  listSyncedLocations.mockReset();
  recordEvent.mockReset();
  ingestReview.mockReset();
  processReview.mockReset();
  getReview.mockReset();
  listReviews.mockReset();
  resolveLocationConfig.mockReset();

  resolveLocationConfig.mockResolvedValue({ business: null, settings: null });
  listSyncedLocations.mockResolvedValue([
    { googleAccountId: "acct-1", googleLocationId: "loc-1", locationTitle: "Riverside Auto" },
  ]);
});

describe("handleReviewNotification", () => {
  it("ignores a notification type this app doesn't act on, without touching Google or the database", async () => {
    const { handleReviewNotification } = await import("@/reviews/pubsub.service");

    const result = await handleReviewNotification({ notificationType: "GOOGLE_UPDATE" }, "msg-1");

    expect(result).toEqual({ action: "ignored_type", notificationType: "GOOGLE_UPDATE", totals: emptyTotals() });
    expect(getReview).not.toHaveBeenCalled();
    expect(listReviews).not.toHaveBeenCalled();
    expect(ingestReview).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      null,
      "PUBSUB_NOTIFICATION_RECEIVED",
      expect.objectContaining({ action: "ignored_type" }),
      "pubsub",
    );
  });

  it("ignores a notification with no notificationType at all", async () => {
    const { handleReviewNotification } = await import("@/reviews/pubsub.service");

    const result = await handleReviewNotification({}, "msg-1");

    expect(result.action).toBe("ignored_type");
    expect(getReview).not.toHaveBeenCalled();
  });

  it("fetches and ingests exactly the review named in a parseable reviewName, and auto-processes it when it's newly RECEIVED", async () => {
    getReview.mockResolvedValue(googleReview("rev-1"));
    ingestReview.mockResolvedValue({ action: "created", reviewId: "row-1", status: "RECEIVED", isEdited: false });
    findReviewById.mockResolvedValue({ id: "row-1", location_id: "location-row-1" });
    processReview.mockResolvedValue({ outcome: "generated", status: "PENDING_APPROVAL", decision: "REQUIRE_APPROVAL" });

    const { handleReviewNotification } = await import("@/reviews/pubsub.service");

    const result = await handleReviewNotification(
      { notificationType: "NEW_REVIEW", reviewName: "accounts/acct-1/locations/loc-1/reviews/rev-1" },
      "msg-1",
    );

    expect(result.action).toBe("targeted_fetch");
    expect(getReview).toHaveBeenCalledWith("acct-1", "loc-1", "rev-1");
    expect(listReviews).not.toHaveBeenCalled();

    expect(ingestReview).toHaveBeenCalledWith(
      googleReview("rev-1"),
      expect.objectContaining({ googleAccountId: "acct-1", googleLocationId: "loc-1", locationTitle: "Riverside Auto" }),
    );

    expect(resolveLocationConfig).toHaveBeenCalledWith("location-row-1");
    expect(processReview).toHaveBeenCalledWith("row-1", { actor: "pubsub", business: null, settings: null });
    expect(result.totals).toEqual({ created: 1, updated: 0, unchanged: 0, failed: 0, processed: 1 });
  });

  it("does not auto-process a review that ingest resolved as unchanged (duplicate delivery)", async () => {
    getReview.mockResolvedValue(googleReview("rev-1"));
    ingestReview.mockResolvedValue({ action: "unchanged", reviewId: "row-1", status: "PUBLISHED", isEdited: false });

    const { handleReviewNotification } = await import("@/reviews/pubsub.service");

    const result = await handleReviewNotification(
      { notificationType: "UPDATED_REVIEW", reviewName: "accounts/acct-1/locations/loc-1/reviews/rev-1" },
      "msg-1",
    );

    expect(processReview).not.toHaveBeenCalled();
    expect(result.totals).toEqual({ created: 0, updated: 0, unchanged: 1, failed: 0, processed: 0 });
  });

  it("falls back to resyncing every synced location when the notification carries no recognizable review resource name", async () => {
    listReviews.mockResolvedValue([googleReview("rev-1"), googleReview("rev-2")]);
    ingestReview
      .mockResolvedValueOnce({ action: "created", reviewId: "row-1", status: "RECEIVED", isEdited: false })
      .mockResolvedValueOnce({ action: "unchanged", reviewId: "row-2", status: "PUBLISHED", isEdited: false });
    findReviewById.mockResolvedValue({ id: "row-1", location_id: "location-row-1" });
    processReview.mockResolvedValue({ outcome: "generated", status: "PENDING_APPROVAL", decision: "REQUIRE_APPROVAL" });

    const { handleReviewNotification } = await import("@/reviews/pubsub.service");

    const result = await handleReviewNotification({ notificationType: "NEW_REVIEW" }, "msg-1");

    expect(result.action).toBe("fallback_resync");
    expect(getReview).not.toHaveBeenCalled();
    expect(listReviews).toHaveBeenCalledWith("acct-1", "loc-1");
    expect(ingestReview).toHaveBeenCalledTimes(2);
    expect(processReview).toHaveBeenCalledTimes(1);
    expect(result.totals).toEqual({ created: 1, updated: 0, unchanged: 1, failed: 0, processed: 1 });
  });

  it("falls back when reviewName doesn't match the accounts/.../locations/.../reviews/... shape", async () => {
    listReviews.mockResolvedValue([]);

    const { handleReviewNotification } = await import("@/reviews/pubsub.service");

    const result = await handleReviewNotification(
      { notificationType: "NEW_REVIEW", reviewName: "not-a-real-resource-name" },
      "msg-1",
    );

    expect(result.action).toBe("fallback_resync");
    expect(getReview).not.toHaveBeenCalled();
  });

  it("tallies a failed fetch instead of throwing out of the handler", async () => {
    getReview.mockRejectedValue(new Error("Google returned HTTP 500."));

    const { handleReviewNotification } = await import("@/reviews/pubsub.service");

    await expect(
      handleReviewNotification(
        { notificationType: "NEW_REVIEW", reviewName: "accounts/acct-1/locations/loc-1/reviews/rev-1" },
        "msg-1",
      ),
    ).rejects.toThrow("Google returned HTTP 500.");
  });

  it("keeps resyncing other locations when one location's listReviews call fails", async () => {
    listSyncedLocations.mockResolvedValue([
      { googleAccountId: "acct-1", googleLocationId: "loc-1", locationTitle: "Loc One" },
      { googleAccountId: "acct-1", googleLocationId: "loc-2", locationTitle: "Loc Two" },
    ]);
    listReviews.mockRejectedValueOnce(new Error("quota exceeded")).mockResolvedValueOnce([googleReview("rev-9")]);
    ingestReview.mockResolvedValue({ action: "unchanged", reviewId: "row-9", status: "PUBLISHED", isEdited: false });

    const { handleReviewNotification } = await import("@/reviews/pubsub.service");

    const result = await handleReviewNotification({ notificationType: "NEW_REVIEW" }, "msg-1");

    expect(result.totals.failed).toBe(1);
    expect(result.totals.unchanged).toBe(1);
    expect(listReviews).toHaveBeenCalledTimes(2);
  });
});

function emptyTotals() {
  return { created: 0, updated: 0, unchanged: 0, failed: 0, processed: 0 };
}
