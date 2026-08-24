import { z } from "zod";

import { findReviewById, listEvents } from "@/database/repositories/review.repository";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

/** A single review with its full audit trail — the detail view behind the approval queue. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return withAdmin("reviews.get", async () => {
    const { id } = await context.params;
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestError("Invalid review id.");

    const review = await findReviewById(parsed.data);
    if (!review) throw new BadRequestError("No review with that id.", { reviewId: parsed.data });

    return { review, events: await listEvents(parsed.data) };
  });
}
