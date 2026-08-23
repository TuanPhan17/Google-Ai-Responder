import { getDb } from "@/database/supabase";
import { DatabaseError } from "@/utils/errors";
import type {
  AccountSummary,
  AuditEvent,
  GoogleReplyState,
  LocationSummary,
  NormalizedReview,
  PublishDecision,
  ReviewStatus,
  RiskLevel,
  Sentiment,
} from "@/types/review";

/**
 * Persistence for accounts, locations, reviews and the audit trail.
 *
 * The interesting part is `upsertReview`, which is where at-least-once
 * delivery gets absorbed. See the comment on that function.
 */

export interface ReviewRow {
  id: string;
  location_id: string;
  google_review_id: string;
  google_review_name: string | null;
  google_account_id: string;
  google_location_id: string;
  location_title: string | null;
  reviewer_name: string | null;
  reviewer_is_anonymous: boolean;
  rating: number | null;
  review_text: string | null;
  review_created_at: string;
  review_updated_at: string;
  is_edited: boolean;
  edit_count: number;
  status: ReviewStatus;
  google_reply_state: GoogleReplyState;
  existing_google_reply: string | null;
  existing_reply_updated_at: string | null;
  ai_response: string | null;
  final_response: string | null;
  sentiment: Sentiment | null;
  risk_level: RiskLevel | null;
  needs_human_review: boolean | null;
  ai_reason: string | null;
  referenced_details: string[];
  ai_model: string | null;
  publish_decision: PublishDecision | null;
  publish_decision_reason: string | null;
  processing_attempts: number;
  last_error: string | null;
  published_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Accounts and locations
// ---------------------------------------------------------------------------

export async function upsertAccounts(
  connectionId: string,
  accounts: AccountSummary[],
): Promise<Array<{ id: string; googleAccountId: string }>> {
  if (accounts.length === 0) return [];

  const { data, error } = await getDb()
    .from("google_accounts")
    .upsert(
      accounts.map((account) => ({
        connection_id: connectionId,
        google_account_id: account.accountId,
        resource_name: account.name,
        account_name: account.accountName,
        account_type: account.type,
        verification_state: account.verificationState,
      })),
      { onConflict: "connection_id,google_account_id" },
    )
    .select("id, google_account_id");

  if (error || !data) throw new DatabaseError("Could not save Google accounts.", { connectionId }, error);

  return data.map((row) => ({ id: row.id as string, googleAccountId: row.google_account_id as string }));
}

export async function findAccountRowId(
  connectionId: string,
  googleAccountId: string,
): Promise<string | null> {
  const { data, error } = await getDb()
    .from("google_accounts")
    .select("id")
    .eq("connection_id", connectionId)
    .eq("google_account_id", googleAccountId)
    .maybeSingle<{ id: string }>();

  if (error) throw new DatabaseError("Could not look up the Google account.", { googleAccountId }, error);
  return data?.id ?? null;
}

export async function upsertLocations(
  accountRowId: string,
  locations: LocationSummary[],
): Promise<Array<{ id: string; googleLocationId: string }>> {
  if (locations.length === 0) return [];

  const { data, error } = await getDb()
    .from("locations")
    .upsert(
      locations.map((location) => ({
        google_account_id: accountRowId,
        google_location_id: location.locationId,
        resource_name: location.name,
        title: location.title,
        store_code: location.storeCode,
        address: location.address,
        website_uri: location.websiteUri,
        maps_uri: location.mapsUri,
        place_id: location.placeId,
      })),
      // Note: auto_publish_enabled is intentionally omitted. An upsert must
      // never silently reset a business owner's safety switch.
      { onConflict: "google_account_id,google_location_id" },
    )
    .select("id, google_location_id");

  if (error || !data) throw new DatabaseError("Could not save locations.", { accountRowId }, error);

  return data.map((row) => ({ id: row.id as string, googleLocationId: row.google_location_id as string }));
}

export async function findLocationRowId(googleLocationId: string): Promise<string | null> {
  const { data, error } = await getDb()
    .from("locations")
    .select("id")
    .eq("google_location_id", googleLocationId)
    .maybeSingle<{ id: string }>();

  if (error) throw new DatabaseError("Could not look up the location.", { googleLocationId }, error);
  return data?.id ?? null;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export async function findReview(
  locationRowId: string,
  googleReviewId: string,
): Promise<ReviewRow | null> {
  const { data, error } = await getDb()
    .from("reviews")
    .select("*")
    .eq("location_id", locationRowId)
    .eq("google_review_id", googleReviewId)
    .maybeSingle<ReviewRow>();

  if (error) throw new DatabaseError("Could not look up the review.", { googleReviewId }, error);
  return data;
}

/** Primary-key lookup, used by the processing pipeline (Phase 4), which only ever knows the internal id. */
export async function findReviewById(reviewId: string): Promise<ReviewRow | null> {
  const { data, error } = await getDb().from("reviews").select("*").eq("id", reviewId).maybeSingle<ReviewRow>();

  if (error) throw new DatabaseError("Could not look up the review.", { reviewId }, error);
  return data;
}

export async function insertReview(
  locationRowId: string,
  review: NormalizedReview,
  replyState: GoogleReplyState,
): Promise<ReviewRow> {
  /**
   * `upsert` with `ignoreDuplicates: false` rather than `insert`.
   *
   * Two Pub/Sub deliveries of the same review can race: both read "not
   * found", both try to insert, one loses on the unique constraint. Letting
   * the database resolve the race — rather than catching 23505 and re-reading
   * — means there is exactly one code path, and it is the one Postgres
   * guarantees is atomic.
   */
  const { data, error } = await getDb()
    .from("reviews")
    .upsert(
      {
        location_id: locationRowId,
        google_review_id: review.googleReviewId,
        google_review_name: review.googleReviewName,
        google_account_id: review.googleAccountId,
        google_location_id: review.googleLocationId,
        location_title: review.locationTitle,
        reviewer_name: review.reviewerName,
        reviewer_is_anonymous: review.reviewerIsAnonymous,
        rating: review.rating,
        review_text: review.reviewText,
        review_created_at: review.reviewCreateTime,
        review_updated_at: review.reviewUpdateTime,
        existing_google_reply: review.existingReplyText,
        existing_reply_updated_at: review.existingReplyUpdateTime,
        google_reply_state: replyState,
        status: "RECEIVED" satisfies ReviewStatus,
      },
      { onConflict: "location_id,google_review_id", ignoreDuplicates: false },
    )
    .select("*")
    .single<ReviewRow>();

  if (error || !data) {
    throw new DatabaseError("Could not save the review.", { googleReviewId: review.googleReviewId }, error);
  }
  return data;
}

export async function applyReviewEdit(
  reviewId: string,
  review: NormalizedReview,
  replyState: GoogleReplyState,
  contentChanged: boolean,
  previousEditCount: number,
): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({
      rating: review.rating,
      review_text: review.reviewText,
      review_updated_at: review.reviewUpdateTime,
      reviewer_name: review.reviewerName,
      reviewer_is_anonymous: review.reviewerIsAnonymous,
      existing_google_reply: review.existingReplyText,
      existing_reply_updated_at: review.existingReplyUpdateTime,
      google_reply_state: replyState,
      ...(contentChanged
        ? {
            is_edited: true,
            edit_count: previousEditCount + 1,
            // Re-open the review for analysis. Phase 4 re-runs generation from
            // here; it never overwrites a reply already live on Google.
            status: "RECEIVED" satisfies ReviewStatus,
          }
        : {}),
    })
    .eq("id", reviewId)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throw new DatabaseError("Could not update the edited review.", { reviewId }, error);
  return data;
}

// ---------------------------------------------------------------------------
// AI generation / processing states (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Moves a review into PROCESSING and records the attempt count.
 *
 * `nextAttempt` is computed by the caller from the row it already holds
 * (`processing_attempts + 1`) rather than an atomic increment in SQL — this
 * assumes a single writer per review, the same assumption the rest of this
 * codebase already makes (see the token-refresh singleflight note). Two
 * concurrent calls racing here is a known, accepted gap, not something this
 * function guards against.
 */
export async function markProcessing(reviewId: string, nextAttempt: number): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({ status: "PROCESSING" satisfies ReviewStatus, processing_attempts: nextAttempt })
    .eq("id", reviewId)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throw new DatabaseError("Could not mark the review as processing.", { reviewId }, error);
  return data;
}

