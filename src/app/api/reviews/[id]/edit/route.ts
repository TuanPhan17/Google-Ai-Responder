import type { NextRequest } from "next/server";
import { z } from "zod";

import { editReviewResponse } from "@/reviews/approval.service";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z.object({
  response: z.string().min(1).max(2000),
  actor: z.string().min(1).max(120).optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdmin("reviews.edit", async () => {
    const { id } = await context.params;
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestError("Invalid review id.");

    const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsedBody.success) throw new BadRequestError("Provide a non-empty response.");

    return editReviewResponse(parsedId.data, parsedBody.data.response, { actor: parsedBody.data.actor });
  });
}
