import { getBusinessSettings, type BusinessSettingsRow } from "@/database/repositories/settings.repository";
import type { BusinessContext, PublishingSettings } from "@/types/business";

/**
 * Maps the persisted `business_settings` row to the two shapes the rest of
 * the app already knows how to consume: `BusinessContext` (Phase 2's AI
 * service — what the model may reference as verified fact) and
 * `PublishingSettings` (Phase 3's deterministic policy — auto-publish
 * toggles and the minimum rating). Kept out of the repository so
 * settings.repository.ts stays SQL-only, per CLAUDE.md's "repositories own
 * SQL, services call repositories."
 */

export function toBusinessContext(row: BusinessSettingsRow | null): BusinessContext | null {
  if (!row) return null;
  return {
    businessName: row.business_name,
    businessDescription: row.business_description,
    brandVoice: row.brand_voice,
    preferredTone: row.preferred_tone,
    maxResponseChars: row.max_response_chars,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    escalationInstructions: row.escalation_instructions,
    phrasesToAvoid: row.phrases_to_avoid,
    approvedPolicies: row.approved_policies,
    locationNotes: row.location_notes,
  };
}

export function toPublishingSettings(row: BusinessSettingsRow | null): PublishingSettings | null {
  if (!row) return null;
  return {
    autoPublishFiveStar: row.auto_publish_five_star,
    autoPublishFourStar: row.auto_publish_four_star,
    minAutoPublishRating: row.min_auto_publish_rating,
  };
}

/**
 * What every generation/regeneration/edit call site needs before it can call
 * into Phase 2/3/5 code: the verified business facts and the publishing
 * toggles for the review's own location. Both sides already treat `null` as
 * their safe default (no context to reference, nothing auto-publishes), so a
 * location with no configured settings yet degrades exactly like it did
 * before this phase existed.
 */
export async function resolveLocationConfig(locationRowId: string): Promise<{
  business: BusinessContext | null;
  settings: PublishingSettings | null;
}> {
  const row = await getBusinessSettings(locationRowId);
  return { business: toBusinessContext(row), settings: toPublishingSettings(row) };
}
