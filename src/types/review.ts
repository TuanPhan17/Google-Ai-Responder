/**
 * Domain model.
 *
 * These types are deliberately decoupled from Google's wire format. Google
 * gives us `starRating: "FIVE"`; the rest of the application wants a number it
 * can compare against a publishing threshold. Mapping once, at the boundary,
 * keeps that string out of the policy engine we build in Phase 3.
 */

export const REVIEW_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "GENERATED",
  "PENDING_APPROVAL",
  "APPROVED",
  "PUBLISHED",
  "REJECTED",
  "FAILED",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SENTIMENTS = ["positive", "mixed", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const PUBLISH_DECISIONS = ["AUTO_PUBLISH", "REQUIRE_APPROVAL", "BLOCKED"] as const;
export type PublishDecision = (typeof PUBLISH_DECISIONS)[number];

export const GOOGLE_REPLY_STATES = [
  "NONE",
  "EXISTING_REPLY_FOUND",
  "PUBLISH_PENDING",
  "PUBLISHED",
  "PUBLISH_FAILED",
] as const;
export type GoogleReplyState = (typeof GOOGLE_REPLY_STATES)[number];

export const AUDIT_EVENTS = [
  "REVIEW_RECEIVED",
  "REVIEW_EDITED",
  "REVIEW_UNCHANGED",
  "EXISTING_REPLY_DETECTED",
  "AI_GENERATION_STARTED",
  "AI_GENERATION_COMPLETED",
  "AI_GENERATION_FAILED",
  "RESPONSE_REGENERATED",
  "RESPONSE_EDITED_BY_HUMAN",
  "APPROVED",
  "REJECTED",
  "AUTO_PUBLISH_DECISION",
  "RESPONSE_PUBLISHED",
  "PUBLISH_FAILED",
  "GOOGLE_CONNECTED",
  "GOOGLE_DISCONNECTED",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/** A review after mapping from Google's shape, before any AI involvement. */
export interface NormalizedReview {
  googleReviewId: string;
  /** Full Google resource name: accounts/{a}/locations/{l}/reviews/{r} */
  googleReviewName: string;
  googleAccountId: string;
  googleLocationId: string;
  locationTitle: string | null;
  reviewerName: string | null;
  /** First token of the display name, or null. Used only when it reads naturally. */
  reviewerFirstName: string | null;
  reviewerIsAnonymous: boolean;
  /** 1-5, or null when Google reports STAR_RATING_UNSPECIFIED. */
  rating: number | null;
  /** null for a star-only review. Empty strings are normalized to null. */
  reviewText: string | null;
  reviewCreateTime: string;
  reviewUpdateTime: string;
  existingReplyText: string | null;
  existingReplyUpdateTime: string | null;
}

export interface AccountSummary {
  /** Resource name: accounts/{accountId} */
  name: string;
  accountId: string;
  accountName: string | null;
  type: string | null;
  verificationState: string | null;
}

export interface LocationSummary {
  /** Resource name: locations/{locationId} */
  name: string;
  locationId: string;
  title: string | null;
  storeCode: string | null;
  websiteUri: string | null;
  mapsUri: string | null;
  placeId: string | null;
  /** Formatted single-line address, or null for service-area businesses. */
  address: string | null;
}

export type IngestAction = "created" | "updated" | "unchanged";

export interface IngestResult {
  action: IngestAction;
  reviewId: string;
  status: ReviewStatus;
  isEdited: boolean;
  hasExistingGoogleReply: boolean;
}
