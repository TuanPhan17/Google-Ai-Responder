import type { NextRequest } from "next/server";
import { z } from "zod";

import { upsertBusinessSettings } from "@/database/repositories/settings.repository";
import { BadRequestError } from "@/utils/errors";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

/** `""` from an emptied text input reads as "no value," not the literal empty string. */
const nullableText = (max: number) =>
  z.preprocess((value) => (value === "" || value === undefined ? null : value), z.string().max(max).nullable());

const bodySchema = z.object({
  businessName: nullableText(200),
  businessDescription: nullableText(2000),
  brandVoice: nullableText(500),
  preferredTone: nullableText(200),
  // DB CHECK constraint (business_settings_max_len) pins this to 120-2000; matched here
  // so a bad value is a clean 400 instead of a raw Postgres constraint error.
  maxResponseChars: z.coerce.number().int().min(120).max(2000),
  contactPhone: nullableText(60),
  contactEmail: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    z.string().email().max(200).nullable(),
  ),
  escalationInstructions: nullableText(2000),
  phrasesToAvoid: z.array(z.string().max(200)).max(50),
  approvedPolicies: z.array(z.string().max(500)).max(50),
  locationNotes: nullableText(2000),
  autoPublishFiveStar: z.boolean(),
  autoPublishFourStar: z.boolean(),
  // DB CHECK constraint (business_settings_min_rating) pins this to 4-5, same reason as above.
  minAutoPublishRating: z.coerce.number().int().min(4).max(5),
});

/** `locationId` is the internal DB row id (locations.id), not Google's location id. */
export async function PUT(request: NextRequest, context: { params: Promise<{ locationId: string }> }) {
  return withAdmin("settings.update", async () => {
    const { locationId } = await context.params;
    const parsedId = idSchema.safeParse(locationId);
    if (!parsedId.success) throw new BadRequestError("Invalid location id.");

    const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsedBody.success) {
      throw new BadRequestError("Invalid settings payload.", { issues: parsedBody.error.issues });
    }

    const settings = await upsertBusinessSettings(parsedId.data, parsedBody.data);
    return { settings };
  });
}
