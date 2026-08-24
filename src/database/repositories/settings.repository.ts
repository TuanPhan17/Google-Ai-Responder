import { getDb } from "@/database/supabase";
import { DatabaseError } from "@/utils/errors";

/**
 * Persistence for `business_settings` and the location picker behind it —
 * the verified-fact store Phase 2's AI service and Phase 3's publishing
 * policy have read from `BusinessContext`/`PublishingSettings` since they
 * were built, but which nothing has ever written to until now (Settings
 * management is this phase, per docs/SPEC.md Phase 8).
 */

export interface BusinessSettingsRow {
  id: string;
  location_id: string;
  business_name: string | null;
  business_description: string | null;
  brand_voice: string | null;
  preferred_tone: string | null;
  max_response_chars: number;
  contact_phone: string | null;
  contact_email: string | null;
  escalation_instructions: string | null;
  phrases_to_avoid: string[];
  approved_policies: string[];
  location_notes: string | null;
  auto_publish_five_star: boolean;
  auto_publish_four_star: boolean;
  min_auto_publish_rating: number;
  created_at: string;
  updated_at: string;
}

export interface LocationRow {
  id: string;
  google_location_id: string;
  title: string | null;
  address: string | null;
}

/** Locations already synced from Google (or the mock source) into this database. */
export async function listLocationRows(): Promise<LocationRow[]> {
  const { data, error } = await getDb()
    .from("locations")
    .select("id, google_location_id, title, address")
    .order("title", { ascending: true })
    .returns<LocationRow[]>();

  if (error) throw new DatabaseError("Could not list locations.", {}, error);
  return data ?? [];
}

export async function getBusinessSettings(locationRowId: string): Promise<BusinessSettingsRow | null> {
  const { data, error } = await getDb()
    .from("business_settings")
    .select("*")
    .eq("location_id", locationRowId)
    .maybeSingle<BusinessSettingsRow>();

  if (error) throw new DatabaseError("Could not load business settings.", { locationRowId }, error);
  return data;
}

export interface BusinessSettingsInput {
  businessName: string | null;
  businessDescription: string | null;
  brandVoice: string | null;
  preferredTone: string | null;
  maxResponseChars: number;
  contactPhone: string | null;
  contactEmail: string | null;
  escalationInstructions: string | null;
  phrasesToAvoid: string[];
  approvedPolicies: string[];
  locationNotes: string | null;
  autoPublishFiveStar: boolean;
  autoPublishFourStar: boolean;
  minAutoPublishRating: number;
}

/**
 * One row per location (`business_settings_location_unique`), so this is
 * always an upsert keyed on `location_id` — a business owner editing
 * Settings a second time updates the same row rather than creating a
 * history of them.
 */
export async function upsertBusinessSettings(
  locationRowId: string,
  input: BusinessSettingsInput,
): Promise<BusinessSettingsRow> {
  const { data, error } = await getDb()
    .from("business_settings")
    .upsert(
      {
        location_id: locationRowId,
        business_name: input.businessName,
        business_description: input.businessDescription,
        brand_voice: input.brandVoice,
        preferred_tone: input.preferredTone,
        max_response_chars: input.maxResponseChars,
        contact_phone: input.contactPhone,
        contact_email: input.contactEmail,
        escalation_instructions: input.escalationInstructions,
        phrases_to_avoid: input.phrasesToAvoid,
        approved_policies: input.approvedPolicies,
        location_notes: input.locationNotes,
        auto_publish_five_star: input.autoPublishFiveStar,
        auto_publish_four_star: input.autoPublishFourStar,
        min_auto_publish_rating: input.minAutoPublishRating,
      },
      { onConflict: "location_id" },
    )
    .select("*")
    .single<BusinessSettingsRow>();

  if (error || !data) throw new DatabaseError("Could not save business settings.", { locationRowId }, error);
  return data;
}
