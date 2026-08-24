import { randomUUID } from "node:crypto";

import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Live verification of the Phase 5 approval-workflow HTTP endpoints against a
 * real Supabase database and a real running dev server — not the vitest
 * fake-db harness.
 *
 * Read-only for app code: this script only calls the public API routes plus
 * the service-role Supabase client already used by src/database/supabase.ts.
 * It does not import or exercise anything from src/reviews/approval.service.ts
 * directly.
 *
 * Prerequisites:
 *   - `npm run dev` running locally (defaults to http://localhost:3000, or
 *     whatever APP_BASE_URL is set to in .env.local).
 *   - .env.local filled in with real SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *     / ADMIN_PASSWORD, and a working OPENAI_API_KEY (the regenerate check
 *     makes one real AI call, same as `npm run ai:try-fixture`).
 *
 * Run: npx tsx scripts/verify-phase5-live.ts
 *
 * The seeded review (and, if this run had to create its own location chain,
 * that chain too) is deleted in a `finally` block so a failed run doesn't
 * leave test rows behind.
 */

const RUN_TAG = `e2e-verify-${Date.now()}-${randomUUID().slice(0, 8)}`;

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
  const baseUrl = env.APP_BASE_URL.replace(/\/$/, "");
  const db = getDb();

  // --- sign in -----------------------------------------------------------
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

  /** Same as api(), but timestamped relative to `t0` (ms) for race diagnostics. */
  async function timedApi(path: string, init: RequestInit, t0: number, label: string) {
    const sentAt = performance.now() - t0;
    console.log(`  [${label}] request sent at t+${sentAt.toFixed(1)}ms`);
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", cookie: cookieHeader, ...(init.headers ?? {}) },
    });
    const headersAt = performance.now() - t0;
    const body = await res.json().catch(() => null);
    const doneAt = performance.now() - t0;
    console.log(
      `  [${label}] response headers at t+${headersAt.toFixed(1)}ms, body parsed at t+${doneAt.toFixed(1)}ms, status=${res.status}`,
    );
    return {
      status: res.status,
      body: body as { ok: boolean; data?: unknown; error?: string } | null,
      sentAt,
      headersAt,
      doneAt,
    };
  }

  // --- seed a location chain (or reuse an existing one) -------------------
  let reviewId: string | null = null;
  let createdConnectionId: string | null = null;
  let locationRowId: string;
  let googleAccountId: string;
  let googleLocationId: string;

  const existingLocation = await db
    .from("locations")
    .select("id, google_location_id, google_account_id")
    .limit(1)
    .maybeSingle();

  if (existingLocation.data) {
    locationRowId = existingLocation.data.id as string;
    googleLocationId = existingLocation.data.google_location_id as string;

    const account = await db
      .from("google_accounts")
      .select("google_account_id")
      .eq("id", existingLocation.data.google_account_id)
      .single();
    if (account.error || !account.data) throw new Error(`Could not read the reused location's account: ${account.error?.message}`);
    googleAccountId = account.data.google_account_id as string;

    console.log(`Reusing existing location ${locationRowId} for the seeded review.\n`);
  } else {
    const connection = await db
      .from("google_connections")
      .insert({ slug: RUN_TAG, google_email: "verify-script@example.com", refresh_token_encrypted: "unused-in-this-script", status: "ACTIVE" })
      .select("id")
      .single();
    if (connection.error || !connection.data) throw new Error(`Could not seed google_connections: ${connection.error?.message}`);
    createdConnectionId = connection.data.id as string;

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

    console.log(`Created a scratch location chain (connection ${createdConnectionId}) for the seeded review.\n`);
  }

  try {
    // --- seed a risk-flagged, PENDING_APPROVAL review ---------------------
    const now = new Date().toISOString();
    const seeded = await db
      .from("reviews")
      .insert({
        location_id: locationRowId,
        google_review_id: `${RUN_TAG}-review`,
        google_account_id: googleAccountId,
        google_location_id: googleLocationId,
        location_title: "Verify Script Location",
        reviewer_name: "Verify Script Reviewer",
        rating: 1,
        review_text: "Seeded by scripts/verify-phase5-live.ts. My attorney is reviewing this.",
        review_created_at: now,
        review_updated_at: now,
        status: "PENDING_APPROVAL",
        ai_response: "Original AI draft, before any edit.",
        risk_level: "high",
        needs_human_review: true,
        human_review_required: true,
        sentiment: "negative",
        publish_decision: "REQUIRE_APPROVAL",
        publish_decision_reason: "seeded-for-verification",
      })
      .select("id")
      .single();
    if (seeded.error || !seeded.data) throw new Error(`Could not seed the test review: ${seeded.error?.message}`);
    reviewId = seeded.data.id as string;

    console.log(`Seeded review ${reviewId} (rating=1, risk=high, status=PENDING_APPROVAL, human_review_required=true).\n`);

    // --- GET ---------------------------------------------------------------
    await check("GET review", async () => {
      const { status, body } = await api(`/api/reviews/${reviewId}`);
      assert(status === 200 && body?.ok === true, `expected 200/ok, got ${status} ${JSON.stringify(body)}`);
      const data = body!.data as { review: { id: string; status: string } };
      assert(data.review.id === reviewId, "returned review id did not match");
      assert(data.review.status === "PENDING_APPROVAL", `expected PENDING_APPROVAL, got ${data.review.status}`);
      return `status=${data.review.status}`;
    });

    // --- edit ----------------------------------------------------------------
    const editedText = `Edited by verify script ${RUN_TAG}`;
    await check("edit review", async () => {
      const { status, body } = await api(`/api/reviews/${reviewId}/edit`, {
        method: "POST",
        body: JSON.stringify({ response: editedText, actor: "verify-script" }),
      });
      assert(status === 200 && body?.ok === true, `expected 200/ok, got ${status} ${JSON.stringify(body)}`);
      const data = body!.data as { review: { final_response: string; status: string } };
      assert(data.review.final_response === editedText, "final_response was not updated to the edited text");
      assert(data.review.status === "PENDING_APPROVAL", `expected PENDING_APPROVAL after edit, got ${data.review.status}`);
      return "final_response updated, status stayed PENDING_APPROVAL";
    });

    // --- approve, then a concurrent approve-again to force the 409 race ----
    let approvedOk = false;
    await check("approve review", async () => {
      const { status, body } = await api(`/api/reviews/${reviewId}/approve`, {
        method: "POST",
        body: JSON.stringify({ actor: "verify-script" }),
      });
      assert(status === 200 && body?.ok === true, `expected 200/ok, got ${status} ${JSON.stringify(body)}`);
      const data = body!.data as { review: { status: string; final_response: string; approved_by: string | null } };
      assert(data.review.status === "APPROVED", `expected APPROVED, got ${data.review.status}`);
      assert(data.review.final_response === editedText, "approved response did not carry over the human edit");
      assert(data.review.approved_by === "verify-script", "approved_by was not recorded");
      approvedOk = true;
      return "status=APPROVED, final_response carried the edit, approved_by recorded";
    });

    if (approvedOk) {
      // A sequential re-approve after the first has already committed hits
      // the fast BadRequestError(400) pre-check in approval.service.ts, not
      // the atomic guard — so this fires two approvals *concurrently* against
      // the same still-PENDING_APPROVAL review to actually race the atomic
      // UPDATE ... WHERE status IN (...) guard (review.repository.ts,
      // throwOnZeroRowsOrError). Exactly one request should win with 200/
      // APPROVED and the other should lose with 409/CONFLICT.
      //
      // To exercise this without depending on timing against the "approve
      // review" check above, re-seed a second PENDING_APPROVAL row for the
      // race itself.
      await check("approve-again (concurrent, expect one 409)", async () => {
        const raceNow = new Date().toISOString();
        const race = await db
          .from("reviews")
          .insert({
            location_id: locationRowId,
            google_review_id: `${RUN_TAG}-review-race`,
            google_account_id: googleAccountId,
            google_location_id: googleLocationId,
            location_title: "Verify Script Location",
            reviewer_name: "Verify Script Reviewer",
            rating: 1,
            review_text: "Seeded by scripts/verify-phase5-live.ts for the concurrent-approve race.",
            review_created_at: raceNow,
            review_updated_at: raceNow,
            status: "PENDING_APPROVAL",
            ai_response: "Draft for the race check.",
            risk_level: "high",
            needs_human_review: true,
            human_review_required: true,
          })
          .select("id")
          .single();
        if (race.error || !race.data) throw new Error(`Could not seed the race review: ${race.error?.message}`);
        const raceId = race.data.id as string;

        try {
          const t0 = performance.now();
          const [a, b] = await Promise.all([
            timedApi(`/api/reviews/${raceId}/approve`, { method: "POST", body: JSON.stringify({ actor: "verify-script-a" }) }, t0, "A"),
            timedApi(`/api/reviews/${raceId}/approve`, { method: "POST", body: JSON.stringify({ actor: "verify-script-b" }) }, t0, "B"),
          ]);

          // Overlap diagnostic: if B was sent before A's response headers came
          // back (and vice versa), the two requests were in flight on the
          // server at the same time — a real race. If one request's full
          // response (doneAt) completes before the other was even sent
          // (sentAt), they ran sequentially and the "race" never happened.
          const [first, second] = a.sentAt <= b.sentAt ? [a, b] : [b, a];
          const overlapped = second.sentAt < first.doneAt;
          console.log(
            `  overlap check: second request sent at t+${second.sentAt.toFixed(1)}ms, first request finished at t+${first.doneAt.toFixed(1)}ms -> ${overlapped ? "OVERLAPPED" : "DID NOT OVERLAP (ran sequentially)"}`,
          );

          const statuses = [a.status, b.status].sort();
          assert(
            statuses[0] === 200 && statuses[1] === 409,
            `expected one 200 and one 409, got ${a.status} and ${b.status} (bodies: ${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}; ${overlapped ? "requests did overlap on the wire" : "requests did NOT overlap on the wire -- the loser's precheck saw the row already APPROVED"})`,
          );
          const loser = a.status === 409 ? a : b;
          assert(loser.body?.ok === false, "the losing request's body did not report ok:false");
          return `got one 200 (APPROVED) and one 409 (${loser.body?.error ?? "no error message"})`;
        } finally {
          await db.from("reviews").delete().eq("id", raceId);
        }
      });
    } else {
      record("approve-again (concurrent, expect one 409)", false, "skipped — the initial approve did not succeed");
    }

    // --- unapprove -----------------------------------------------------------
    let unapprovedOk = false;
    await check("unapprove review", async () => {
      const { status, body } = await api(`/api/reviews/${reviewId}/unapprove`, {
        method: "POST",
        body: JSON.stringify({ actor: "verify-script" }),
      });
      assert(status === 200 && body?.ok === true, `expected 200/ok, got ${status} ${JSON.stringify(body)}`);
      const data = body!.data as { review: { status: string; approved_by: string | null } };
      assert(data.review.status === "PENDING_APPROVAL", `expected PENDING_APPROVAL, got ${data.review.status}`);
      assert(data.review.approved_by === null, "approved_by was not cleared");
      unapprovedOk = true;
      return "status=PENDING_APPROVAL, approved_by cleared";
    });

    // --- regenerate on the risk-flagged review --------------------------------
    await check("regenerate stays PENDING_APPROVAL (risk-flagged)", async () => {
      if (!unapprovedOk) throw new Error("skipped — unapprove did not succeed, review was not back in a regeneratable state");

      const { status, body } = await api(`/api/reviews/${reviewId}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ actor: "verify-script" }),
      });
      assert(status === 200 && body?.ok === true, `expected 200/ok, got ${status} ${JSON.stringify(body)}`);
      const outcome = body!.data as { outcome: string; status?: string; decision?: string; error?: string };
      assert(
        outcome.outcome === "generated",
        `regeneration did not complete (outcome=${outcome.outcome}${outcome.error ? `, error=${outcome.error}` : ""}) — check OPENAI_API_KEY in .env.local`,
      );
      assert(outcome.status === "PENDING_APPROVAL", `expected PENDING_APPROVAL, got ${outcome.status} (decision=${outcome.decision})`);

      const after = await api(`/api/reviews/${reviewId}`);
      const afterReview = (after.body?.data as { review: { status: string; human_review_required: boolean } }).review;
      assert(afterReview.status === "PENDING_APPROVAL", `stored row status was ${afterReview.status}, not PENDING_APPROVAL`);
      assert(afterReview.human_review_required === true, "human_review_required flag was lost across regeneration");

      return `outcome=generated, decision=${outcome.decision}, status stayed PENDING_APPROVAL, human_review_required stayed true`;
    });
  } finally {
    // --- cleanup ---------------------------------------------------------
    if (reviewId) {
      const { error } = await db.from("reviews").delete().eq("id", reviewId);
      if (error) console.error(`Cleanup warning: could not delete review ${reviewId}: ${error.message}`);
    }
    if (createdConnectionId) {
      // Cascades through google_accounts -> locations -> any leftover reviews.
      const { error } = await db.from("google_connections").delete().eq("id", createdConnectionId);
      if (error) console.error(`Cleanup warning: could not delete scratch connection ${createdConnectionId}: ${error.message}`);
    }
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