export interface GeneratedResponseUpdate {
  aiResponse: string;
  sentiment: Sentiment;
  riskLevel: RiskLevel;
  needsHumanReview: boolean;
  aiReason: string;
  referencedDetails: string[];
  aiModel: string;
  publishDecision: PublishDecision;
  publishDecisionReason: string;
  /** GENERATED (auto-publish eligible) or PENDING_APPROVAL — decided by the publishing policy, not here. */
  status: ReviewStatus;
}

/** Persists a successful generation. Clears any previous last_error — this run is what counts now. */
export async function saveGeneratedResponse(reviewId: string, update: GeneratedResponseUpdate): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({
      ai_response: update.aiResponse,
      sentiment: update.sentiment,
      risk_level: update.riskLevel,
      needs_human_review: update.needsHumanReview,
      ai_reason: update.aiReason,
      referenced_details: update.referencedDetails,
      ai_model: update.aiModel,
      publish_decision: update.publishDecision,
      publish_decision_reason: update.publishDecisionReason,
      status: update.status,
      last_error: null,
    })
    .eq("id", reviewId)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throw new DatabaseError("Could not save the generated response.", { reviewId }, error);
  return data;
}

/** Records that generation ultimately failed. The row stays FAILED until a human triggers a retry (Phase 5). */
export async function markProcessingFailed(reviewId: string, lastError: string): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({ status: "FAILED" satisfies ReviewStatus, last_error: lastError.slice(0, 2000) })
    .eq("id", reviewId)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throw new DatabaseError("Could not mark the review as failed.", { reviewId }, error);
  return data;
}

