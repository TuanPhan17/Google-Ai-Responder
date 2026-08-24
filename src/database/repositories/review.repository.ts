import { getDb, PG_NO_ROWS } from "@/database/supabase";
import { ConflictError, DatabaseError } from "@/utils/errors";
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
  human_review_required: boolean;
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
  /** The sticky, cross-regeneration gate — see evaluate-review.ts. */
  humanReviewRequired: boolean;
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
      human_review_required: update.humanReviewRequired,
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

// ---------------------------------------------------------------------------
// Approval workflow (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Every approval-workflow write below conditions its UPDATE on the review
 * still being in an allowed status, in the same statement that makes the
 * change — not on a status read moments earlier by the caller. Two requests
 * racing (a double-submitted click, or an approve and a reject landing at
 * the same time) can otherwise both pass an application-level pre-check and
 * both write, silently. Here, only the first writer's WHERE clause matches;
 * the second gets zero rows back and this throws ConflictError instead of
 * pretending the write happened.
 */
function throwOnZeroRowsOrError(action: string, reviewId: string, error: { code?: string } | null): never {
  if (error?.code === PG_NO_ROWS) {
    throw new ConflictError(`Cannot ${action}: the review's status changed before this could be applied.`, {
      reviewId,
    });
  }
  throw new DatabaseError(`Could not ${action}.`, { reviewId }, error);
}

/**
 * Marks a review approved. `finalResponse` is decided by the service layer —
 * the AI draft if untouched, or whatever a human last edited it to — never
 * computed here, so this function has no opinion about which one wins.
 */
export async function markApproved(
  reviewId: string,
  update: { finalResponse: string; approvedBy: string },
  allowedStatuses: ReviewStatus[],
): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({
      status: "APPROVED" satisfies ReviewStatus,
      final_response: update.finalResponse,
      approved_by: update.approvedBy,
      approved_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .in("status", allowedStatuses)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throwOnZeroRowsOrError("approve the review", reviewId, error);
  return data;
}

export async function markRejected(reviewId: string, allowedStatuses: ReviewStatus[]): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({ status: "REJECTED" satisfies ReviewStatus })
    .eq("id", reviewId)
    .in("status", allowedStatuses)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throwOnZeroRowsOrError("reject the review", reviewId, error);
  return data;
}

/**
 * Saves a human-edited draft. Always routes back through PENDING_APPROVAL —
 * even a review that was auto-publish-eligible (GENERATED) requires an
 * explicit approval after a human has touched the text, rather than letting
 * Phase 6 auto-publish an edit the deterministic policy never evaluated.
 */
export async function updateFinalResponse(
  reviewId: string,
  finalResponse: string,
  allowedStatuses: ReviewStatus[],
): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({ final_response: finalResponse, status: "PENDING_APPROVAL" satisfies ReviewStatus })
    .eq("id", reviewId)
    .in("status", allowedStatuses)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throwOnZeroRowsOrError("save the edited response", reviewId, error);
  return data;
}

/**
 * Reverses an approval. Only legal while the review hasn't published yet —
 * `published_at is null` is checked in the same WHERE clause as the status,
 * so a review that Phase 6 already posted to Google can never be walked
 * back into the queue as if the reply never went out.
 *
 * Also excludes `google_reply_state = 'PUBLISH_PENDING'`: that value means a
 * publish attempt has atomically claimed this row (see
 * claimReviewForPublishing below) and may be mid-flight to Google right now.
 * Without this, an unapprove could land in the gap between that claim and the
 * write that records the outcome — status is still APPROVED and published_at
 * is still null at that instant — and hand the review back to a human as if
 * nothing were happening, while a reply might be about to go out (or already
 * has) underneath them.
 */
const UNAPPROVABLE_REPLY_STATES: GoogleReplyState[] = ["NONE", "EXISTING_REPLY_FOUND", "PUBLISHED", "PUBLISH_FAILED"];

export async function markUnapproved(reviewId: string): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({
      status: "PENDING_APPROVAL" satisfies ReviewStatus,
      approved_by: null,
      approved_at: null,
    })
    .eq("id", reviewId)
    .eq("status", "APPROVED" satisfies ReviewStatus)
    .in("google_reply_state", UNAPPROVABLE_REPLY_STATES)
    .is("published_at", null)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throwOnZeroRowsOrError("unapprove the review", reviewId, error);
  return data;
}

