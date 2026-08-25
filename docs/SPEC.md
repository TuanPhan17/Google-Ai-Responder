# Google Review AI Responder

You are a senior full-stack AI engineer. Build a production-ready application that automatically receives Google Business Profile reviews, analyzes each review individually, generates a personalized response, and either publishes the response automatically or routes it to a human for approval.

Treat this document as the **master project specification**.

## Important Development Rule

Build this project **incrementally, one phase at a time**.

Do **not** attempt to implement the entire application in one response.

For each phase:

1. Explain the architectural decisions.
2. Create the necessary files and code.
3. Provide complete code rather than pseudocode.
4. Explain environment variables and configuration.
5. Explain how to run the phase locally.
6. Provide a clear way to test that the phase works.
7. Identify any Google Cloud, Google Business Profile, Supabase, or OpenAI setup that I must perform manually.

Phase 1 is complete. Implement only the phase you are explicitly asked for, and stop at the phase boundary.

---

# Primary Objective

Create a **Google Review Response Bot** that generates responses that sound like a real business owner wrote them.

Responses must be personalized to the actual content of each customer's review rather than relying on generic templates.

Bad:

> "Thank you for your review! We appreciate your business and hope to see you again."

Better:

> "Thanks for the kind words, Sarah! We're glad Mike was able to walk you through the repair process and get your car finished ahead of schedule. We really appreciate you choosing us and hope to see you again."

The second response is preferred because it naturally references specific information contained in the customer's review.

The system must never invent details that were not supplied by the review or verified business information.

---

# Technology Stack

Use:

* TypeScript
* Node.js
* Next.js for the admin dashboard
* Google Business Profile API
* Google My Business Notifications API where supported
* Google Cloud Pub/Sub
* OpenAI Responses API
* Supabase PostgreSQL
* OAuth 2.0 for Google authentication
* Zod for runtime schema validation
* Environment variables or a secure secret manager for credentials

Prefer a clean TypeScript architecture with reusable services.

Do not expose:

* Google OAuth secrets
* OpenAI API keys
* Supabase service-role credentials
* database credentials
* refresh tokens

in client-side code.

---

# High-Level Application Workflow

Implement the following workflow:

1. Receive notification that a new Google review has been created or updated.
2. Retrieve the full review from Google Business Profile.
3. Extract:

   * Google review ID
   * Google account ID
   * location ID
   * business/location name
   * reviewer name
   * star rating
   * review text
   * review timestamp
   * last updated timestamp
   * existing Google reply if one exists
4. Check whether the review has already been processed.
5. Save or update the review in the database.
6. Send only the information required for response generation to the AI service.
7. Analyze:

   * sentiment
   * meaningful details mentioned
   * employee names if explicitly mentioned
   * products/services explicitly mentioned
   * complaint type
   * appropriate tone
   * potential risk
   * whether human review is recommended
8. Generate a personalized response.
9. Validate the AI output using a strict Zod schema.
10. Run deterministic application-level publishing rules.
11. If eligible for automatic publishing, publish through the Google Business Profile API.
12. Otherwise, save the review as `PENDING_APPROVAL`.
13. Save:

* review
* generated response
* AI classification
* model used
* publishing decision
* timestamps
* errors
* approval history

14. Ensure duplicate events can never accidentally cause duplicate Google replies.

---

# Important Safety Architecture

The AI model must **not have final authority over whether a response is automatically published**.

The model may return:

`needsHumanReview`

and:

`riskLevel`

but application code must independently enforce publishing rules.

For example:

* 1-star reviews must never auto-publish.
* 2-star reviews must never auto-publish.
* 3-star reviews must never auto-publish.
* Medium-risk reviews must never auto-publish.
* High-risk reviews must never auto-publish.

Even if the AI incorrectly returns:

`needsHumanReview: false`

the deterministic application rules must override the model.

Create a reusable publishing-policy service for this logic.

---

# AI Review Response Rules

Every generated response must be based on the individual customer's review.

Before generating the response, internally determine:

* What specifically happened?
* Is the experience positive, mixed, or negative?
* What meaningful detail can naturally be referenced?
* Is an employee explicitly mentioned?
* Is a specific product or service explicitly mentioned?
* Is there criticism or a complaint?
* Is there a potentially sensitive situation?
* Is this review safe for automatic publishing?

Whenever possible, identify **one or two meaningful details** from the review and naturally incorporate them into the response.

Do not simply paraphrase the entire review.

Never invent information.

Only mention:

* services
* employees
* products
* experiences
* problems
* locations
* dates
* circumstances
* business policies

when they are explicitly stated in the customer review or supplied as verified business information.

Never pretend to know something that was not provided.

---

# Reviewer Names

If the reviewer's first name is available, the response may use it when it sounds natural.

Do not force the person's name into every response.

Never make assumptions regarding:

* gender
* identity
* relationships
* personal circumstances
* private information

---

# 5-Star Reviews

For strongly positive reviews:

* Thank the customer naturally.
* Mention something specific they enjoyed whenever possible.
* Show genuine appreciation.
* Keep the response friendly.
* Invite them back when appropriate.

Avoid repeatedly using phrases such as:

> "Thank you for your 5-star review!"

Responses should vary naturally from one customer to another.

---

# 4-Star Reviews

For positive reviews containing minor criticism:

* Thank the customer.
* Mention something they liked.
* Briefly acknowledge the constructive criticism.
* Do not become defensive.
* Indicate that the feedback is appreciated.

Low-risk 4-star reviews may be eligible for automatic publishing.

---

# 3-Star Reviews

Treat 3-star reviews as mixed feedback.

The response should:

* Thank the customer.
* Recognize the positive part of the experience.
* Acknowledge the problem or criticism.
* Remain professional.
* Avoid arguing.

All 3-star reviews require human approval before publishing.

---

# 1-Star and 2-Star Reviews

For negative reviews:

* Remain professional and calm.
* Acknowledge the customer's frustration.
* Apologize for the poor experience when appropriate.
* Address the specific issue described without arguing.
* Never insult, threaten, shame, or blame the reviewer.
* Never disclose private customer information.
* Never admit legal liability.
* Never make claims about facts that cannot be verified.
* Never promise refunds, compensation, discounts, replacements, or other remedies unless the business has explicitly configured a policy allowing it.
* Encourage private contact when the situation requires investigation.

All 1-star and 2-star reviews require human approval.

---

# High-Risk Review Detection

Set `needsHumanReview` to `true` when a review involves or appears to involve:

* lawsuits
* legal threats
* attorneys
* police
* fraud allegations
* scams
* theft
* harassment
* discrimination
* racism
* sexual harassment
* safety incidents
* injuries
* medical issues
* chargebacks
* refund disputes
* employee misconduct allegations
* threats
* personal/private information
* media threats
* government complaints
* regulatory complaints
* situations where important facts cannot be verified
* serious accusations against the business or employees

Do not automatically post responses to these reviews.

Generate a professional draft for the business owner instead.

