import type { NextRequest } from "next/server";
import { z } from "zod";

import { syncReviews } from "@/reviews/sync.service";
import { listReviews } from "@/database/repositories/review.repository";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

const syncSchema = z.object({
  accountId: idSchema,
  locationId: idSchema,
  locationTitle: z.string().max(300).nullish(),
});

/** Reads what is already stored. Does not call Google. */
export async function GET() {
  return withAdmin("reviews.list", async () => ({ reviews: await listReviews({ limit: 100 }) }));
}

/**
 * Pulls reviews from the active source and stores them.
 *
 * POST rather than GET because this writes: it creates rows, records audit
 * events and consumes Google quota. A GET that mutates is a GET a browser will
 * eventually prefetch.
 */
export async function POST(request: NextRequest) {
  return withAdmin("reviews.sync", async () => {
    const parsed = syncSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new BadRequestError("Provide accountId and locationId.");
    }

    const totals = await syncReviews(
      parsed.data.accountId,
      parsed.data.locationId,
      parsed.data.locationTitle ?? null,
    );

    return { ...totals, reviews: await listReviews({ limit: 100 }) };
  });
}
