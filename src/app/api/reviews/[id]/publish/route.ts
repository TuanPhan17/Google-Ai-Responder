import type { NextRequest } from "next/server";
import { z } from "zod";

import { publishReview } from "@/reviews/publishing.service";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z.object({ actor: z.string().min(1).max(120).optional() });

/**
 * Publishes an APPROVED (human-approved) or GENERATED (auto-publish-eligible)
 * review's response to Google. See publishing.service.ts for the atomic
 * eligibility re-check and the existing-reply / recovery handling this route
 * relies on — the route itself is a thin, session-gated wrapper, same shape
 * as approve/reject/edit/regenerate.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdmin("reviews.publish", async () => {
    const { id } = await context.params;
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestError("Invalid review id.");

    const parsedBody = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) throw new BadRequestError("Invalid request body.");

    return publishReview(parsedId.data, { actor: parsedBody.data.actor });
  });
}
