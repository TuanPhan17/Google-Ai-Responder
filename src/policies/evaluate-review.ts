import { classifyRisk, type KeywordRiskMatch } from "@/policies/risk-classifier";
import { decidePublishing } from "@/policies/publishing-policy";
import type { PublishingSettings } from "@/types/business";
import type { PublishDecision, RiskLevel } from "@/types/review";

/**
 * Ties the risk classification workflow to the publishing-policy service —
 * the two pieces docs/SPEC.md Phase 3 calls out are meant to compose exactly
 * this way. Pure and side-effect-free on purpose: it does not read or write
 * the database and does not call Google or OpenAI. Wiring this into the
 * actual ingest/publish pipeline is later phases' job (persistence in Phase 4,
 * the approval workflow in Phase 5, the Google write in Phase 6).
 */

export interface EvaluateReviewInput {
  rating: number | null;
  reviewText: string | null;
  hasExistingGoogleReply: boolean;
  /** Only the two fields the policy is allowed to see from the model's output. */
  aiOutput: { riskLevel: RiskLevel; needsHumanReview: boolean };
  settings?: PublishingSettings | null;
}

export interface EvaluateReviewResult {
  riskLevel: RiskLevel;
  needsHumanReview: boolean;
  keywordMatches: KeywordRiskMatch[];
  decision: PublishDecision;
  reasons: string[];
}

export function evaluateReviewForPublishing(input: EvaluateReviewInput): EvaluateReviewResult {
  const classification = classifyRisk({
    reviewText: input.reviewText,
    aiRiskLevel: input.aiOutput.riskLevel,
    aiNeedsHumanReview: input.aiOutput.needsHumanReview,
  });

  const policy = decidePublishing({
    rating: input.rating,
    riskLevel: classification.riskLevel,
    needsHumanReview: classification.needsHumanReview,
    hasExistingGoogleReply: input.hasExistingGoogleReply,
    settings: input.settings,
  });

  return {
    riskLevel: classification.riskLevel,
    needsHumanReview: classification.needsHumanReview,
    keywordMatches: classification.keywordMatches,
    decision: policy.decision,
    reasons: policy.reasons,
  };
}
