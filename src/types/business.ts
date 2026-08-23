/**
 * The subset of `business_settings` the AI is allowed to see.
 *
 * Deliberately excludes auto-publish thresholds and toggles — those are
 * publishing policy (Phase 3), not context for what the model may say. Every
 * field here is optional because Settings management (Phase 8) does not
 * exist yet; callers may have no row to draw from.
 */
export interface BusinessContext {
  businessName: string | null;
  businessDescription: string | null;
  brandVoice: string | null;
  preferredTone: string | null;
  maxResponseChars: number | null;
  contactPhone: string | null;
  contactEmail: string | null;
  escalationInstructions: string | null;
  phrasesToAvoid: string[];
  approvedPolicies: string[];
  locationNotes: string | null;
}

/**
 * The auto-publish subset of `business_settings` — policy, not AI context.
 * Deliberately excluded from `BusinessContext` for the same reason this is
 * excluded from what the model sees: a business owner configures whether
 * *low-risk 4/5-star* replies may post automatically, never anything about
 * risk or rating thresholds below that. See src/policies/publishing-policy.ts.
 */
export interface PublishingSettings {
  autoPublishFiveStar: boolean;
  autoPublishFourStar: boolean;
  /** DB CHECK constraint clamps this to 4-5; the policy re-clamps defensively. */
  minAutoPublishRating: number;
}

/** Safe when no business_settings row exists yet (Settings is Phase 8): nothing auto-publishes. */
export const DEFAULT_PUBLISHING_SETTINGS: PublishingSettings = {
  autoPublishFiveStar: false,
  autoPublishFourStar: false,
  minAutoPublishRating: 4,
};
