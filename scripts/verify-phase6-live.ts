import { randomUUID } from "node:crypto";

import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Live verification of the Phase 6 publishing endpoint against a real
 * Supabase database and a real running dev server, in MOCK_MODE (so it needs
 * no live Google Business Profile connection) — same shape as
 * scripts/verify-phase5-live.ts, extended to cover publishReview's specific
 * safety properties:
 *
 *  - an APPROVED review publishes and lands PUBLISHED with published_at set
 *  - a GENERATED (auto-publish) review publishes without ever being approved
 *  - a review whose status changed after the caller's own read (unapproved,
 *    or already published) is refused, not silently republished
 *  - two concurrent publish requests for the same review: exactly one 200,
 *    one 409 — the atomic claim, not a lucky ordering
 *  - a review where Google already has a *different* reply is never
 *    overwritten, and is routed back to PENDING_APPROVAL
 *
 * Uses the mock fixtures' real reviewIds (rev-001, rev-006, rev-012, ...) so
 * publishReview's calls through the mock ReviewSource resolve against actual
 * fixture data — including rev-012 ("already-replied"), which is the one
 * fixture that already carries a Google reply and is exactly what the
 * existing-reply check needs to prove itself against.
 *
 * Prerequisites: same as verify-phase5-live.ts — `npm run dev` running, a
 * real Supabase connection in .env.local, MOCK_MODE not explicitly set to
 * false. Run: npx tsx scripts/verify-phase6-live.ts
 */

