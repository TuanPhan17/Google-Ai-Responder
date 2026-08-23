import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Manual smoke test for the OpenAI/Groq-compatible review-response service.
 *
 * Run: npm run ai:try-fixture -- <fixture-key>
 *
 * Makes one real call to whatever OPENAI_BASE_URL/OPENAI_MODEL is configured
 * in .env.local — this hits the network and costs real quota, unlike
 * `npm test`, which mocks fetch and never leaves the machine.
 */
async function main() {
  const { MOCK_FIXTURES, MOCK_ACCOUNT_ID, MOCK_LOCATION_ID, MOCK_LOCATION_TITLE, getFixture } = await import(
    "@/mocks/fixtures"
  );

  const key = process.argv[2];
  const fixture = key ? getFixture(key) : undefined;

  if (!fixture) {
    if (key) console.error(`No fixture named "${key}".\n`);
    console.error("Available fixture keys:");
    for (const f of MOCK_FIXTURES) console.error(`  ${f.key.padEnd(28)} ${f.purpose}`);
    process.exitCode = 1;
    return;
  }

  const { mapGoogleReview } = await import("@/reviews/mapper");
  const { generateReviewResponse } = await import("@/openai/review-response.service");

  const review = mapGoogleReview(fixture.review, {
    googleAccountId: MOCK_ACCOUNT_ID,
    googleLocationId: MOCK_LOCATION_ID,
    locationTitle: MOCK_LOCATION_TITLE,
  });

  console.log(`--- ${fixture.key}: ${fixture.purpose} ---`);
  console.log(JSON.stringify(review, null, 2));

  const result = await generateReviewResponse({ review, business: null });

  console.log("\n--- structured output returned ---");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Generation failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
