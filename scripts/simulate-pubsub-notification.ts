import { randomUUID } from "node:crypto";

import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * POSTs a fake Cloud Pub/Sub push request at a running dev server, shaped
 * exactly like Pub/Sub's own push envelope, so `/api/pubsub/reviews` can be
 * exercised end to end before there is a real Pub/Sub subscription (or real
 * Google API access) to test it against — same reasoning as the mock
 * `ReviewSource` itself (src/reviews/review-source.ts): the seam this app
 * needs to iterate on is the handling logic, not the network transport.
 *
 * Requires the dev server running with PUBSUB_SKIP_VERIFICATION=true (there
 * is no real OIDC-signing Pub/Sub service to produce a token this script
 * could send instead) and MOCK_MODE=true (so the notification resolves
 * against the mock fixtures' real account/location/review ids).
 *
 * Run: npx tsx scripts/simulate-pubsub-notification.ts
 * Optional: PUBSUB_TARGET_URL=http://localhost:3000 (default)
 */

const BASE_URL = process.env.PUBSUB_TARGET_URL ?? "http://localhost:3000";

function pushEnvelope(notification: Record<string, unknown>) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(notification)).toString("base64"),
      messageId: `sim-${Date.now()}-${randomUUID().slice(0, 8)}`,
      publishTime: new Date().toISOString(),
      attributes: {},
    },
    subscription: "projects/simulated/subscriptions/reviews-push",
  };
}

async function post(label: string, notification: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/pubsub/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pushEnvelope(notification)),
  });
  const body = await response.json().catch(() => null);
  console.log(`\n${label}`);
  console.log(`  HTTP ${response.status}`);
  console.log(`  ${JSON.stringify(body)}`);
}

async function main() {
  const { MOCK_ACCOUNT_ID, MOCK_LOCATION_ID, MOCK_FIXTURES } = await import("@/mocks/fixtures");
  const reviewId = MOCK_FIXTURES[0]?.review.reviewId ?? "rev-001";
  const reviewName = `accounts/${MOCK_ACCOUNT_ID}/locations/${MOCK_LOCATION_ID}/reviews/${reviewId}`;

  await post("1) Irrelevant notification type — should be acknowledged and ignored", {
    notificationType: "GOOGLE_UPDATE",
  });

  await post("2) NEW_REVIEW with a parseable reviewName — targeted fetch", {
    notificationType: "NEW_REVIEW",
    reviewName,
  });

  await post("3) Same notification again — duplicate delivery should resolve to 'unchanged', not a second row", {
    notificationType: "NEW_REVIEW",
    reviewName,
  });

  await post("4) NEW_REVIEW with no reviewName — fallback resync of every synced location", {
    notificationType: "NEW_REVIEW",
  });

  console.log(
    "\nCheck the dashboard's New Reviews tab — a genuinely new review from this run should already be GENERATED/PENDING_APPROVAL, not sitting at RECEIVED, because the webhook auto-processes it.",
  );
}

main().catch((error) => {
  console.error("Simulation failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
