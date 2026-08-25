import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getEnv } from "@/config/env";
import { verifyPubSubPushToken } from "@/google/pubsub-auth";
import { handleReviewNotification } from "@/reviews/pubsub.service";
import { googleNotificationSchema, pubSubPushEnvelopeSchema } from "@/schemas/pubsub";
import { toHttpStatus, toPublicMessage } from "@/utils/errors";
import { logger } from "@/utils/logger";

export const dynamic = "force-dynamic";

const log = logger.child("api.pubsub.reviews");

/**
 * Cloud Pub/Sub push endpoint for Business Profile review notifications.
 *
 * Not wrapped in `withAdmin` (src/app/api/_lib/handler.ts) — that gate checks
 * the admin session cookie, which a Pub/Sub push request will never carry.
 * This route's authentication is `verifyPubSubPushToken`'s OIDC check instead,
 * and `middleware.ts` allowlists this path so it isn't redirected to /login
 * before ever reaching here.
 *
 * ## Status codes are load-bearing, not cosmetic
 *
 * Pub/Sub retries a push until it gets a 2xx. A malformed message (bad
 * base64, JSON that doesn't parse, an unrecognized shape) will never succeed
 * no matter how many times it's retried — "Do not retry permanently invalid
 * requests indefinitely" applies here exactly as it does to the rest of this
 * app's retry policy, so those cases return 200 (acknowledge and drop) after
 * logging. A genuine processing failure (Google's API down, the database
 * unreachable) is the opposite: retrying later might well succeed, so those
 * return 500 and let Pub/Sub's own backoff handle it. An auth failure returns
 * 401 — not an ack, since that request wasn't legitimately from Pub/Sub in
 * the first place.
 */
export async function POST(request: NextRequest) {
  const env = getEnv();

  if (env.PUBSUB_SKIP_VERIFICATION) {
    log.warn("PUBSUB_SKIP_VERIFICATION is true — accepting this push without verifying its OIDC token. Dev/test only.");
  } else {
    try {
      await verifyPubSubPushToken(request.headers.get("authorization"));
    } catch (error) {
      log.warn("Rejected an unverified Pub/Sub push request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json({ ok: false, error: toPublicMessage(error) }, { status: toHttpStatus(error) });
    }
  }

  const rawBody = await request.json().catch(() => null);
  const envelope = pubSubPushEnvelopeSchema.safeParse(rawBody);
  if (!envelope.success) {
    log.warn("Malformed Pub/Sub push envelope — acknowledging without processing", {
      issues: envelope.error.issues.map((issue) => issue.path.join(".")),
    });
    return NextResponse.json({ ok: true, skipped: "malformed_envelope" });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(envelope.data.message.data, "base64").toString("utf8"));
  } catch (error) {
    log.warn("Pub/Sub message data was not valid base64/JSON — acknowledging without processing", {
      messageId: envelope.data.message.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: true, skipped: "undecodable_payload" });
  }

  const notification = googleNotificationSchema.safeParse(decoded);
  if (!notification.success) {
    log.warn("Decoded Pub/Sub payload was not a recognizable notification object — acknowledging without processing", {
      messageId: envelope.data.message.messageId,
    });
    return NextResponse.json({ ok: true, skipped: "unrecognized_payload" });
  }

  try {
    const result = await handleReviewNotification(notification.data, envelope.data.message.messageId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    log.error("Failed to handle a Pub/Sub review notification — Pub/Sub will retry", {
      messageId: envelope.data.message.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: toPublicMessage(error) }, { status: 500 });
  }
}
