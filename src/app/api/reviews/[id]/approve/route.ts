import type { NextRequest } from "next/server";
import { z } from "zod";

import { approveReview } from "@/reviews/approval.service";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z.object({ actor: z.string().min(1).max(120).optional() });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdmin("reviews.approve", async () => {
    const { id } = await context.params;
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestError("Invalid review id.");

    const parsedBody = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) throw new BadRequestError("Invalid request body.");

    return approveReview(parsedId.data, { actor: parsedBody.data.actor });
  });
}
