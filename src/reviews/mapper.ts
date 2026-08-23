import type { GoogleReview, StarRating } from "@/schemas/google";
import type { NormalizedReview } from "@/types/review";

/**
 * The Google → domain boundary.
 *
 * Everything downstream — the policy engine, the prompt builder, the dashboard
 * — reads `NormalizedReview` and never touches Google's wire types. That is
 * what keeps `starRating: "THREE"` from leaking into a comparison that should
 * be `rating <= 3`.
 */

const STAR_VALUES: Record<StarRating, number | null> = {
  STAR_RATING_UNSPECIFIED: null,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export function starRatingToNumber(rating: StarRating): number | null {
  return STAR_VALUES[rating];
}

/**
 * Normalizes review text.
 *
 * Google omits `comment` for a star-only review, but also sometimes sends
 * whitespace-only strings. Both must collapse to null, because "is there text
 * to reference?" is the question that decides whether the generator is allowed
 * to mention specifics at all. A string of three spaces answering "yes" is how
 * a bot ends up inventing an experience.
 */
export function normalizeText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extracts a usable first name.
 *
 * Deliberately conservative: the first whitespace-separated token, and only
 * when it looks like a plain name. No gender inference, no honorific parsing,
 * no guessing at cultural name order — a wrong guess here is addressed to a
 * real customer in public. When in doubt, return null and let the response omit
 * the name entirely.
 */
export function extractFirstName(displayName: string | undefined): string | null {
  if (!displayName) return null;

  const first = displayName.trim().split(/\s+/)[0];
  if (!first) return null;

  // Reject handles, initials-only, and anything with digits or symbols.
  if (first.length < 2 || first.length > 24) return null;
  if (!/^[\p{L}][\p{L}\p{M}'’-]*$/u.test(first)) return null;
  if (/^[A-Z]\.?$/.test(first)) return null;

  return first;
}

export interface MapReviewContext {
  googleAccountId: string;
  googleLocationId: string;
  locationTitle?: string | null;
}

export function mapGoogleReview(review: GoogleReview, context: MapReviewContext): NormalizedReview {
  const displayName = review.reviewer?.displayName;
  const isAnonymous = review.reviewer?.isAnonymous === true;

  return {
    googleReviewId: review.reviewId,
    googleReviewName:
      review.name ??
      `accounts/${context.googleAccountId}/locations/${context.googleLocationId}/reviews/${review.reviewId}`,
    googleAccountId: context.googleAccountId,
    googleLocationId: context.googleLocationId,
    locationTitle: context.locationTitle ?? null,
    // An anonymous reviewer has no name to use, even if Google sends a
    // placeholder display name.
    reviewerName: isAnonymous ? null : (normalizeText(displayName) ?? null),
    reviewerFirstName: isAnonymous ? null : extractFirstName(displayName),
    reviewerIsAnonymous: isAnonymous,
    rating: starRatingToNumber(review.starRating),
    reviewText: normalizeText(review.comment),
    reviewCreateTime: review.createTime,
    reviewUpdateTime: review.updateTime,
    existingReplyText: normalizeText(review.reviewReply?.comment),
    existingReplyUpdateTime: review.reviewReply?.updateTime ?? null,
  };
}

/** True when the customer changed the substance of the review, not just its timestamp. */
export function hasContentChanged(
  previous: { rating: number | null; reviewText: string | null },
  next: NormalizedReview,
): boolean {
  return previous.rating !== next.rating || previous.reviewText !== next.reviewText;
}