/** Snapshots the customer's previous text before an edit overwrites it. */
export async function recordRevision(reviewId: string, row: ReviewRow): Promise<void> {
  const { error } = await getDb().from("review_revisions").insert({
    review_id: reviewId,
    rating: row.rating,
    review_text: row.review_text,
    review_updated_at: row.review_updated_at,
  });

  if (error) throw new DatabaseError("Could not record the review revision.", { reviewId }, error);
}

export async function listReviews(options: {
  locationRowId?: string;
  limit?: number;
} = {}): Promise<ReviewRow[]> {
  let query = getDb()
    .from("reviews")
    .select("*")
    .order("review_created_at", { ascending: false })
    .limit(options.limit ?? 50);

  if (options.locationRowId) query = query.eq("location_id", options.locationRowId);

  const { data, error } = await query.returns<ReviewRow[]>();
  if (error) throw new DatabaseError("Could not list reviews.", {}, error);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/**
 * Audit writes never throw into the caller's path. Losing an audit line is
 * bad; failing a review ingest *because* an audit line could not be written is
 * worse. The failure is logged loudly instead.
 */
export async function recordEvent(
  reviewId: string | null,
  event: AuditEvent,
  detail: Record<string, unknown> = {},
  actor = "system",
): Promise<void> {
  const { error } = await getDb().from("review_events").insert({
    review_id: reviewId,
    event,
    actor,
    detail,
  });

  if (error) {
    const { logger } = await import("@/utils/logger");
    logger.error("Audit write failed", { event, reviewId, error: error.message });
  }
}

export async function listEvents(reviewId: string, limit = 50) {
  const { data, error } = await getDb()
    .from("review_events")
    .select("*")
    .eq("review_id", reviewId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new DatabaseError("Could not list review events.", { reviewId }, error);
  return data ?? [];
}