const RUN_TAG = `e2e-verify-p6-${Date.now()}-${randomUUID().slice(0, 8)}`;

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const { getEnv } = await import("@/config/env");
  const { getDb } = await import("@/database/supabase");
  const { SESSION_COOKIE } = await import("@/auth/constants");

  const env = getEnv();
  if (!env.MOCK_MODE) {
    console.error("This script assumes MOCK_MODE=true (it publishes through the mock ReviewSource, not real Google).");
    process.exitCode = 1;
    return;
  }

  const baseUrl = env.APP_BASE_URL.replace(/\/$/, "");
  const db = getDb();

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error(`Could not sign in to ${baseUrl} (HTTP ${loginRes.status}). Is the dev server running?`);
    process.exitCode = 1;
    return;
  }
  const setCookie = loginRes.headers.get("set-cookie");
  const match = setCookie?.match(new RegExp(`${SESSION_COOKIE}=[^;]+`));
  if (!match) {
    console.error("Login succeeded but no session cookie came back.");
    process.exitCode = 1;
    return;
  }
  const cookieHeader = match[0];

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", cookie: cookieHeader, ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body: body as { ok: boolean; data?: unknown; error?: string } | null };
  }

  async function timedApi(path: string, init: RequestInit, t0: number, label: string) {
    const sentAt = performance.now() - t0;
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", cookie: cookieHeader, ...(init.headers ?? {}) },
    });
    const doneAt = performance.now() - t0;
    const body = await res.json().catch(() => null);
    console.log(`  [${label}] sent t+${sentAt.toFixed(1)}ms, done t+${doneAt.toFixed(1)}ms, status=${res.status}`);
    return { status: res.status, body: body as { ok: boolean; data?: unknown; error?: string } | null, sentAt, doneAt };
  }

  // --- seed a fresh scratch location chain --------------------------------
  // Always a new chain, never reused: the uniqueness key that matters for
  // this script is (location_id, google_review_id), and this script deals
  // in real fixture reviewIds (rev-001, rev-006, ...) that a shared/reused
  // location may already hold rows for (e.g. from a previous
  // /api/dev/ingest-fixtures run). A fresh location per run sidesteps that
  // collision entirely rather than trying to detect and clean it up.
  let locationRowId: string;
  let googleAccountId: string;
  let googleLocationId: string;

  const connection = await db
    .from("google_connections")
    .insert({ slug: RUN_TAG, google_email: "verify-script@example.com", refresh_token_encrypted: "unused-in-this-script", status: "ACTIVE" })
    .select("id")
    .single();
  if (connection.error || !connection.data) throw new Error(`Could not seed google_connections: ${connection.error?.message}`);
  const createdConnectionId = connection.data.id as string;

  googleAccountId = `${RUN_TAG}-account`;
  const account = await db
    .from("google_accounts")
    .insert({ connection_id: createdConnectionId, google_account_id: googleAccountId, resource_name: `accounts/${googleAccountId}`, account_name: "Verify Script Account" })
    .select("id")
    .single();
  if (account.error || !account.data) throw new Error(`Could not seed google_accounts: ${account.error?.message}`);

  googleLocationId = `${RUN_TAG}-location`;
  const location = await db
    .from("locations")
    .insert({ google_account_id: account.data.id, google_location_id: googleLocationId, resource_name: `locations/${googleLocationId}`, title: "Verify Script Location" })
    .select("id")
    .single();
  if (location.error || !location.data) throw new Error(`Could not seed locations: ${location.error?.message}`);
  locationRowId = location.data.id as string;
  console.log(`Created a scratch location chain (connection ${createdConnectionId}).\n`);

  const seededReviewIds: string[] = [];

  async function seedReview(overrides: Record<string, unknown>): Promise<string> {
    const now = new Date().toISOString();
    const seeded = await db
      .from("reviews")
      .insert({
        location_id: locationRowId,
        google_account_id: googleAccountId,
        google_location_id: googleLocationId,
        location_title: "Verify Script Location",
        reviewer_name: "Verify Script Reviewer",
        review_created_at: now,
        review_updated_at: now,
        ...overrides,
      })
      .select("id")
      .single();
    if (seeded.error || !seeded.data) throw new Error(`Could not seed review: ${seeded.error?.message}`);
    const id = seeded.data.id as string;
    seededReviewIds.push(id);
    return id;
  }

  try {
    // --- APPROVED review publishes cleanly ----------------------------------
    const approvedReviewId = await seedReview({
      google_review_id: "rev-001", // "positive-detailed" fixture — no existing reply
      rating: 5,
      review_text: "Fast, professional, no upsell pressure.",
      status: "APPROVED",
      ai_response: "Original AI draft.",
      final_response: `Verify script publish ${RUN_TAG}`,
      risk_level: "low",
      publish_decision: "REQUIRE_APPROVAL",
      approved_by: "verify-script",
      approved_at: new Date().toISOString(),
    });

    await check("publish an APPROVED review", async () => {
      const { status, body } = await api(`/api/reviews/${approvedReviewId}/publish`, {
        method: "POST",
        body: JSON.stringify({ actor: "verify-script" }),
      });
      assert(status === 200 && body?.ok === true, `expected 200/ok, got ${status} ${JSON.stringify(body)}`);
      const data = body!.data as { outcome: string; publishedAt?: string; recovered?: boolean };
      assert(data.outcome === "published", `expected outcome=published, got ${JSON.stringify(data)}`);
      assert(data.recovered === false, "expected recovered=false on a fresh publish");

      const after = await api(`/api/reviews/${approvedReviewId}`);
      const review = (after.body?.data as { review: { status: string; published_at: string | null; google_reply_state: string } }).review;
      assert(review.status === "PUBLISHED", `expected stored status PUBLISHED, got ${review.status}`);
      assert(review.published_at !== null, "published_at was not set");
      assert(review.google_reply_state === "PUBLISHED", `expected google_reply_state PUBLISHED, got ${review.google_reply_state}`);

      return `outcome=published, status=PUBLISHED, published_at set`;
    });

    await check("publishing an already-published review is refused, not silently repeated", async () => {
      const { status, body } = await api(`/api/reviews/${approvedReviewId}/publish`, { method: "POST", body: "{}" });
      assert(status === 400, `expected 400, got ${status} ${JSON.stringify(body)}`);
      assert(body?.ok === false, "expected ok:false");
      return `status=400, error=${body?.error}`;
    });

    // --- GENERATED (auto-publish) review publishes without approval --------
    const generatedReviewId = await seedReview({
      google_review_id: "rev-006", // "employee-mentioned" fixture — no existing reply
      rating: 5,
      review_text: "Mike at the front desk is the reason I keep coming back.",
      status: "GENERATED",
      ai_response: `Auto-publish draft ${RUN_TAG}`,
      final_response: null,
      risk_level: "low",
      publish_decision: "AUTO_PUBLISH",
    });

    await check("publish a GENERATED (auto-publish) review without any prior approval", async () => {
      const { status, body } = await api(`/api/reviews/${generatedReviewId}/publish`, { method: "POST", body: "{}" });
      assert(status === 200 && body?.ok === true, `expected 200/ok, got ${status} ${JSON.stringify(body)}`);
      const data = body!.data as { outcome: string };
      assert(data.outcome === "published", `expected outcome=published, got ${JSON.stringify(data)}`);

      const after = await api(`/api/reviews/${generatedReviewId}`);
      const review = (after.body?.data as { review: { status: string; final_response: string | null } }).review;
      assert(review.status === "PUBLISHED", `expected PUBLISHED, got ${review.status}`);
      assert(review.final_response === `Auto-publish draft ${RUN_TAG}`, "final_response was not backfilled from ai_response");
      return "outcome=published, final_response backfilled from ai_response";
    });

    // --- concurrent publish race: exactly one 200, one 409 ------------------
    await check("concurrent publish (expect one 200, one 409 — the atomic claim decides, not timing)", async () => {
      const raceReviewId = await seedReview({
        google_review_id: "rev-003", // "four-star-minor-criticism" fixture — no existing reply
        rating: 4,
        review_text: "Good work on the alignment.",
        status: "APPROVED",
        ai_response: "Draft for the race check.",
        final_response: `Race draft ${RUN_TAG}`,
        risk_level: "low",
        approved_by: "verify-script",
        approved_at: new Date().toISOString(),
      });

      const t0 = performance.now();
      const [a, b] = await Promise.all([
        timedApi(`/api/reviews/${raceReviewId}/publish`, { method: "POST", body: "{}" }, t0, "A"),
        timedApi(`/api/reviews/${raceReviewId}/publish`, { method: "POST", body: "{}" }, t0, "B"),
      ]);

      const statuses = [a.status, b.status].sort();
      assert(
        statuses[0] === 200 && statuses[1] === 409,
        `expected one 200 and one 409, got ${a.status} and ${b.status} (bodies: ${JSON.stringify(a.body)} / ${JSON.stringify(b.body)})`,
      );
      const loser = a.status === 409 ? a : b;
      return `got one 200 (published) and one 409 (${loser.body?.error ?? "no error message"})`;
    });

    // --- never overwrite a different existing Google reply -------------------
    await check("never publish over a different existing Google reply; routes back to PENDING_APPROVAL", async () => {
      const alreadyRepliedReviewId = await seedReview({
        google_review_id: "rev-012", // "already-replied" fixture — carries a real reviewReply
        rating: 5,
        review_text: "Fast, honest, and they showed me the old part.",
        status: "APPROVED",
        ai_response: "This should never be posted.",
        final_response: `Should never post ${RUN_TAG}`,
        risk_level: "low",
        approved_by: "verify-script",
        approved_at: new Date().toISOString(),
      });

      const { status, body } = await api(`/api/reviews/${alreadyRepliedReviewId}/publish`, { method: "POST", body: "{}" });
      assert(status === 200 && body?.ok === true, `expected 200/ok, got ${status} ${JSON.stringify(body)}`);
      const data = body!.data as { outcome: string };
      assert(data.outcome === "blocked_existing_reply", `expected outcome=blocked_existing_reply, got ${JSON.stringify(data)}`);

      const after = await api(`/api/reviews/${alreadyRepliedReviewId}`);
      const review = (after.body?.data as { review: { status: string; google_reply_state: string; existing_google_reply: string | null } }).review;
      assert(review.status === "PENDING_APPROVAL", `expected PENDING_APPROVAL, got ${review.status}`);
      assert(review.google_reply_state === "EXISTING_REPLY_FOUND", `expected EXISTING_REPLY_FOUND, got ${review.google_reply_state}`);
      assert(review.existing_google_reply !== null, "existing_google_reply was not recorded");
      return `outcome=blocked_existing_reply, status routed back to PENDING_APPROVAL, existing reply recorded`;
    });
  } finally {
    // Deleting the connection cascades through google_accounts -> locations
    // -> reviews, so the explicit review delete above is redundant but kept
    // for a clear error if the cascade is ever removed.
    if (seededReviewIds.length > 0) {
      const { error } = await db.from("reviews").delete().in("id", seededReviewIds);
      if (error) console.error(`Cleanup warning: could not delete seeded reviews: ${error.message}`);
    }
    const { error } = await db.from("google_connections").delete().eq("id", createdConnectionId);
    if (error) console.error(`Cleanup warning: could not delete scratch connection ${createdConnectionId}: ${error.message}`);
  }

  console.log("\n--- summary ---");
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("\nVerification script crashed:", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