---

# Star-Only Reviews

Customers may leave a rating without written text.

If no review text exists:

* Generate a short response based only on the rating.
* Do not invent details in an attempt to personalize it.
* The customer's first name may be used if available and natural.

Example:

> "Thanks for the five stars, Jason! We really appreciate your support and hope to see you again."

---

# Tone

Default business tone:

* Friendly
* Human
* Professional
* Appreciative
* Conversational
* Concise

Avoid corporate-sounding or obviously AI-generated language.

Avoid excessive use of phrases such as:

* "We sincerely appreciate..."
* "Your feedback is invaluable..."
* "We strive to..."
* "Thank you for taking the time..."

Vary:

* sentence structure
* opening phrases
* closing phrases
* vocabulary

Responses should generally be **2–5 sentences** unless the situation requires additional explanation.

Do not vary language simply for randomness if it makes the response less natural.

---

# Structured AI Output

The OpenAI service must return structured data matching this shape:

```json
{
  "reply": "Final Google review response",
  "sentiment": "positive",
  "rating": 5,
  "needsHumanReview": false,
  "riskLevel": "low",
  "reason": "Positive customer review with no sensitive issues.",
  "referencedDetails": [
    "fast service",
    "employee Mike"
  ]
}
```

Allowed sentiment values:

* `positive`
* `mixed`
* `negative`

Allowed risk levels:

* `low`
* `medium`
* `high`

Validate this structure using **Zod** before the result is saved or used.

If validation fails:

1. Do not publish anything.
2. Log the validation error safely.
3. Retry generation according to the retry policy.
4. If retries fail, set the review status to `FAILED`.

---

# Auto-Publishing Rules

Initial default rules:

### 5-Star

May auto-publish when:

* risk is `low`
* deterministic safety checks pass
* no existing reply exists
* business settings allow auto-publishing

### 4-Star

May auto-publish when:

* risk is `low`
* deterministic safety checks pass
* no existing reply exists
* business settings allow auto-publishing

### 3-Star

Always requires human approval.

### 2-Star

Always requires human approval.

### 1-Star

Always requires human approval.

### Medium or High Risk

Always requires human approval regardless of rating.

These rules must be configurable so a business owner can make them stricter later.

The application must never allow configuration that bypasses mandatory high-risk protections.

---

# Duplicate Prevention and Idempotency

Pub/Sub and external APIs may deliver duplicate events.

The application must be idempotent.

At minimum:

* `googleReviewId + locationId` must uniquely identify a review.
* Duplicate events must update or reuse the existing record rather than create duplicate records.
* Before publishing, check whether Google already has a reply.
* Store the timestamp and result of publication.
* Ensure retrying a failed workflow cannot accidentally create a second reply.
* Use database-level uniqueness constraints where appropriate.

Explain the idempotency strategy clearly.

---

# Edited Reviews

Customers may edit reviews after posting them.

When an existing review changes:

1. Update the stored review.
2. Record that the review was edited.
3. Re-run analysis.
4. Generate a new draft if appropriate.
5. If the business has already replied, do **not automatically overwrite the existing Google response**.
6. Route the changed review and new draft to human approval unless configured otherwise by a future safe policy.

Keep revision history where practical.

---

# Existing Google Replies

If a review already contains a business reply:

* Do not automatically post another reply.
* Save the existing Google reply.
* Mark the review accordingly.
* Allow the dashboard to display the existing response.

---

# Database

Use Supabase PostgreSQL.

Create proper schema migrations.

Store at minimum:

* internal review UUID
* Google review ID
* Google account ID
* location ID
* business/location name
* reviewer name
* rating
* original review text
* review timestamp
* Google review updated timestamp
* whether the review has been edited
* AI-generated response
* final approved response
* existing Google response
* sentiment
* risk level
* human approval requirement
* publishing status
* Google reply status
* AI model used
* AI reason
* referenced details
* processing attempts
* last error
* created timestamp
* updated timestamp
* published timestamp
* approved timestamp
* approved by

Statuses should include:

* `RECEIVED`
* `PROCESSING`
* `GENERATED`
* `PENDING_APPROVAL`
* `APPROVED`
* `PUBLISHED`
* `REJECTED`
* `FAILED`

Use appropriate:

* primary keys
* foreign keys
* unique constraints
* indexes
* enums or validated status fields

---

# Audit Trail

Create an audit trail for important actions.

Track events such as:

* review received
* review edited
* AI generation started
* AI generation completed
* AI generation failed
* response regenerated
* response edited by human
* approved
* rejected
* automatic publishing decision
* response published
* publishing failed

Preserve both:

* the original AI-generated response
* the final response that was actually published

when they differ.

---

# Admin Dashboard

Build a simple Next.js dashboard.

## New Reviews

Show:

* customer
* rating
* original review
* proposed AI response
* referenced details
* sentiment
* risk level
* why human approval is required
* current status

Actions:

* Approve & Publish
* Edit
* Regenerate
* Reject

Any edited response must still pass publishing safety checks.

## Published

Show previously published responses, including:

* original review
* final response
* publication timestamp
* whether the response was automatic or human-approved

## Settings

Allow configuration of:

* business name
* business description
* brand voice
* preferred tone
* maximum response length
* auto-publish rating threshold
* contact phone
* contact email
* complaint escalation instructions
* phrases to avoid
* approved business policies
* location-specific information
* whether low-risk 4-star reviews may auto-publish
* whether low-risk 5-star reviews may auto-publish

Only verified settings should be supplied to the AI as business context.

---

# Google Integration

Use Google OAuth 2.0.

Implement:

* OAuth authorization
* secure token storage
* access-token refresh
* Google Business Profile account retrieval
* location retrieval
* review retrieval
* review reply publishing
* Pub/Sub notification handling where supported

Handle:

* expired access tokens
* refresh-token failures
* revoked access
* API errors
* duplicate Pub/Sub events
* rate limits
* missing review text
* edited reviews
* reviews that already contain replies
* temporarily unavailable Google services

Never expose OAuth secrets or refresh tokens to the browser.

Verify Google's current API requirements and endpoint behavior rather than assuming deprecated Google My Business API behavior.

---

# Pub/Sub

Prefer Google Cloud Pub/Sub notifications over repeatedly polling Google.

The Pub/Sub handling system must:

* validate incoming messages
* safely decode payloads
* handle malformed messages
* acknowledge valid events appropriately
* tolerate duplicate delivery
* log failures without exposing secrets
* trigger review retrieval rather than trusting notification payloads as the complete source of review data

Treat Google Business Profile as the authoritative source for the full review.

---

# API Retry Strategy

External APIs may fail temporarily.

Implement reusable retry handling for:

* OpenAI
* Google APIs
* publishing requests

Use:

* exponential backoff
* reasonable maximum attempts
* handling for rate-limit responses
* handling for temporary server errors

Do not retry permanently invalid requests indefinitely.

Publishing retries must preserve idempotency.

---

