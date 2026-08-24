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

Phases 1 through 5 are complete and verified. Do not rebuild any of them.

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
