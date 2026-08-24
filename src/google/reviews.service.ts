import { GOOGLE_MAX_PAGE_SIZE, LEGACY_MY_BUSINESS_BASE } from "@/config/google-api";
import { googleRequest, paginate } from "@/google/client";
import {
  googleReviewReplySchema,
  googleReviewSchema,
  listReviewsResponseSchema,
  type GoogleReview,
} from "@/schemas/google";

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
 * `updateReply` (Phase 6) is a PUT to a single reply resource per review, not
 * a POST that appends — Google models "the business's reply" as one slot per
 * review, addressable at .../reviews/{reviewId}/reply. Calling it twice with
 * the same comment produces the same end state, not two replies. That
 * idempotency is what src/reviews/publishing.service.ts leans on to recover
 * safely from an ambiguous failure (Google accepted the write, but the
 * process never found out).
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

export interface ReviewReply {
  comment: string;
  updateTime: string | null;
}

/**
 * Posts (or replaces) the business's reply to a review — the one write this
 * application performs against a customer-visible Google surface.
 *
 * Goes through the same `googleRequest` path as every read: authenticated,
 * retried on 429/5xx with backoff, and 401-refreshed once. Retrying this
 * specific call is safe because of the PUT semantics described above — a
 * retried write after a network timeout can, at worst, set the same content
 * twice, never create a duplicate reply.
 */
export async function updateReply(
  accountId: string,
  locationId: string,
  reviewId: string,
  comment: string,
): Promise<ReviewReply> {
  const result = await googleRequest(
    {
      url: `${LEGACY_MY_BUSINESS_BASE}/${buildReviewParent(accountId, locationId)}/reviews/${reviewId}/reply`,
      method: "PUT",
      body: { comment },
      label: "reviews.updateReply",
    },
    googleReviewReplySchema,
  );
  return { comment: result.comment, updateTime: result.updateTime ?? null };
}