# OpenAI Integration

Use the OpenAI Responses API.

Create a reusable OpenAI review-response service.

Responsibilities:

* construct the review context
* include verified business context
* request structured output
* validate output
* retry temporary failures
* return strongly typed results

Do not send unnecessary personal information to OpenAI.

Keep AI prompts separated from application business logic.

Business publishing rules must remain in application code.

---

# Security

Follow production-oriented security practices.

Requirements:

* Secrets only in environment variables or a secure secret manager.
* Never commit `.env` files.
* Provide `.env.example`.
* Validate server-side inputs.
* Validate Pub/Sub requests.
* Protect admin dashboard routes.
* Never expose privileged Supabase credentials to the client.
* Never expose Google refresh tokens to the client.
* Never expose OpenAI credentials to the client.
* Sanitize logs.
* Do not log secrets.
* Do not log unnecessary customer private information.
* Minimize customer information sent to AI.
* Use least-privilege access wherever practical.

---

# Project Architecture

Do not create the application as one giant file.

Use a clean, maintainable architecture similar to:

```text
/src
  /app
  /api
  /auth
  /google
  /openai
  /reviews
  /database
  /services
  /policies
  /schemas
  /types
  /utils
  /config

/supabase
  /migrations

/tests
```

The exact structure may be improved if you explain why.

Create reusable services for:

* Google authentication
* Google Business Profile
* OpenAI
* database operations
* review processing
* risk/publishing policy
* Pub/Sub
* retry handling
* audit logging

Use dependency boundaries that make these services testable.

---

# Local Development and Mock Mode

The application must be testable before a real Google Business Profile account is fully connected.

Create a development/mock mode that allows test reviews to be submitted locally.

The mock workflow should allow testing of:

`Test review → AI analysis → database → publishing policy → dashboard`

without actually publishing anything to Google.

Provide test fixtures for:

1. Very positive detailed review.
2. Five-star review with no text.
3. Four-star review with minor criticism.
4. Three-star mixed review.
5. Angry one-star review.
6. Review mentioning an employee.
7. Review requesting a refund.
8. Review threatening legal action.
9. Review containing private information.
10. Extremely vague review.
11. Review accusing the business of fraud.
12. Duplicate review event.
13. Edited review.
14. Review that already contains a business reply.

---

# Testing Requirements

Use automated tests where practical.

Test:

* AI structured output validation
* deterministic publishing policy
* high-risk classification handling
* duplicate-event protection
* database uniqueness constraints
* star-only reviews
* existing replies
* edited reviews
* failed AI generation
* failed publishing
* retry logic

Critical tests must confirm:

* 1–3 star reviews cannot automatically publish.
* Medium/high-risk reviews cannot automatically publish.
* Duplicate events cannot create duplicate replies.
* AI output failing schema validation cannot be published.
* Reviews containing legal threats or serious allegations cannot auto-publish.
* Star-only reviews do not invent details.
* Responses only reference details supplied in the review or verified business configuration.

---

# Development Phases

## Phase 1 — Foundation + Google Authentication

Create:

* project structure
* TypeScript configuration
* environment configuration
* Supabase setup/schema foundation
* Google OAuth flow
* secure token storage
* Google account/location retrieval
* Google review retrieval
* mock review fixtures
* initial README

Do not add OpenAI response generation yet.

## Phase 2 — OpenAI Integration

Create:

* OpenAI Responses API service
* response-generation prompt
* structured output schema
* Zod validation
* personalization logic
* initial AI tests

## Phase 3 — Risk and Publishing Policy

Create:

* risk classification workflow
* deterministic publishing-policy service
* star-rating rules
* high-risk handling
* safety tests

## Phase 4 — Database Workflow

Complete:

* review persistence
* AI output persistence
* processing states
* idempotency
* audit logging
* revision handling

## Phase 5 — Approval Workflow

Create:

* pending approval system
* approve
* edit
* regenerate
* reject
* audit tracking

## Phase 6 — Google Publishing

Implement:

* approved-response publishing
* automatic low-risk publishing
* existing-reply checks
* publishing retries
* idempotent publishing

## Phase 7 — Pub/Sub Automation

Implement:

* Google review notification handling
* Pub/Sub processing
* duplicate message protection
* automatic processing workflow

### Known gaps this phase must close

* **Stuck `PUBLISH_PENDING` rows.** Closed, code-side — see "Phase 7
  (code-only pass)" below. `src/reviews/sweep.service.ts` force-reclaims
  stale `PUBLISH_PENDING` rows and resolves them through the same live-Google
  recovery path `publishReview` itself uses. Wiring an actual scheduler to
  call it is still outstanding.
* **Closed.** Pub/Sub notification handling and the webhook endpoint are
  implemented — `POST /api/pubsub/reviews`, `src/reviews/pubsub.service.ts`.
  See "Pub/Sub automation" under Current state, below. The Google Cloud side
  (creating a topic, an authenticated push subscription, and PATCHing
  `accounts/{id}/notificationSetting` to point at it) is still a manual step
  the human has to perform once real Google API access is granted — see
  README's Pub/Sub setup section.

## Phase 8 — Dashboard and Configuration

Complete:

* New Reviews dashboard
* approval UI
* Published view
* Settings
* business voice configuration
* auto-publishing configuration
* location-specific configuration

---

# README Requirements

Maintain a README throughout development.

The final README should explain:

* project purpose
* architecture
* prerequisites
* local installation
* environment variables
* Supabase setup
* Google Cloud project setup
* Google OAuth setup
* Google Business Profile API setup
* Pub/Sub setup
* OpenAI setup
* database migrations
* mock development mode
* running locally
* running tests
* production deployment considerations
* troubleshooting common authentication/API issues

Never place real secrets in the README.

---

# Definition of Done

The application is complete when:

* Google OAuth works.
* Google Business Profile accounts and locations can be retrieved.
* Google reviews can be retrieved.
* New reviews can trigger the processing workflow.
* AI responses reference meaningful details from individual reviews.
* AI responses do not invent customer experiences.
* Responses vary naturally.
* Responses are returned as validated structured data.
* Deterministic business rules control auto-publishing.
* Risky reviews are always routed for human approval.
* 1–3 star reviews cannot auto-publish.
* Approved responses can be published to Google.
* Duplicate events cannot accidentally produce duplicate responses.
* Existing Google replies are respected.
* Edited reviews are handled safely.
* Every review and response is stored.
* Important actions have an audit trail.
* Credentials are secured.
* External API failures are handled safely.
* Automated tests cover critical publishing protections.
* A development/mock mode works without Google publishing.
* The dashboard supports approval and configuration.
* Setup instructions are complete.

---

# Code Quality Requirements

Use:

* strict TypeScript
* strongly typed interfaces
* Zod validation
* async/await
* reusable services
* clear error handling
* descriptive naming
* modular files
* environment validation
* database migrations
* minimal duplication

Avoid:

