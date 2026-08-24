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
  /**
   * The review's stored `human_review_required` going into this evaluation.
   * A regenerate can hand the model a second chance to score a review lower
   * risk than it did the first time — that's expected, the model isn't
   * deterministic. What must not happen is that improved second opinion
   * silently erasing a human-review requirement a prior attempt already
   * earned. OR'd into this attempt's own signal, never the other way: the
   * flag can only turn on, never off, across generations of the same review.
   */
  priorHumanReviewRequired?: boolean;
  /** Passed straight through to decidePublishing; see its doc comment. Defaults to `true` when omitted. */
  requireApprovalForAll?: boolean;
}

export interface EvaluateReviewResult {
  riskLevel: RiskLevel;
  /** This attempt's own signal only — the informational, per-generation value. */
  needsHumanReview: boolean;
  /** Sticky across regenerations: priorHumanReviewRequired OR this attempt's needsHumanReview. What the publishing decision actually gates on. */
  humanReviewRequired: boolean;
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

  const humanReviewRequired = (input.priorHumanReviewRequired ?? false) || classification.needsHumanReview;

  const policy = decidePublishing({
    rating: input.rating,
    riskLevel: classification.riskLevel,
    needsHumanReview: humanReviewRequired,
    hasExistingGoogleReply: input.hasExistingGoogleReply,
    settings: input.settings,
    requireApprovalForAll: input.requireApprovalForAll,
  });

  return {
    riskLevel: classification.riskLevel,
    needsHumanReview: classification.needsHumanReview,
    humanReviewRequired,
    keywordMatches: classification.keywordMatches,
    decision: policy.decision,
    reasons: policy.reasons,
  };
}
