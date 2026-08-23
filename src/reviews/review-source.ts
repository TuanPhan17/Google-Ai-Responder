import { isMockMode } from "@/config/env";
import type { GoogleReview } from "@/schemas/google";
import type { AccountSummary, LocationSummary } from "@/types/review";
import { listAccounts } from "@/google/accounts.service";
import { listLocations } from "@/google/locations.service";
import { getReview, listReviews } from "@/google/reviews.service";
import {
  MOCK_ACCOUNT_ID,
  MOCK_LOCATION_ID,
  MOCK_LOCATION_TITLE,
  MOCK_FIXTURES,
  fixturesAsListResponse,
} from "@/mocks/fixtures";

/**
 * The seam between "where reviews come from" and everything that processes
 * them.
 *
 * This exists because Google's API access approval takes one to two weeks, and
 * the review-processing pipeline is the part of this system that actually
 * needs iteration. Putting the boundary at *data source* rather than at
 * *HTTP client* means the mock exercises the real mapper, the real database
 * writes, the real idempotency logic, and later the real policy engine —
 * everything except the network call.
 *
 * A mock that stubbed the whole ingest path would test nothing worth testing.
 */
export interface ReviewSource {
  readonly kind: "google" | "mock";
  listAccounts(): Promise<AccountSummary[]>;
  listLocations(accountResourceName: string): Promise<LocationSummary[]>;
  listReviews(accountId: string, locationId: string): Promise<GoogleReview[]>;
  getReview(accountId: string, locationId: string, reviewId: string): Promise<GoogleReview>;
}

const googleSource: ReviewSource = {
  kind: "google",
  listAccounts,
  listLocations,
  listReviews: async (accountId, locationId) => (await listReviews(accountId, locationId)).reviews,
  getReview,
};

const mockSource: ReviewSource = {
  kind: "mock",

  listAccounts: async () => [
    {
      name: `accounts/${MOCK_ACCOUNT_ID}`,
      accountId: MOCK_ACCOUNT_ID,
      accountName: "Riverside Auto Group (mock)",
      type: "LOCATION_GROUP",
      verificationState: "VERIFIED",
    },
  ],

  listLocations: async () => [
    {
      name: `locations/${MOCK_LOCATION_ID}`,
      locationId: MOCK_LOCATION_ID,
      title: MOCK_LOCATION_TITLE,
      storeCode: "RIV-01",
      websiteUri: "https://example.invalid/riverside-auto",
      mapsUri: null,
      placeId: null,
      address: "1400 Riverside Drive, Everett, WA, 98201",
    },
  ],

  listReviews: async () => fixturesAsListResponse(),

  getReview: async (_accountId, _locationId, reviewId) => {
    const fixture = MOCK_FIXTURES.find((item) => item.review.reviewId === reviewId);
    if (!fixture) throw new Error(`No mock fixture with reviewId "${reviewId}".`);
    return fixture.review;
  },
};

export function getReviewSource(): ReviewSource {
  return isMockMode() ? mockSource : googleSource;
}