* giant files
* unnecessary abstractions
* hard-coded credentials
* hard-coded business information
* unvalidated API responses
* business rules hidden inside AI prompts
* pseudocode when working code can be provided

When making an architectural decision, briefly explain why you chose it.

---

# Current state

Phases 1 through 8, including Phase 7's Pub/Sub half, are complete and
verified. Do not rebuild any of them.

* **Phase 1** — project structure, environment configuration, Supabase
  schema, Google OAuth, token storage, account and location retrieval,
  review retrieval, mock fixtures, and a working mock mode.
* **Phase 2** — OpenAI Responses API integration, structured-output schema,
  Zod validation, personalization logic.
* **Phase 3** — deterministic risk classification and the publishing-policy
  service (`src/policies/publishing-policy.ts`).
* **Phase 4** — review persistence, processing states, idempotent upserts,
  and audit logging.
* **Phase 5** — the approval workflow (approve, edit, regenerate, reject),
  plus a hardening pass on top of it, detailed below.
* **Phase 6** — publishing to Google (`src/reviews/publishing.service.ts`,
  `POST /api/reviews/[id]/publish`), detailed below.
* **Phase 7** — background sweep, the auto-publish trigger, and now the
  Pub/Sub notification webhook (`POST /api/pubsub/reviews`), detailed below.
  The Google Cloud side of Pub/Sub (creating the topic and push subscription)
  is still a manual, external step — see README.
* **Phase 8** — the dashboard (New Reviews queue, Published history,
  Settings) and the `business_settings` persistence layer behind it,
  detailed below.

**Standing product decision, on top of all of the above:** every review
requires human approval before publishing — there is no automatic publish
path in the shipped product. See "Product decision (2026-08-23): manual
approval for every review," below, for the `REQUIRE_APPROVAL_FOR_ALL` flag,
what it changed, and what it deliberately left alone.

Implement only the phase you are explicitly asked for, and stop at the
phase boundary.

## Phase 5 hardening (implemented)

After the initial approval workflow shipped, a hardening pass closed two
gaps: a regenerate could silently downgrade a review's human-review
requirement, and concurrent writes to the same review could clobber each
other without either caller knowing. Migration:
`supabase/migrations/0002_hardening.sql`.

### `human_review_required` vs `needs_human_review`

`needs_human_review` (boolean, nullable) is a **per-attempt signal**. Every
generation or regeneration overwrites it with whatever that single attempt's
model output plus deterministic keyword scan concluded
(`src/policies/evaluate-review.ts`). It is informational and can move in
either direction — a regenerate that gets a rosier model opinion the second
time around will happily set it back to `false`.

The publishing decision does not read that field directly, because a
rosier second opinion erasing a risk flag the first attempt raised — with
nobody having actually reviewed the review — is exactly the failure this
hardening pass closes. `human_review_required` (boolean, not null, default
`false`) is the **sticky gate** the publishing policy actually evaluates. It
is computed as `priorHumanReviewRequired OR thisAttempt.needsHumanReview` —
see `evaluateReviewForPublishing` in `src/policies/evaluate-review.ts` — so
it only ever moves `false -> true`. Once any attempt earns a review a human
review, no later regeneration can unset it. The migration backfills
`human_review_required = true` for every existing row where
`needs_human_review = true`, so already-flagged reviews don't lose their
flag on deploy.

### `POST /api/reviews/[id]/unapprove`

Reverses an `APPROVED` review back to `PENDING_APPROVAL`, clearing
`approved_by`/`approved_at`, so it re-enters the human queue for a fresh
sign-off (`src/app/api/reviews/[id]/unapprove/route.ts`,
`unapproveReview` in `src/reviews/approval.service.ts`). Body: optional
`{ actor?: string }`. It is only legal while the review has not yet
published — the repository's `markUnapproved` conditions its UPDATE on
`status = 'APPROVED' AND published_at IS NULL` in the same statement, not on
a status read moments earlier, so a review Phase 6 has already posted to
Google can never be walked back into the queue as if the reply never went
out. Records an `UNAPPROVED` audit event (added to `AUDIT_EVENTS` in
`src/types/review.ts`).

### `ConflictError` / 409 on status conflicts

Every approval-workflow write (`markApproved`, `markRejected`,
`updateFinalResponse`, `markUnapproved` in
`src/database/repositories/review.repository.ts`) conditions its `UPDATE` on
the row still being in an allowed status, in the same statement that makes
the change — `UPDATE ... WHERE id = $1 AND status IN (...)` — rather than on
a status the service layer read moments earlier. Two requests racing (a
double-submitted click, or an approve and a reject landing at the same
time) can both pass the service layer's application-level pre-check
(`assertStatus` in `src/reviews/approval.service.ts`), but only the first
writer's `WHERE` clause matches a row; the second gets zero rows back.
`throwOnZeroRowsOrError` turns that zero-row result into `ConflictError`
(`src/utils/errors.ts`), which `toHttpStatus` maps to a `409` response,
instead of the API silently reporting success for a write that never
happened.

## Phase 6 — publishing to Google

`publishReview` (`src/reviews/publishing.service.ts`) is the one function
that writes to a customer-visible Google surface. It accepts a review in
`APPROVED` status (a human signed off via Phase 5) or `GENERATED` status (the
deterministic publishing policy already decided `AUTO_PUBLISH` — see
`src/policies/publishing-policy.ts`); there is no separate "auto-publish"
code path, only two ways to arrive at the same eligible-to-publish function.
Exposed as `POST /api/reviews/[id]/publish`, same shape as approve/reject/
edit/regenerate.

### Re-checking state immediately before calling Google

A review can sit between "eligible" and "actually published" for an
arbitrary length of time — long enough for a human to unapprove it, or for
two publish requests to race. `publishReview` never acts on a status it (or
its caller) read a moment earlier. `claimReviewForPublishing`
(`src/database/repositories/review.repository.ts`) is a single
`UPDATE ... WHERE status IN (...) AND google_reply_state IN ('NONE',
'PUBLISH_FAILED') AND published_at IS NULL` that only succeeds if the row is
*still* eligible at the instant it runs, atomically, in the same statement —
the same idiom the Phase 5 hardening pass established for
`markApproved`/`markRejected`/`markUnapproved`, reused rather than
reinvented. The claim moves `google_reply_state` to `PUBLISH_PENDING`, which
is what stops `markUnapproved` from succeeding on a review a publish attempt
currently holds — `markUnapproved`'s guard was extended to exclude
`PUBLISH_PENDING` specifically for this (its `status`/`published_at` checks
alone were not enough, since both are still `APPROVED`/null while a publish
is in flight). An earlier plain read (`findReviewById`) still happens first,
but only to produce a friendlier `BadRequestError` on the common non-racy
case (a review that was simply never approved); the atomic claim is what
actually decides eligibility, and a race there surfaces as `ConflictError`
(409), not a silent publish.

### The existing-reply check is live, not from this database

