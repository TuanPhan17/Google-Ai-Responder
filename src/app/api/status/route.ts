import { getEnv } from "@/config/env";
import { getConnectionSummary } from "@/database/repositories/connection.repository";
import { getReviewSource } from "@/reviews/review-source";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

/**
 * Console bootstrap. Returns only what the browser is allowed to know:
 * whether a connection exists, which Google login it belongs to, and which
 * data source is active. No tokens, no keys, no scopes beyond what was granted.
 */
export async function GET() {
  return withAdmin("status", async () => {
    const env = getEnv();
    const connection = await getConnectionSummary();

    return {
      mockMode: env.MOCK_MODE,
      source: getReviewSource().kind,
      googleConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      connection,
    };
  });
}
