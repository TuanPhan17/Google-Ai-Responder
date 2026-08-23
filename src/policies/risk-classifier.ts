import { RISK_LEVELS, type RiskLevel } from "@/types/review";

/**
 * Deterministic, keyword-based safety net layered underneath the model's own
 * `riskLevel`/`needsHumanReview`.
 *
 * Why this exists at all: CLAUDE.md's non-negotiable invariant #1 is that the
 * model never has final authority over publishing, and a prompt can be talked
 * out of a rule in a way a plain string match cannot — including by an
 * adversarial reviewer embedding instructions in the review text itself. This
 * scan runs over the raw customer text independently of whatever the model
 * concluded, and the result can only ever escalate risk, never lower it below
 * what the model already reported.
 *
 * That asymmetry is deliberate: a false positive here costs one extra human
 * review; a false negative would let a genuinely risky review slip through to
 * auto-publish. The category list below is intentionally broad rather than
 * precise for exactly that reason — some of these (a review that simply
 * mentions "refund", for instance) will over-trigger. That is the safe
 * failure mode, not a bug.
 *
 * Categories are the ones enumerated in docs/SPEC.md "High-Risk Review
 * Detection". Two items from that list are deliberately not attempted here —
 * "serious accusations" and "facts that cannot be verified" — because they
 * are judgment calls, not string matches; the model's own classification and
 * the human-review queue are what's supposed to catch those.
 */

interface RiskCategory {
  category: string;
  pattern: RegExp;
}

const HIGH_RISK_CATEGORIES: RiskCategory[] = [
  {
    category: "legal_threat",
    pattern: /\b(lawsuit|legal action|small claims|file(?:d|ing)? a suit|su(?:e|ing|ed) (?:you|them|us|me|him|her|the business|this (?:place|company))|attorney|lawyer)\b/i,
  },
  { category: "law_enforcement", pattern: /\b(police|cops?|officer|filed a report)\b/i },
  { category: "fraud", pattern: /\b(fraud(?:ulent)?|scam(?:med|ming)?|swindl\w*|ripped? off)\b/i },
  { category: "theft", pattern: /\b(theft|stole|stolen|steal(?:ing)?|shoplift\w*)\b/i },
  { category: "harassment", pattern: /\b(harass(?:ed|ment|ing)?)\b/i },
  { category: "discrimination", pattern: /\b(discriminat\w*|racis[mt]\w*|sexis[mt]\w*|homophob\w*)\b/i },
  { category: "sexual_harassment", pattern: /\b(sexual(?:ly)? (?:harass\w*|assault\w*)|groped|molest\w*)\b/i },
  { category: "safety_incident", pattern: /\b(injur(?:y|ed|ies)|hospitali[sz]ed|accident|unsafe|hazard\w*)\b/i },
  { category: "medical", pattern: /\b(medical (?:emergency|attention|treatment)|hospital|ambulance|emergency room)\b/i },
  { category: "chargeback", pattern: /\bcharge ?back(?:s|ed|ing)?\b/i },
  { category: "refund_dispute", pattern: /\brefund(?:s|ed|ing)?\b/i },
  {
    category: "employee_misconduct",
    pattern: /\b(employee|staff(?:er)?|worker|manager|mechanic|technician)\b[\s\S]{0,40}\b(misconduct|stole|assault\w*|threat\w*|inappropriate)\b/i,
  },
  { category: "threats", pattern: /\bthreat(?:en(?:ed|ing)?|s)?\b/i },
  {
    category: "private_information",
    pattern: /\b(social security|\bssn\b|credit card number|home address|passport number)\b/i,
  },
  {
    category: "media",
    pattern: /\b(contact(?:ing|ed)? (?:the )?(?:news|media|press)|reporter|journalist|going viral|post(?:ed|ing)? (?:this|it) on social media)\b/i,
  },
  {
    category: "regulatory",
    pattern: /\b(better business bureau|\bbbb\b|attorney general|health department|licensing board|regulator\w*|government complaint)\b/i,
  },
];

export interface KeywordRiskMatch {
  category: string;
  matchedText: string;
}

/** Runs the deterministic scan alone. Exposed mainly so results are inspectable/loggable. */
export function scanForHighRiskKeywords(reviewText: string | null): KeywordRiskMatch[] {
  if (!reviewText) return [];

  const matches: KeywordRiskMatch[] = [];
  for (const { category, pattern } of HIGH_RISK_CATEGORIES) {
    const match = pattern.exec(reviewText);
    if (match) matches.push({ category, matchedText: match[0] });
  }
  return matches;
}

const RISK_RANK: Record<RiskLevel, number> = Object.fromEntries(
  RISK_LEVELS.map((level, index) => [level, index]),
) as Record<RiskLevel, number>;

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export interface RiskClassificationInput {
  reviewText: string | null;
  aiRiskLevel: RiskLevel;
  aiNeedsHumanReview: boolean;
}

export interface RiskClassificationResult {
  riskLevel: RiskLevel;
  needsHumanReview: boolean;
  keywordMatches: KeywordRiskMatch[];
}

/**
 * Combines the model's classification with the deterministic scan. This is
 * the "risk classification workflow" docs/SPEC.md Phase 3 calls for — the
 * single place that produces the risk signal the publishing policy consumes.
 * It never trusts the model alone, and it never lowers what the model
 * reported — only escalates.
 */
export function classifyRisk(input: RiskClassificationInput): RiskClassificationResult {
  const keywordMatches = scanForHighRiskKeywords(input.reviewText);
  const keywordRisk: RiskLevel = keywordMatches.length > 0 ? "high" : "low";

  const riskLevel = maxRisk(input.aiRiskLevel, keywordRisk);
  const needsHumanReview = input.aiNeedsHumanReview || riskLevel !== "low";

  return { riskLevel, needsHumanReview, keywordMatches };
}