// ---------------------------------------------------------------------------
// Publishing (Phase 6)
// ---------------------------------------------------------------------------

/**
 * Atomically claims a review for publishing.
 *
 * This is the actual "re-check state right before calling Google" guard —
 * not a SELECT the caller reasons about afterwards, but a single
 * UPDATE ... WHERE that only succeeds if the row is *still* eligible at the
 * exact moment it runs. `google_reply_state` is the lock: moving it to
 * PUBLISH_PENDING is what stops markUnapproved (see above) or a second,
 * concurrent publish attempt from proceeding once this one has the row.
 *
 * `NONE` and `PUBLISH_FAILED` are both claimable — the latter is what makes a
 * retry possible after a failed attempt. `PUBLISH_PENDING` deliberately is
 * not: a review already claimed cannot be claimed twice.
 *
 * `status` is left untouched by the claim (still APPROVED or GENERATED,
 * whichever it was) — publishing failure only ever needs to revert
 * `google_reply_state`, never has to remember which status to restore.
 */
const PUBLISH_CLAIMABLE_REPLY_STATES: GoogleReplyState[] = ["NONE", "PUBLISH_FAILED"];

export async function claimReviewForPublishing(
  reviewId: string,
  allowedStatuses: ReviewStatus[],
): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({ google_reply_state: "PUBLISH_PENDING" satisfies GoogleReplyState })
    .eq("id", reviewId)
    .in("status", allowedStatuses)
    .in("google_reply_state", PUBLISH_CLAIMABLE_REPLY_STATES)
    .is("published_at", null)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throwOnZeroRowsOrError("claim the review for publishing", reviewId, error);
  return data;
}

/**
 * Records a successful publish. Guarded on `google_reply_state =
 * 'PUBLISH_PENDING'` — only the attempt that holds the claim can complete it.
 * `finalResponse` is written here (not just read) because the automatic
 * low-risk path (GENERATED) never went through `markApproved`, so
 * `final_response` may still be null; this is the first point at which "what
 * was actually published" needs to exist as a fact independent of
 * `ai_response`.
 */
export async function markPublished(
  reviewId: string,
  update: { finalResponse: string; publishedAt: string },
): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({
      status: "PUBLISHED" satisfies ReviewStatus,
      final_response: update.finalResponse,
      published_at: update.publishedAt,
      google_reply_state: "PUBLISHED" satisfies GoogleReplyState,
    })
    .eq("id", reviewId)
    .eq("google_reply_state", "PUBLISH_PENDING" satisfies GoogleReplyState)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throwOnZeroRowsOrError("mark the review published", reviewId, error);
  return data;
}

/**
 * Records a failed publish attempt. `status` is deliberately left alone —
 * the review stays APPROVED or GENERATED, exactly where it was before the
 * claim, so it remains eligible for a later retry through the normal
 * publishReview entrypoint rather than needing a separate "un-fail" action.
 */
export async function markPublishFailed(reviewId: string, lastError: string): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({
      google_reply_state: "PUBLISH_FAILED" satisfies GoogleReplyState,
      last_error: lastError.slice(0, 2000),
    })
    .eq("id", reviewId)
    .eq("google_reply_state", "PUBLISH_PENDING" satisfies GoogleReplyState)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throwOnZeroRowsOrError("mark the review publish-failed", reviewId, error);
  return data;
}

/**
 * Records that Google already has a reply this application did not just
 * write — discovered live, immediately before what would have been the
 * publish call. Routes back to PENDING_APPROVAL rather than leaving the
 * review APPROVED/GENERATED, because whatever made it eligible (a human
 * approval, or the auto-publish policy) was decided without knowing this.
 */
export async function markPublishBlockedByExistingReply(
  reviewId: string,
  update: { existingReply: string; existingReplyUpdateTime: string | null },
): Promise<ReviewRow> {
  const { data, error } = await getDb()
    .from("reviews")
    .update({
      status: "PENDING_APPROVAL" satisfies ReviewStatus,
      google_reply_state: "EXISTING_REPLY_FOUND" satisfies GoogleReplyState,
      existing_google_reply: update.existingReply,
      existing_reply_updated_at: update.existingReplyUpdateTime,
    })
    .eq("id", reviewId)
    .eq("google_reply_state", "PUBLISH_PENDING" satisfies GoogleReplyState)
    .select("*")
    .single<ReviewRow>();

  if (error || !data) throwOnZeroRowsOrError("mark the review blocked on an existing reply", reviewId, error);
  return data;
}