Immediately after claiming a review, `publishReview` asks Google (via
`ReviewSource.getReview`) what the review's reply actually is *right now*,
before writing anything. It does not trust `google_reply_state` as already
recorded here — that can be stale, because `approveReview` (Phase 5) does not
itself check reply state (only the auto-publish policy does), and because a
human can reply to a review directly in Google's own UI at any time. If
Google's live reply exists and differs from what this function intends to
publish, it is left untouched and the review is routed back to
`PENDING_APPROVAL` (`markPublishBlockedByExistingReply`) instead of being
overwritten.

### If Google accepts the reply but the `published_at` write fails

This is not hypothetical: the Supabase write happens *after* the network
call to Google returns, so a crash or a transient database error in that
window leaves Google showing a reply the database does not know about.

The recovery relies on a property of Google's v4 reply endpoint
(`google/reviews.service.ts`): `updateReply` is a `PUT` to a single reply
resource per review, not a `POST` that appends. Calling it twice with the
same comment is a no-op the second time, not two replies. So:

1. `publishReview` wraps both the call to Google and the `markPublished`
   write in one `try`. If `markPublished` is the half that throws, the
   `catch` still runs and moves `google_reply_state` from `PUBLISH_PENDING`
   to `PUBLISH_FAILED` — `status` is never touched, so the review is
   immediately eligible for an ordinary retry, not a special "resume" path.
2. That retry re-claims the row and, before writing anything, reads Google's
   *actual* current reply.
3. If it already equals the response this function intended to publish, that
   is proof the earlier attempt's write to Google succeeded — `publishReview`
   records `published_at` and returns (`{ outcome: "published", recovered:
   true }`) without calling Google again. Otherwise, the earlier call is
   treated as never having happened and this function posts normally.

What this does **not** cover: if the process dies entirely — not a thrown
error, the whole runtime disappearing — between Google accepting the write
and the `catch` block running, the row is left stuck at `PUBLISH_PENDING`,
which is deliberately not itself claimable (only `NONE`/`PUBLISH_FAILED`
are), so the retry path above can't reach it on its own. Phase 6 does not add
a background sweep for that narrow window; a job that finds stale
`PUBLISH_PENDING` rows and force-reclaims them belongs with Phase 7's
"automatic processing workflow," which is the first place this codebase
gains any always-running background process at all.

### What Phase 6 deliberately does not do

Nothing here calls `publishReview` automatically when a review becomes
`GENERATED`. `src/reviews/processing.service.ts` (Phase 4, already verified)
is untouched, and there is still no code path anywhere that triggers
`processReview` on its own — reviews are processed by an explicit call today,
same as before this phase. Phase 6's job was to make publishing itself safe;
wiring a trigger that calls it automatically is explicitly Phase 7's
"automatic processing workflow." A `GENERATED` review is fully eligible to
publish the moment something calls `publishReview` for it — including a
human clicking a "publish now" action, or a script — it simply isn't called
for them yet without a human or a script doing so.

Live verification: `npx tsx scripts/verify-phase6-live.ts` (same shape as
`verify-phase5-live.ts`) exercises `POST /api/reviews/[id]/publish` against a
real Supabase database and a running dev server in `MOCK_MODE`, including the
concurrent-request race (one 200, one 409) and the existing-reply block,
using the mock fixtures' real review IDs so the mock `ReviewSource` resolves
against real fixture data (including `rev-012`, the one fixture that already
carries a reply).

### `published_by` (migration `0003_published_by.sql`)

A publish-time audit field, distinct from `approved_by`: `approved_by`
records who approved a review, which can happen long before (or without ever
leading to) an actual publish; `published_by` records who is responsible for
the reply that actually reached Google, set exactly once, at the moment
`finalizeClaimedPublish` (`src/reviews/publishing.service.ts`) writes it —
whether that write happens via an ordinary claim or via the stale-row sweep's
force-reclaim (both funnel through the same function, so both set it the same
way). Computed from `claimed.status`, not from the `actor` string passed into
`publishReview` (which is a caller label like `"system-sweep"`, not an
identity): `"APPROVED"` copies that row's own `approved_by` (falling back to
`"unknown"` if somehow absent), anything else — i.e. `"GENERATED"`, the
deterministic auto-publish path — records the literal string `"auto"`. With
`REQUIRE_APPROVAL_FOR_ALL` on by default (see the product decision below),
`"auto"` should not occur in practice today, but the field exists for the
setting it's off, or in case it audits a bug that means it wasn't.

## Phase 7 (code-only pass) — background sweep and auto-publish trigger

This pass implements only the two code-side gaps Phase 6 and the "Known
gaps" note above left open. It deliberately does **not** touch Pub/Sub, the
notification webhook, or any Google Cloud configuration — those remain a
separate pass, and there is still no actual scheduler wired up to call any
of this on a timer.

`src/reviews/sweep.service.ts` adds two independent passes, both callable
directly or together via `runBackgroundSweep()`:

