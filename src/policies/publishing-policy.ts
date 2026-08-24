import { DEFAULT_PUBLISHING_SETTINGS, type PublishingSettings } from "@/types/business";
import type { PublishDecision, RiskLevel } from "@/types/review";

/**
 * The one place that decides whether a generated response may post itself to
 * Google. Every rule here is a hard requirement from docs/SPEC.md and
 * CLAUDE.md's non-negotiable safety invariants — none of them are settings a
 * business owner can turn off:
 *
 *   - 1-, 2-, and 3-star reviews always require approval.
 *   - Medium or high risk always requires approval, regardless of rating.
 *   - An existing Google reply blocks auto-publish entirely.
 *
 * The only configurable knobs are whether low-risk 4- and 5-star reviews may
 * auto-publish at all, and the minimum rating that qualifies — and both can
 * only make auto-publishing *stricter* than this function's baseline, never
 * looser. A prompt can be talked out of a rule; this function cannot, because
 * nothing here reads from anything the model produced except the risk signal
 * itself, and that signal already went through the deterministic keyword
 * escalation in risk-classifier.ts before it ever reaches this function.
 *
 * On top of all of that sits `requireApprovalForAll` — a separate,
 * product-level decision (see REQUIRE_APPROVAL_FOR_ALL in src/config/env.ts)
 * that every review requires human approval, full stop. It defaults to
 * `true` when a caller doesn't pass it, matching that product default. It is
 * deliberately still just an input to this function rather than this
 * function deleting or bypassing the auto-publish machinery below: the
 * policy engine keeps working exactly as before and stays fully covered by
 * its own tests, so turning auto-publish back on later is a config change,
 * not a rewrite.
 */

export interface PublishingPolicyInput {
  rating: number | null;
  riskLevel: RiskLevel;
  needsHumanReview: boolean;
  hasExistingGoogleReply: boolean;
  /** Null when no business_settings row exists yet — treated as the safe default (nothing auto-publishes). */
  settings?: PublishingSettings | null;
  /** Defaults to `true` (require approval for everything) when omitted — see REQUIRE_APPROVAL_FOR_ALL in src/config/env.ts. */
  requireApprovalForAll?: boolean;
}

export interface PublishingPolicyResult {
  decision: PublishDecision;
  /** Machine-readable reason codes, always at least one, most-decisive first. */
  reasons: string[];
}

/** DB CHECK constraint pins this to 4-5; re-clamped here so the app never trusts a settings row blindly. */
function clampMinAutoPublishRating(settings: PublishingSettings): PublishingSettings {
  return { ...settings, minAutoPublishRating: Math.min(5, Math.max(4, settings.minAutoPublishRating)) };
}

export function decidePublishing(input: PublishingPolicyInput): PublishingPolicyResult {
  // An existing reply overrides everything else: there is nothing to decide,
  // because posting a second reply is never allowed regardless of risk,
  // rating, or configuration.
  if (input.hasExistingGoogleReply) {
    return { decision: "BLOCKED", reasons: ["existing_google_reply"] };
  }

  const mandatoryReasons: string[] = [];

  // The blanket product decision, checked first because it's the most
  // decisive reason when it applies — it holds regardless of rating, risk,
  // or settings, unlike every other entry pushed onto this array below.
  if (input.requireApprovalForAll ?? true) mandatoryReasons.push("manual_approval_required");

  if (input.rating === null) mandatoryReasons.push("rating_unknown");
  else if (input.rating <= 3) mandatoryReasons.push("rating_requires_approval");

  if (input.riskLevel === "high") mandatoryReasons.push("risk_high");
  else if (input.riskLevel === "medium") mandatoryReasons.push("risk_medium");

  if (input.needsHumanReview) mandatoryReasons.push("needs_human_review");

  if (mandatoryReasons.length > 0) {
    return { decision: "REQUIRE_APPROVAL", reasons: mandatoryReasons };
  }

  // Past this point: rating is 4 or 5, risk is low, needsHumanReview is
  // false, and there's no existing reply. Only the business's own
  // auto-publish configuration can still hold this back.
  const rating = input.rating as number;
  const settings = clampMinAutoPublishRating(input.settings ?? DEFAULT_PUBLISHING_SETTINGS);

  if (rating < settings.minAutoPublishRating) {
    return { decision: "REQUIRE_APPROVAL", reasons: ["below_min_auto_publish_rating"] };
  }
  if (rating === 5 && !settings.autoPublishFiveStar) {
    return { decision: "REQUIRE_APPROVAL", reasons: ["auto_publish_five_star_disabled"] };
  }
  if (rating === 4 && !settings.autoPublishFourStar) {
    return { decision: "REQUIRE_APPROVAL", reasons: ["auto_publish_four_star_disabled"] };
  }

  return { decision: "AUTO_PUBLISH", reasons: ["eligible"] };
}