// ---------------------------------------------------------------------------
// Background sweep (Phase 7)
// ---------------------------------------------------------------------------

/**
 * IDs of GENERATED reviews the deterministic publishing policy already
 * cleared for AUTO_PUBLISH (`src/policies/publishing-policy.ts`), that
 * nothing has published yet. This is only a candidate list — the actual
 * eligibility guard is `claimReviewForPublishing`, run per-review by
 * `publishReview` itself, so a stale or slightly-off candidate here just
 * costs one wasted claim attempt, never an incorrect publish.
 */
export async function findAutoPublishEligibleReviewIds(limit: number): Promise<string[]> {
  const { data, error } = await getDb()
    .from("reviews")
    .select("id")
    .eq("status", "GENERATED" satisfies ReviewStatus)
    .in("google_reply_state", PUBLISH_CLAIMABLE_REPLY_STATES)
    .is("published_at", null)
    .order("created_at", { ascending: true })
    .limit(limit)
    .returns<Array<{ id: string }>>();

  if (error) throw new DatabaseError("Could not list auto-publish-eligible reviews.", {}, error);
  return (data ?? []).map((row) => row.id);
}

/**
 * IDs of PUBLISH_PENDING rows whose claim looks abandoned — last touched
 * before `olderThanMs` ago. A review claimed by `claimReviewForPublishing`
 * normally resolves (to PUBLISHED or PUBLISH_FAILED) within one Google HTTP
 * round trip; still sitting in PUBLISH_PENDING past this threshold means the
 * process that held the claim died outright rather than merely being slow —
 * an ordinary error would have hit the `catch` in publishReview and already
 * demoted the row to PUBLISH_FAILED. This is only a candidate list, same
 * caveat as above: `claimStalePublishPendingReview` is the real guard.
 */
export async function findStalePublishPendingReviewIds(olderThanMs: number, limit: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await getDb()
    .from("reviews")
    .select("id")
    .eq("google_reply_state", "PUBLISH_PENDING" satisfies GoogleReplyState)
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(limit)
    .returns<Array<{ id: string }>>();

  if (error) throw new DatabaseError("Could not list stale PUBLISH_PENDING reviews.", {}, error);
  return (data ?? []).map((row) => row.id);
}

/**
 * Atomically force-reclaims one stale PUBLISH_PENDING row for the sweep.
 *
 * Same idiom as `claimReviewForPublishing`: a single UPDATE ... WHERE that
 * only matches if the row is *still* stale — `updated_at` still older than
 * the cutoff — at the exact instant it runs. The write sets
 * `google_reply_state` to the value it already had; that's not a no-op,
 * though, because the `reviews_set_updated_at` trigger fires on any UPDATE
 * and bumps `updated_at` regardless of which columns actually changed. That
 * bump is what stops a second sweep tick — or a second sweep process running
 * concurrently — from claiming the same row: its own `updated_at < cutoff`
 * clause will no longer match once the first claim has landed. Under
 * Postgres's read-committed semantics, an UPDATE re-checks its WHERE clause
 * against each row's current values after acquiring that row's lock, so two
 * concurrent claims on the same id resolve exactly like two concurrent
 * `claimReviewForPublishing` calls: only the first to acquire the lock has
 * its WHERE clause still match; the second re-evaluates against the
 * now-fresh `updated_at` and gets zero rows.
 *
 * Returns `null` — not a thrown `ConflictError` — when the claim doesn't
 * land. Unlike the interactive publish endpoint, where a lost race is
 * reported to a caller as a 409, a sweep losing this race is the expected,
 * silent case: another sweep tick already reclaimed the row, or an ordinary
 * `publishReview` retry resolved it in the meantime. Neither is a failure
 * worth surfacing.
 */
export async function claimStalePublishPendingReview(
  reviewId: string,
  olderThanMs: number,
): Promise<ReviewRow | null> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await getDb()
    .from("reviews")
    .update({ google_reply_state: "PUBLISH_PENDING" satisfies GoogleReplyState })
    .eq("id", reviewId)
    .eq("google_reply_state", "PUBLISH_PENDING" satisfies GoogleReplyState)
    .lt("updated_at", cutoff)
    .select("*")
    .maybeSingle<ReviewRow>();

  if (error) throw new DatabaseError("Could not claim the stale review for sweep recovery.", { reviewId }, error);
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