* **`recoverStalePublishPendingReviews`** — closes the stuck-`PUBLISH_PENDING`
  gap. Finds rows whose `google_reply_state` has been `PUBLISH_PENDING` for
  longer than `olderThanMs` (default 5 minutes), force-reclaims each one
  atomically, and resolves it through `finalizeClaimedPublish` — the exact
  function `publishReview` (Phase 6) itself calls after its own claim
  succeeds, extracted from `publishing.service.ts` specifically so the sweep
  cannot drift from the crash-recovery logic already proven there (live
  Google check first, recover/publish/block from that).

  *Stuck vs. mid-flight:* a normal claim resolves within one Google HTTP
  round trip because any ordinary failure already hits `publishReview`'s own
  `catch` and demotes the row to `PUBLISH_FAILED`. A row still
  `PUBLISH_PENDING` past the staleness threshold means the process holding
  the claim died outright, not that it's merely slow — but "one round trip"
  is not the same as "seconds." `finalizeClaimedPublish` makes up to two
  sequential `googleRequest` calls (`getReview`, then `updateReply`), and
  each is individually bounded by `GOOGLE_API_MAX_ATTEMPTS *
  GOOGLE_API_TIMEOUT_MS` (every attempt is capped at the timeout via
  `AbortController`, and a timed-out attempt is itself retryable — see
  `isRetryable` in `src/utils/errors.ts`). At the env schema's defaults
  (20s × 4 attempts) that's ≈83.5s per call, ≈167s (2.8 min) for both; at the
  schema-allowed maximum (120s × 8 attempts, both valid operator responses to
  a slow Business Profile API) it's ≈2023s (33.7 min). A flat threshold that
  ignores this can misclassify a review that is still legitimately retrying
  as stuck. This used to be worse than a threshold-tuning problem: a 401
  mid-retry triggers `forceRefresh()` → `refreshAccessToken()` →
  `postToken()` in `src/auth/google-oauth.ts`, and `postToken` issued a raw
  `fetch` with no `AbortController` and no timeout at all — every other
  Google-bound fetch in this codebase goes through `googleRequest`, which
  does enforce one, but the OAuth token exchange/refresh path predated that
  and was never brought in line. A hang there was genuinely unbounded; no
  finite staleness threshold could have closed that gap. **Fixed**:
  `postToken` is now wrapped in the same `AbortController` /
  `GOOGLE_API_TIMEOUT_MS` pattern as `performRequest`
  (`src/google/client.ts`), so a hung token-endpoint connection now times out
  and retries like any other transient Google failure instead of hanging the
  caller forever.

  The default threshold (`defaultStalePublishPendingMs` in
  `sweep.service.ts`) is derived from that same retry budget, not a flat
  guess: `GOOGLE_API_MAX_ATTEMPTS * GOOGLE_API_TIMEOUT_MS * 2` (two
  sequential Google calls) plus a fixed 5-minute safety margin for the
  backoff sleeps between attempts, the Supabase round trips around the
  Google calls, and general scheduling jitter — none of which the
  multiplication alone accounts for. Raising `GOOGLE_API_TIMEOUT_MS` or
  `GOOGLE_API_MAX_ATTEMPTS` later automatically widens this threshold along
  with it, instead of silently invalidating a hardcoded number now that the
  token-refresh path is bounded too. The threshold is still a plain
  parameter (`findStalePublishPendingReviewIds`,
  `claimStalePublishPendingReview` in `review.repository.ts`) that a caller
  can override — `defaultStalePublishPendingMs()` only supplies what
  `recoverStalePublishPendingReviews` uses when a caller doesn't.
  `tests/sweep.service.test.ts` — "derives the default staleness threshold
  from the Google retry budget, not a flat guess" — asserts the formula
  directly against overridden `GOOGLE_API_TIMEOUT_MS`/`GOOGLE_API_MAX_ATTEMPTS`
  env values.

  *If the threshold is ever crossed by a genuinely in-flight call anyway* —
  a misconfigured override, or simply bad luck on timing — the sweep's
  force-reclaim doesn't stop the original caller: it's a bare `UPDATE` that
  bumps `updated_at`, not a signal. Both `finalizeClaimedPublish`
  executions then race to call `markPublished`/`markPublishFailed`. Google's
  reply endpoint is a PUT, so this can't produce a duplicate reply, but the
  loser's write no longer matches `WHERE google_reply_state =
  'PUBLISH_PENDING'` and throws `ConflictError`. `recoverStalePublishPendingReviews`
  catches that per-row (tallied as `skipped`) specifically so one review
  losing this race can't abort the rest of the sweep batch. Verified by
  `tests/sweep.service.test.ts`'s "catches a double-claim race" test, which
  was confirmed to fail without that `try`/`catch` (a plain uncaught
  `ConflictError` propagating out of `recoverStalePublishPendingReviews`)
  before the fix landed.

  *Two sweep runs claiming the same row:* `claimStalePublishPendingReview` is
  a single `UPDATE ... WHERE google_reply_state = 'PUBLISH_PENDING' AND
  updated_at < cutoff` — the same atomic-claim idiom `claimReviewForPublishing`
  (Phase 6) already established. The write sets `google_reply_state` back to
  the value it already had, which looks like a no-op but isn't: the
  `reviews_set_updated_at` trigger (`supabase/migrations/0001_init.sql`)
  fires on any `UPDATE` regardless of which columns changed, so the claim
  bumps `updated_at` to now. That bump is what a second, concurrent claim
  attempt's own `updated_at < cutoff` clause fails to match — under
  Postgres's read-committed semantics, an `UPDATE` re-checks its `WHERE`
  clause against each row's current values after acquiring that row's lock,
  so only the first of two racing claims can win. The loser gets zero rows
  back (`claimStalePublishPendingReview` returns `null`) and is silently
  skipped — not reported as a `ConflictError`, since a sweep losing this race
  is the expected case, not a caller-facing failure.

* **`publishEligibleGeneratedReviews`** — closes the auto-trigger gap
  ("What Phase 6 deliberately does not do," above). Finds `GENERATED`
  reviews (the deterministic policy already decided `AUTO_PUBLISH`) with no
  claim on them yet, and calls `publishReview` for each. `publishReview`'s
  own atomic claim is the real eligibility guard here too — a candidate this
  function selected that a human or another sweep tick claimed first just
  loses that race as an ordinary `ConflictError`, tallied as `skipped`
  without stopping the rest of the batch.

`scripts/run-sweep.ts` (`npm run sweep`) is one tick of `runBackgroundSweep`,
runnable by hand or by whatever scheduler gets set up later — that wiring
(a platform's scheduled-function feature, an OS cron entry, a scheduled CI
workflow) is exactly the infrastructure this pass was told not to set up.
`tests/sweep.service.test.ts` covers both passes, including the lost-claim-
race and already-resolved-candidate cases, with the repository and the live
Google check mocked the same way `tests/publishing.service.test.ts` mocks
them for `publishReview` itself.

## Pub/Sub automation (the rest of Phase 7)

`POST /api/pubsub/reviews` (`src/app/api/pubsub/reviews/route.ts`) is a Cloud
Pub/Sub push endpoint. `src/reviews/pubsub.service.ts` holds the actual
logic; the route is a thin wrapper around it, same split as every other
route in this codebase.

### Authentication is not the admin session

Every other route in this app is gated by `withAdmin`
(`src/app/api/_lib/handler.ts`), which checks the admin session cookie. A
Pub/Sub push request will never carry that cookie, so this route has its own
gate: `verifyPubSubPushToken` (`src/google/pubsub-auth.ts`) checks the
Google-signed OIDC JWT Pub/Sub puts in the request's `Authorization: Bearer`
header (`google-auth-library`'s `OAuth2Client.verifyIdToken`, Google's own
recommended approach), then additionally requires `email_verified: true` and
a `.iam.gserviceaccount.com` email — `verifyIdToken` alone checks the
signature, expiry, and audience, not that the token came from a service
account at all. `middleware.ts` allowlists `/api/pubsub/` so requests reach
the route without being redirected to `/login` first; the route's own OIDC
check is the actual authentication boundary. `PUBSUB_SKIP_VERIFICATION`
(`src/config/env.ts`, default `false`) bypasses this for local testing only —
there is no real Pub/Sub service to sign a token in mock mode — and the route
logs a warning on every request while it's true specifically so it can't be
left on silently.

### Status codes are Pub/Sub's retry signal, not decoration

Pub/Sub retries a push until it receives a 2xx. The route uses that
deliberately: a malformed message (bad base64, unparseable JSON, a shape
`pubSubPushEnvelopeSchema`/`googleNotificationSchema` reject) returns 200 —
acknowledged and dropped, because retrying garbage forever wastes nothing but
Pub/Sub's own effort, the same "do not retry permanently invalid requests
indefinitely" principle this codebase's Google/OpenAI retry logic already
follows. An auth failure returns 401 — not an ack, since the request wasn't
legitimately from Pub/Sub. A genuine processing failure (Google's API
unreachable, the database down) returns 500, letting Pub/Sub's own backoff
retry the same message later instead of losing it.

### The exact notification JSON shape is not fully documented by Google

Google's Business Profile notification reference (`NotificationSetting`,
`NotificationType`) confirms the enum values (`NEW_REVIEW`, `UPDATED_REVIEW`,
`GOOGLE_UPDATE`, etc.) and says a review notification carries a
`review_name`, but — as of when this was written — never publishes the
message body's actual JSON schema (checked directly against Google's current
reference docs, not assumed from memory, per CLAUDE.md's instruction not to
guess at Google API behavior). `src/schemas/pubsub.ts` reflects that
honestly: the Pub/Sub envelope itself (`message.data`/`messageId`/
`publishTime`) is stable, documented infrastructure and is validated
strictly; the inner notification is validated permissively
(`.passthrough()`, everything but nothing actually required) rather than
pretending a level of certainty about Google's exact field names that
doesn't exist yet.

`handleReviewNotification` (`pubsub.service.ts`) has two paths as a result:

* **Targeted fetch** — the notification's `reviewName` (or `review_name`)
  parses as `accounts/{a}/locations/{l}/reviews/{r}`, the same resource-name
  shape this codebase already uses everywhere (`buildReviewParent` in
  `google/reviews.service.ts`). One `getReview` call, one `ingestReview`
  call. If the fetch itself throws, the error is deliberately left uncaught
  so it propagates to the route as a 500 — a transient Google failure on one
  specific review should retry the whole message, not be silently absorbed.
* **Fallback resync** — the resource name doesn't parse (missing field, or a
  shape Google's docs didn't confirm). Every location this app has synced
  (`listSyncedLocations`, `review.repository.ts`) gets resynced instead of
  guessing. This is always *correct*, just less targeted:
  `ingestReview`'s own idempotency (its doc comment enumerates the three
  layers) makes resyncing an unaffected location's reviews a no-op, not a
  duplicate. Tightening this path to be as targeted as the first one needs
  real notification traffic to check field names against — the same external
  dependency (Google API approval) blocking everything else about running
  this against real reviews.

Both paths funnel through `ingestAndAutoProcess`, which — unlike the initial
Google fetch — catches its own failures per review and tallies them rather
than throwing, matching how `ingestReviews` (`ingest.service.ts`) already
treats a batch: one bad row shouldn't take the rest of a resync down with it.

### Automatic processing, but only for Pub/Sub

Per Phase 7's "automatic processing workflow": a review that `ingestReview`
leaves in `RECEIVED` (a genuinely new review, or an edit whose content
actually changed) is immediately run through `processReview` —
`resolveLocationConfig` (Phase 8's `settings.service.ts`) supplies real
business context and publishing settings, the same as the dashboard's manual
"Generate response" button does. This is deliberately scoped to the Pub/Sub
path only. The dashboard's own manual "Pull reviews" button (Phase 1,
unchanged) still only ingests — a human clicking that button hasn't asked
for every result to also be auto-drafted, and changing that button's
established behavior wasn't part of this pass. Auto-processing on arrival is
specifically the automation wiring up notifications is supposed to add.

### Closing a real gap found while building this

Auditing the existing pipeline before wiring the webhook surfaced that
**nothing in the app called `processReview` at all** before Phase 8 — see
Phase 8's own "closing a gap" note above (`POST /api/reviews/[id]/process`).
The Pub/Sub webhook is the second, and more important, caller of that same
function: it's what makes "automatic processing workflow" actually automatic
rather than requiring a human to notice a new review and click a button.

### Verifying this locally

There is no real Pub/Sub subscription to test against without live Google
API access. `scripts/simulate-pubsub-notification.ts`
(`npm run pubsub:simulate`) POSTs a fake push envelope — shaped exactly like
Pub/Sub's real one — at a running dev server, using the mock fixtures' real
account/location/review ids so it resolves against actual mock data. Run
against a dev server started with `PUBSUB_SKIP_VERIFICATION=true`. It
exercises, in order: an irrelevant notification type being acknowledged and
ignored, a targeted fetch creating and auto-processing a new review, the same
notification delivered again resolving to `unchanged` (duplicate-delivery
protection, proven the same way `ingestReview`'s own idempotency already is),
and the fallback resync path. Verified live against a real Supabase database
and the configured AI provider: a deleted fixture row, reintroduced through
the webhook, landed in `PENDING_APPROVAL` with a genuine, personalized AI
draft — not just ingested, but the full automatic pipeline in one shot.
`tests/pubsub.service.test.ts` and `tests/pubsub-auth.test.ts` cover the
same logic with mocked dependencies for fast, deterministic CI runs.

## Product decision (2026-08-23): manual approval for every review

This is a deliberate, standing product decision, not a temporary setting:
**every review requires a human's explicit approval before anything reaches
Google.** There is no automatic publish path in the shipped product. It does
not touch the still-outstanding Pub/Sub half of Phase 7 (the notification
webhook and its Google Cloud configuration remain a separate, deferred pass —
see "What Phase 7 (code-only pass) does not do" above); it only changes what
the deterministic policy is allowed to decide once a review does get
processed, by whatever eventually triggers that.

### `REQUIRE_APPROVAL_FOR_ALL` (`src/config/env.ts`, default `true`)

A product-level kill switch, independent of `business_settings` and
independent of the deterministic auto-publish machinery in
`src/policies/publishing-policy.ts`. It is implemented as a config flag
rather than by deleting or bypassing the auto-publish engine: `decidePublishing`
still contains every rule described earlier in this document (1-3 star never
auto-publishes, medium/high risk never auto-publishes, an existing reply
always blocks), and all of that is still exercised by its own tests. The flag
is simply one more mandatory reason `decidePublishing` checks before it will
ever return `AUTO_PUBLISH` — the same shape as the rating and risk checks
already there, not a special case bolted on top. Flipping it to `false` is
what reactivates the auto-publish path; nothing else needs to change to do
that.

`decidePublishing`'s own default when the field is omitted is `true` (fail
safe: a caller that forgets to pass it gets the stricter behavior, not the
looser one). `PublishingPolicyInput.requireApprovalForAll` and
`EvaluateReviewInput.requireApprovalForAll`
(`src/policies/evaluate-review.ts`) are plain pass-through fields — neither
file reads `getEnv()` itself, keeping both policy layers pure and testable
without env setup, consistent with `evaluate-review.ts`'s existing
"pure and side-effect-free on purpose" design. The one production caller,
`runReviewGeneration` (`src/reviews/processing.service.ts`), already reads
`getEnv()` for `OPENAI_MODEL`, so it is where the env value is actually read
and threaded in — both `processReview` and the regenerate path
(`regenerateReviewResponse` in `src/reviews/approval.service.ts`) share that
one function, so both go through the same gate.

When the flag is on, `decidePublishing`'s reasons array always includes
`manual_approval_required`, most-decisive-first, alongside whatever other
mandatory reasons apply (`rating_requires_approval`, `risk_high`,
`needs_human_review`, etc., when those also fire) — so the dashboard's "why
human approval is required" display doesn't lose the more specific reasons
just because the blanket one is also true.

### `publishEligibleGeneratedReviews` (`src/reviews/sweep.service.ts`)

With the flag on, no review can reach `GENERATED` status through the normal
generation pipeline any more (`runReviewGeneration` only sets that status
when the decision is `AUTO_PUBLISH`), so this function's candidate query
would come back empty on its own. It does not rely on that emergent
behavior, though: it checks `REQUIRE_APPROVAL_FOR_ALL` directly and returns
`{ scanned: 0, outcomes: {} }` before even querying the repository. This
matters for a scenario the emergent behavior alone doesn't cover — a
`GENERATED` row that predates this flag being turned on (leftover from
before this product decision, or written by a seed/test script) must not be
treated as still-eligible just because the row exists. It's the same
defense-in-depth instinct as `publishReview` re-checking Google's live reply
state instead of trusting a status read moments earlier, applied one layer
up.

**Is `publishEligibleGeneratedReviews` dead code now?** Not dead, but inert
under the shipped default. It still has a purpose: it's what makes flipping
`REQUIRE_APPROVAL_FOR_ALL` back to `false` a complete reversal rather than a
partial one, and it's still directly exercised by its own tests (including a
dedicated test that the guard short-circuits before querying at all). But in
the configuration this product actually ships with today, it is a guarded
no-op — nothing calls it that matters, because nothing it could find would
ever be eligible. `recoverStalePublishPendingReviews`, the sweep's other
pass, is unaffected and unchanged: it resolves publishes already in flight
(human-approved or otherwise), which is an orthogonal concern to whether new
auto-publish decisions are allowed.

## Phase 8 — dashboard and configuration

Two things shipped together: the `business_settings` persistence layer
(`src/database/repositories/settings.repository.ts`,
`src/reviews/settings.service.ts`) that every earlier phase's `BusinessContext`/
`PublishingSettings` types were already shaped for but nothing had ever
written to, and the dashboard UI that reads and writes it
(`src/app/console.tsx` plus `src/app/components/*`).

### Closing a gap the earlier phases left open: nothing ever called `processReview`

Auditing the phases before building the dashboard surfaced that no route
anywhere called `processReview` (`src/reviews/processing.service.ts`) — a
RECEIVED review had no path to becoming GENERATED/PENDING_APPROVAL except
through a test. The comment in `sync.service.ts` ("Generation (Phase 2) and
publishing (Phase 6) hook in later") described intent that was never wired
up. `POST /api/reviews/[id]/process` (`src/app/api/reviews/[id]/process/route.ts`)
closes it: the dashboard's "Generate response" action on a RECEIVED row calls
the same `processReview` function a future Pub/Sub webhook would call. It is
not a new pipeline — it is the missing trigger for the existing one.

The same audit found `edit` and `regenerate` always called their service
functions with `business: null` — meaning configured settings never actually
took effect even once Phase 8 existed. Both routes now look up the review's
location and call `resolveLocationConfig` (`settings.service.ts`) before
calling into `editReviewResponse`/`regenerateReviewResponse`, same as the new
`process` route.

### Dashboard shape

Four tabs sharing one status header and one notice line
(`src/app/console.tsx`): **New reviews** (the queue —
`ReviewQueuePanel.tsx`), **Published** (history — `PublishedPanel.tsx`),
**Settings** (`SettingsPanel.tsx`), and **Connection** (Phase 1's Google/
fixtures setup, unchanged, extracted into `ConnectionPanel.tsx`). Reviews and
Published both read one in-memory list fetched from the existing
`GET /api/google/reviews` — two filtered views of one dataset, not two
fetches, so a publish in one tab is immediately visible in the other.

"Approve & publish" is one dashboard action that calls the existing
`/approve` and `/publish` endpoints in sequence — there is no new combined
backend endpoint. If publish fails or is blocked after a successful approve,
the review is left `APPROVED` and the queue exposes a dedicated `Publish`
(retry) and `Unapprove` action for it, rather than hiding that state.

Settings is scoped to one location's `business_settings` row at a time
(`GET /api/settings` lists locations with their settings, `PUT
/api/settings/[locationId]` upserts one) — a multi-location business
configures each location independently, matching the schema's
`business_settings_location_unique` constraint.

`locations.auto_publish_enabled` (the per-location kill switch column from
the Phase 1 migration) is deliberately left unwired by this phase — the
Settings section of this spec maps to `business_settings` fields only,
and wiring an unused safety-relevant column into `decidePublishing` without
being asked is exactly the kind of scope creep CLAUDE.md's safety rules
argue against. It remains inert.

### A pre-existing migration drift, found and fixed while verifying this phase

Live-testing the dashboard (Approve & publish) surfaced a bug predating this
phase: publishing failed on every attempt with `Could not mark the review
published.` The root cause was schema drift, not application code —
`0002_hardening.sql`'s column existed in the live database but was never
recorded in `schema_migrations` (applied out-of-band at some point outside
`npm run db:migrate`), which made the tracked runner refuse to proceed, which
meant `0003_published_by.sql` (`published_by`, from the immediately preceding
commit) had never actually been applied. `markPublished`
(`review.repository.ts`) writes that column on every successful publish, so
every publish failed at the database layer. Fixed by reconciling
`schema_migrations` to match the database's actual state and then applying
the one genuinely missing column — `npm run db:migrate` now reports all
three migrations applied, and a full generate → approve → publish → Published
tab round trip was verified live against the real Supabase instance and the
configured AI provider.

### `human_review_required` — no longer load-bearing for gating, kept as an audit signal

Before this decision, `human_review_required` (the sticky, `false -> true`
only flag from the Phase 5 hardening pass — see above) was one of the inputs
`decidePublishing` needed to correctly decide `AUTO_PUBLISH` vs
`REQUIRE_APPROVAL`. It still feeds into that decision exactly as before
(`priorHumanReviewRequired` in `evaluate-review.ts`), but with
`REQUIRE_APPROVAL_FOR_ALL` defaulting to `true`, the decision no longer
depends on it: `manual_approval_required` alone is enough to force
`REQUIRE_APPROVAL` regardless of what `human_review_required` says.

It is kept, not removed, for two reasons. First, it remains genuinely
informative: it is the per-review signal for *why* a review needs a careful
human look, as opposed to merely needing the click-through every review now
requires — the dashboard can still use it (once Phase 8 builds the dashboard
surface for it) to distinguish "flagged risky, read this carefully" from
"routine 5-star, rubber-stamp is probably fine." Second, it stays load-bearing
the moment `REQUIRE_APPROVAL_FOR_ALL` is ever set back to `false` — removing
the column or its computation now would mean rebuilding it later just to
re-enable auto-publish safely. No schema or code change was made to it beyond
what already existed; this section only documents its changed role.
