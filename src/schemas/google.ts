import { z } from "zod";

/**
 * Every Google response is validated here before it reaches domain code.
 *
 * Two conventions throughout:
 *
 *  - `.passthrough()` on object schemas. Google adds fields regularly; a strict
 *    schema would turn a harmless additive change into a production outage. We
 *    validate what we *use* and ignore the rest.
 *
 *  - Optional almost everywhere. Google omits fields rather than nulling them:
 *    an anonymous reviewer has no `displayName`, a star-only review has no
 *    `comment`, a service-area business has no address. Treating those as
 *    required is the most common source of runtime crashes in this integration.
 */

export const googleTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    token_type: z.string().min(1),
    scope: z.string().optional(),
    /**
     * Only present on the first authorization, or when `prompt=consent` is
     * forced. Refresh flows never return it, which is why the token store must
     * keep the original.
     */
    refresh_token: z.string().min(1).optional(),
    id_token: z.string().optional(),
  })
  .passthrough();
export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

export const googleErrorResponseSchema = z
  .object({
    error: z.union([
      z.string(),
      z
        .object({
          code: z.number().optional(),
          message: z.string().optional(),
          status: z.string().optional(),
        })
        .passthrough(),
    ]),
    error_description: z.string().optional(),
  })
  .passthrough();

export const googleAccountSchema = z
  .object({
    name: z.string().regex(/^accounts\/[^/]+$/, "expected accounts/{accountId}"),
    accountName: z.string().optional(),
    type: z.string().optional(),
    verificationState: z.string().optional(),
    vettedState: z.string().optional(),
  })
  .passthrough();

export const listAccountsResponseSchema = z
  .object({
    accounts: z.array(googleAccountSchema).optional(),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

const postalAddressSchema = z
  .object({
    addressLines: z.array(z.string()).optional(),
    locality: z.string().optional(),
    administrativeArea: z.string().optional(),
    postalCode: z.string().optional(),
    regionCode: z.string().optional(),
  })
  .passthrough();

export const googleLocationSchema = z
  .object({
    name: z.string().regex(/^locations\/[^/]+$/, "expected locations/{locationId}"),
    title: z.string().optional(),
    storeCode: z.string().optional(),
    websiteUri: z.string().optional(),
    storefrontAddress: postalAddressSchema.optional(),
    metadata: z
      .object({
        mapsUri: z.string().optional(),
        placeId: z.string().optional(),
        newReviewUri: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const listLocationsResponseSchema = z
  .object({
    locations: z.array(googleLocationSchema).optional(),
    nextPageToken: z.string().optional(),
    totalSize: z.number().optional(),
  })
  .passthrough();

/**
 * Google's star rating is an enum string, not a number, and
 * STAR_RATING_UNSPECIFIED is a real value we have to tolerate.
 */
export const starRatingSchema = z.enum([
  "STAR_RATING_UNSPECIFIED",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
]);
export type StarRating = z.infer<typeof starRatingSchema>;

export const googleReviewReplySchema = z
  .object({
    comment: z.string(),
    updateTime: z.string().optional(),
  })
  .passthrough();

export const googleReviewSchema = z
  .object({
    /** Full resource name. Absent on some batchGet shapes, so kept optional. */
    name: z.string().optional(),
    reviewId: z.string().min(1),
    reviewer: z
      .object({
        displayName: z.string().optional(),
        profilePhotoUrl: z.string().optional(),
        isAnonymous: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    starRating: starRatingSchema,
    /** Absent for star-only reviews. */
    comment: z.string().optional(),
    createTime: z.string(),
    updateTime: z.string(),
    reviewReply: googleReviewReplySchema.optional(),
  })
  .passthrough();
export type GoogleReview = z.infer<typeof googleReviewSchema>;

export const listReviewsResponseSchema = z
  .object({
    reviews: z.array(googleReviewSchema).optional(),
    averageRating: z.number().optional(),
    totalReviewCount: z.number().optional(),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

/** Pulls `{accountId}` out of `accounts/{accountId}`. */
export function extractAccountId(resourceName: string): string {
  const match = /^accounts\/([^/]+)$/.exec(resourceName);
  if (!match?.[1]) throw new Error(`Not an account resource name: ${resourceName}`);
  return match[1];
}

/** Pulls `{locationId}` out of `locations/{locationId}`. */
export function extractLocationId(resourceName: string): string {
  const match = /^locations\/([^/]+)$/.exec(resourceName);
  if (!match?.[1]) throw new Error(`Not a location resource name: ${resourceName}`);
  return match[1];
}
