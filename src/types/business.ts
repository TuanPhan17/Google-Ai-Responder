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
