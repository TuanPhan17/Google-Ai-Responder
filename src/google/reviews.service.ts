import { GOOGLE_MAX_PAGE_SIZE, LEGACY_MY_BUSINESS_BASE } from "@/config/google-api";
import { googleRequest, paginate } from "@/google/client";
import { googleReviewSchema, listReviewsResponseSchema, type GoogleReview } from "@/schemas/google";

/**
 * Reviews API — https://mybusiness.googleapis.com/v4
 *
 * Reviews are the one capability Google never moved off the legacy host. The
 * v4 endpoint is still live and documented (verified Aug 2026), but it is
 * enabled separately in Cloud Console ("Google My Business API") and is the
 * endpoint most likely to sit at zero quota until Google approves the project.
 *
 * Path shape: accounts/{accountId}/locations/{locationId}/reviews
 * Note this differs from the Business Information API, which addresses
 * locations as `locations/{locationId}` with no account segment.
 *
 * Phase 1 is read-only. `updateReply` lands in Phase 6, behind the publishing
 * policy — deliberately not here, so no code path in this phase can write to a
 * customer-visible surface.
 */

export function buildReviewParent(accountId: string, locationId: string): string {
  return `accounts/${accountId}/locations/${locationId}`;
}

export interface ListReviewsResult {
  reviews: GoogleReview[];
  averageRating: number | null;
  totalReviewCount: number | null;
}

export async function listReviews(
  accountId: string,
  locationId: string,
  options: { maxPages?: number } = {},
): Promise<ListReviewsResult> {
  const parent = buildReviewParent(accountId, locationId);
  let averageRating: number | null = null;
  let totalReviewCount: number | null = null;

  const reviews = await paginate(
    (pageToken) =>
      googleRequest(
        {
          url: `${LEGACY_MY_BUSINESS_BASE}/${parent}/reviews`,
          searchParams: { pageSize: GOOGLE_MAX_PAGE_SIZE, pageToken, orderBy: "updateTime desc" },
          label: "reviews.list",
        },
        listReviewsResponseSchema,
      ).then((page) => {
        averageRating ??= page.averageRating ?? null;
        totalReviewCount ??= page.totalReviewCount ?? null;
        return page;
      }),
    (page) => page.reviews ?? [],
    (page) => page.nextPageToken,
    options.maxPages ?? 10,
  );

  return { reviews, averageRating, totalReviewCount };
}

/**
 * Fetches one review directly.
 *
 * This is the function the Pub/Sub handler will call in Phase 7. Notifications
 * carry an identifier, not review content, and Google treats the API as the
 * authoritative copy — so we always re-read rather than trusting the payload.
 */
export async function getReview(
  accountId: string,
  locationId: string,
  reviewId: string,
): Promise<GoogleReview> {
  return googleRequest(
    {
      url: `${LEGACY_MY_BUSINESS_BASE}/${buildReviewParent(accountId, locationId)}/reviews/${reviewId}`,
      label: "reviews.get",
    },
    googleReviewSchema,
  );
}
