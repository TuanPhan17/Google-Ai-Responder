import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Runs one tick of the Phase 7 background sweep
 * (src/reviews/sweep.service.ts): force-reclaims PUBLISH_PENDING rows stuck
 * from a crashed publish attempt, then calls publishReview for every
 * GENERATED review the deterministic policy already cleared for
 * auto-publish.
 *
 * This script is the unit of work, not the schedule. Nothing in this
 * repository invokes it on a timer — wiring that (a platform's scheduled-
 * function feature, an OS cron entry, a CI scheduled workflow, etc.) is
 * infrastructure setup outside this phase's code-only scope. Run it by hand,
 * or point whatever scheduler gets set up at:
 *
 *   npx tsx scripts/run-sweep.ts
 *
 * Reads the same environment as the app itself (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, ...) via src/config/env.ts, so it must run
 * somewhere those are available — the app's own deploy environment, not a
 * developer's machine pointed at production.
 */
async function main() {
  const { runBackgroundSweep } = await import("@/reviews/sweep.service");

  const result = await runBackgroundSweep();

  console.log("Stale PUBLISH_PENDING recovery:", result.stalePublishPending);
  console.log("Auto-publish sweep:", result.autoPublish);
}

main().catch((error) => {
  console.error("Sweep failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
