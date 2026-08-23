import { NextResponse } from "next/server";

import { isSignedIn } from "@/auth/session";
import { toHttpStatus, toPublicMessage, UnauthorizedError } from "@/utils/errors";
import { logger } from "@/utils/logger";

/**
 * Wrapper applied to every JSON API route.
 *
 * Centralizes three things a route must never forget: the session check, the
 * error-to-status mapping, and the rule that internal error context is logged
 * but never returned to the browser.
 */
export async function withAdmin<T>(label: string, handler: () => Promise<T>): Promise<NextResponse> {
  try {
    if (!(await isSignedIn())) throw new UnauthorizedError();

    const data = await handler();
    return NextResponse.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    logger.error(`API route failed: ${label}`, {
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      { ok: false, error: toPublicMessage(error) },
      { status: toHttpStatus(error), headers: { "cache-control": "no-store" } },
    );
  }
}
