import type { NextRequest } from "next/server";
import { z } from "zod";

import { syncLocations } from "@/reviews/sync.service";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

// Validated rather than interpolated: this value becomes part of a Google URL
// path, so an unchecked string is a request-forgery vector.
const accountSchema = z.string().regex(/^accounts\/[A-Za-z0-9_-]+$/, "expected accounts/{accountId}");

export async function GET(request: NextRequest) {
  return withAdmin("google.locations", async () => {
    const parsed = accountSchema.safeParse(new URL(request.url).searchParams.get("account"));
    if (!parsed.success) {
      throw new BadRequestError("Provide an account as accounts/{accountId}.");
    }

    return { locations: await syncLocations(parsed.data) };
  });
}
