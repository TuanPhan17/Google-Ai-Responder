import { openAiStructuredRequest } from "@/openai/client";
import { buildSystemPrompt, buildUserPrompt } from "@/openai/prompt";
import { reviewResponseJsonSchema, reviewResponseSchema, type ReviewResponseOutput } from "@/schemas/openai";
import type { BusinessContext } from "@/types/business";
import type { NormalizedReview } from "@/types/review";
import { logger } from "@/utils/logger";

const log = logger.child("openai.review-response");

export interface GenerateReviewResponseInput {
  review: NormalizedReview;
  /** Null when no business_settings row exists yet (Phase 8 is not built). */
  business: BusinessContext | null;
}

/**
 * The reusable OpenAI review-response service called out in docs/SPEC.md
 * Phase 2.
 *
 * This function only generates and validates a candidate response — it does
 * not decide whether that response is allowed to publish. That decision is
 * Phase 3's deterministic publishing-policy service, applied to the
 * `needsHumanReview` / `riskLevel` this returns, never trusted from the model
 * alone.
 */
export async function generateReviewResponse(
  input: GenerateReviewResponseInput,
): Promise<ReviewResponseOutput> {
  const label = "review-response";

  // Never log review text or the generated reply — only metadata about the
  // attempt. logger.ts redacts known secret/customer-text keys, but a field
  // named e.g. "prompt" or "reply" wouldn't match those patterns, so the
  // discipline is to just not put that content in a log call at all.
  log.info("Generating review response", {
    googleReviewId: input.review.googleReviewId,
    rating: input.review.rating,
    hasReviewText: input.review.reviewText !== null,
  });

  try {
    const result = await openAiStructuredRequest(
      {
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(input.review, input.business) },
        ],
        schemaName: "review_response",
        jsonSchema: reviewResponseJsonSchema,
        label,
      },
      reviewResponseSchema,
    );

    log.info("Generated review response", {
      googleReviewId: input.review.googleReviewId,
      sentiment: result.sentiment,
      riskLevel: result.riskLevel,
      needsHumanReview: result.needsHumanReview,
    });

    return result;
  } catch (error) {
    log.error("Review response generation failed", {
      googleReviewId: input.review.googleReviewId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
