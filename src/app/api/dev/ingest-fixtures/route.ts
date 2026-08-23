import { z } from "zod";
import type { NextRequest } from "next/server";

import { isMockMode } from "@/config/env";
import { MOCK_ACCOUNT_ID, MOCK_FIXTURES, MOCK_LOCATION_ID, MOCK_LOCATION_TITLE, getFixture } from "@/mocks/fixtures";
import { ingestReview } from "@/reviews/ingest.service";
import { syncLocations } from "@/reviews/sync.service";
import { listReviews } from "@/database/repositories/review.repository";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Fixture keys to ingest, in order. Omit to run all fourteen. */
  keys: z.array(z.string()).max(50).optional(),
});

/**
 * Development-only fixture runner.
 *
 * Feeds fixtures through the *real* ingest path — mapper, database, uniqueness
 * constraint, audit trail — so the duplicate and edited-review cases are proven
 * against the actual implementation rather than a stub.
 *
 * Order matters for two fixtures: `duplicate-event` must follow
 * `positive-detailed`, and `edited-review` must follow
 * `four-star-minor-criticism`. The default order in MOCK_FIXTURES already
 * satisfies both.
 */
export async function POST(request: NextRequest) {
  return withAdmin("dev.ingestFixtures", async () => {
    // Hard gate. Even with a valid session, this route stays dark outside mock
    // mode — fixtures must never be able to reach a real business's data.
    if (!isMockMode()) {
      throw new BadRequestError("Fixture ingestion is only available when MOCK_MODE=true.");
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequestError("Invalid request body.");

    // Ensure the mock location row exists so ingest has something to attach to.
    await syncLocations(`accounts/${MOCK_ACCOUNT_ID}`);

    const selected = parsed.data.keys?.length
      ? parsed.data.keys.map((key) => {
          const fixture = getFixture(key);
          if (!fixture) throw new BadRequestError(`No fixture named "${key}".`);
          return fixture;
        })
      : MOCK_FIXTURES;

    const results: Array<{ key: string; purpose: string; action: string; reviewId: string }> = [];

    for (const fixture of selected) {
      const result = await ingestReview(fixture.review, {
        googleAccountId: MOCK_ACCOUNT_ID,
        googleLocationId: MOCK_LOCATION_ID,
        locationTitle: MOCK_LOCATION_TITLE,
        actor: "fixture-runner",
      });

      results.push({
        key: fixture.key,
        purpose: fixture.purpose,
        action: result.action,
        reviewId: result.reviewId,
      });
    }

    return { results, reviews: await listReviews({ limit: 100 }) };
  });
}
