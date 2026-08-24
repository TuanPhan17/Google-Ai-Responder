import type { NextRequest } from "next/server";
import { z } from "zod";

import { findReviewById } from "@/database/repositories/review.repository";
import { processReview } from "@/reviews/processing.service";
import { resolveLocationConfig } from "@/reviews/settings.service";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z.object({ actor: z.string().min(1).max(120).optional() });

/**
 * Generates the first AI draft for a RECEIVED review.
 *
 * In the full product this is what Pub/Sub would trigger automatically the
 * moment a review lands — that notification webhook is still the
 * outstanding half of Phase 7 (see docs/SPEC.md). Until it exists, this route
 * is how a review actually enters the pipeline: the dashboard's "Generate
 * response" action for a RECEIVED row, calling the exact same
 * `processReview` function a future webhook would call.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdmin("reviews.process", async () => {
    const { id } = await context.params;
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestError("Invalid review id.");

    const parsedBody = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) throw new BadRequestError("Invalid request body.");

    const review = await findReviewById(parsedId.data);
    if (!review) throw new BadRequestError("No review with that id.", { reviewId: parsedId.data });

    const { business, settings } = await resolveLocationConfig(review.location_id);

    return processReview(parsedId.data, { actor: parsedBody.data.actor, business, settings });
  });
}
