import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkAdminPassword, createSession } from "@/auth/session";
import { logger } from "@/utils/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ password: z.string().min(1).max(200) });

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Enter your password." }, { status: 400 });
  }

  if (!checkAdminPassword(parsed.data.password)) {
    // No detail about *why* it failed, and no hint at the expected length.
    logger.warn("Rejected console sign-in attempt");
    return NextResponse.json({ ok: false, error: "That password is not correct." }, { status: 401 });
  }

  await createSession();
  return NextResponse.json({ ok: true });
}
