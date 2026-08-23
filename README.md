# Google Review Responder

Receives Google Business Profile reviews, generates a personalized reply, and
either publishes it or routes it to a human — with the publish/hold decision
made by deterministic application code, never by the model.

**Status: Phase 4 complete.** Foundation, Google OAuth, account/location/review
retrieval, mock fixtures, a reusable AI review-response service with
structured-output validation, the deterministic risk classification +
publishing-policy service, and the processing pipeline that drives a stored
review from `RECEIVED` through generation to `GENERATED`/`PENDING_APPROVAL`/
`FAILED` — with AI output persisted, every step audited, and a fourth
idempotency layer so a review is never regenerated once it has one. No
approval UI yet (Phase 5) and no writes to Google yet (Phase 6).

---

## How it works

```
Pub/Sub notification  ──►  fetch full review from Google  ──►  normalize
                                                                   │
                                                                   ▼
        publish  ◄──  publishing policy  ◄──  Zod validate  ◄──  OpenAI
        or hold        (deterministic)                          (advisory)
```

The model returns `needsHumanReview` and `riskLevel`, but they are inputs to the
policy, not the decision. 1–3 star reviews and anything above low risk always
route to a human, regardless of what the model says.

### Source layout

| Path | Responsibility |
|---|---|
| `src/config` | Zod-validated env, Google endpoint constants |
| `src/auth` | OAuth flow, token encryption, access-token refresh, admin session |
| `src/google` | The single authorized HTTP path + accounts/locations/reviews |
| `src/reviews` | Mapper, idempotent ingest, generation/processing pipeline, sync orchestration, source seam |
| `src/openai` | The single authorized HTTP path to OpenAI + review-response service + prompt |
| `src/policies` | Deterministic risk classification + the publishing-policy service |
| `src/database` | Supabase client and repositories |
| `src/schemas` | Zod schemas for every external response |
| `src/mocks` | 14 fixtures in Google's wire format |
| `src/utils` | Redacting logger, retry with jitter, error taxonomy |
| `supabase/migrations` | Forward-only SQL |

---

## Prerequisites

- Node.js 20.11+
- A Supabase project (free tier is fine)
- A Google Cloud project — **only when you want live data**; mock mode needs none

## Install

```bash
npm install
cp .env.example .env.local
npm run keys:generate      # prints TOKEN_ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD
```

Paste those three into `.env.local`, add your Supabase URL, service-role key and
`SUPABASE_DB_URL`, then:

```bash
npm run db:migrate
npm run dev
```

Open http://localhost:3000, sign in with `ADMIN_PASSWORD`, and click
**Run all fixtures**. Fourteen reviews land in the database. Click it a second
time — the counts shift to "deduplicated", which is the idempotency layer
working.

`MOCK_MODE=true` is the default and nothing reaches Google.

---

## Supabase setup

1. Create a project. Note the region — put it near you, not near Google.
2. **Project settings → API**: copy `SUPABASE_URL` and the **service_role** key.
   The service-role key bypasses Row Level Security. Server-side only; never in
   a `NEXT_PUBLIC_` variable.
3. **Project settings → Database → Connection string (URI)**: copy to
   `SUPABASE_DB_URL`. Used only by the migration runner.
4. `npm run db:migrate`

Every table has RLS enabled with **no policies**. The service-role key bypasses
it; an anon key does not. If an anon key ever leaks into a browser bundle, it
reads nothing.

---

## Google Cloud setup

Do this early — the approval step is the long pole.

### 1. Enable the APIs

Cloud Console → APIs & Services → Library:

- **My Business Account Management API**
- **My Business Business Information API**
- **Google My Business API** ← this is the v4 host that serves reviews
- **My Business Notifications API** (needed in Phase 7)

### 2. Request Business Profile API access

Enabling the APIs is not enough — quota stays at **0** until Google approves the
project. Submit the Business Profile API access request form. Stated turnaround
is 7–10 business days; longer happens.

Keep the request modest and concrete. "I want to automate review responses for
my own business" is a stronger application than a platform pitch.

Work in mock mode meanwhile. Nothing about the pipeline requires live data.

### 3. OAuth client

APIs & Services → Credentials → Create credentials → OAuth client ID → **Web
application**.

Authorized redirect URI — must match `.env.local` exactly, including the port:

```
http://localhost:3000/api/auth/google/callback
```

Copy the client ID and secret into `.env.local`, set `MOCK_MODE=false`, restart,
and click **Connect Google**.

Scope requested: `https://www.googleapis.com/auth/business.manage` (plus
`openid`/`email`, used only to label which account is connected).

### 4. Pub/Sub — Phase 7, not yet

For reference: create a topic, then grant
`mybusiness-api-pubsub@system.gserviceaccount.com` the Publish role on it, then
PATCH `accounts/{id}/notificationSetting` with the topic and
`notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"]`. One setting and one topic
per account.

---

## OpenAI setup

1. [platform.openai.com](https://platform.openai.com) → API keys → create a key.
   Paste it into `OPENAI_API_KEY`.
2. That's it to run the service directly — `OPENAI_MODEL` defaults to
   `gpt-4o-mini`, and `OPENAI_API_TIMEOUT_MS`/`OPENAI_API_MAX_ATTEMPTS` have
   working defaults.

This key is **not gated by `MOCK_MODE`** — mock mode only stands in for the
Google Business Profile source. Everything else (fixtures, ingest, the
dashboard once it exists) works with no OpenAI key set; you only need one to
actually call `generateReviewResponse` (directly, or from a script/test you
write against it — Phase 3 wires it into the ingest pipeline).

The service uses the [Responses API](https://platform.openai.com/docs/api-reference/responses)
with Structured Outputs (`strict: true`) constraining the model to the exact
shape in `src/schemas/openai.ts`. That JSON Schema is hand-kept in sync with
the Zod schema next to it, which still runs on top — strict mode guarantees
shape, not that `sentiment` is one we actually asked for versus, say, a model
that ignores the constraint entirely on some future API change.

---

## Environment variables

See `.env.example` for the annotated list. The ones that bite:

| Variable | Note |
|---|---|
| `MOCK_MODE` | `true` makes Google credentials optional. Default. |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes base64. **Rotating it makes stored refresh tokens unreadable** — you must reconnect Google. |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. Server-side only. |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must byte-match Cloud Console. |
| `OPENAI_API_KEY` | Not gated by `MOCK_MODE`. Only needed to actually generate a response. |

---

## Testing

```bash
npm test           # vitest
npm run typecheck  # tsc --noEmit, strict
```

Phase 1 covers the mapper (star-only reviews, anonymous reviewers, name
extraction), fixture/schema integrity, token encryption including tamper
detection, retry classification, and log redaction.

The retry tests assert that 400 and 403 are **not** retried — an invalid request
stays invalid, and missing API access will not fix itself by trying harder.

Phase 2 covers the review-response structured-output schema (accepts the
documented shape, rejects bad enums/ratings/missing fields), prompt
construction (star-only reviews are flagged as having no text rather than
described, business context is only included when supplied, never fabricated),
and the OpenAI client (bearer auth, retries a 429 but not a 400, retries a
schema-validation failure up to the attempt limit, and does not retry a
model refusal). All of it runs against a mocked `fetch` — no `OPENAI_API_KEY`
or network access is required to run the test suite.

Phase 3 covers the two non-negotiable safety invariants directly: a
combinatorial test fuzzes every rating/risk/human-review/settings combination
to prove a 1-, 2-, or 3-star review can never auto-publish and a medium/high
risk review can never auto-publish even at 5 stars — including against a
deliberately over-permissive settings object, to prove business configuration
can't relax either rule. A separate test proves an existing Google reply
blocks publishing regardless of every other input. The risk-classifier tests
prove the deterministic keyword scan escalates risk the model missed (e.g. a
review mentioning a lawyer that the model scored "low") and never downgrades a
risk level the model already assigned.

Phase 4 covers the processing pipeline end to end (mocking the AI client and
repository, not a live database): a clean 5-star only auto-publishes when the
caller explicitly supplies permissive settings, and — importantly — with no
settings supplied at all (today's actual wiring, since Settings/Phase 8 isn't
built) even a spotless 5-star lands in `PENDING_APPROVAL`, proving the system
fails closed by default rather than auto-publishing by accident. Further tests
prove risk escalation survives the full round trip into the persisted row, an
existing Google reply still blocks regardless of settings, a review already
past `RECEIVED` is skipped without ever calling the AI service (idempotency),
and a generation failure lands the row in `FAILED` with the error recorded
rather than left stuck mid-pipeline.

---

## Idempotency

Pub/Sub is at-least-once. Duplicate delivery is the normal case, not an error
case. Three overlapping layers:

1. **`UNIQUE (location_id, google_review_id)`** — the real guarantee. Application
   checks can be raced; a unique index cannot.
2. **Content comparison** — a duplicate carries an identical `updateTime`, so it
   resolves to `unchanged` and performs no writes at all. No status reset, no
   re-entry into generation.
3. **Reply-state tracking** — publishing keys off `google_reply_state`, so a
   review already answered is not a candidate even if an event replays.

Ordering matters: the content check runs *before* any status change, so a
redelivery cannot walk a review backwards through the state machine.

---

## Troubleshooting

**403 on any Google call.** Almost always API access approval, not code. Check
quota in Cloud Console — if it reads 0, you are still waiting.

**400 on `accounts.locations.list`.** `readMask` is required on that endpoint.
Handled in `LOCATION_READ_MASK`; if you added a field name that does not exist,
you get the same 400.

**"Google did not return a refresh token."** Google issues one on first
authorization only. Remove the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and
connect again.

**"That sign-in link did not match this browser session."** OAuth state expired
(10 minutes) or you started the flow in a different browser. Start again.

**Reviews return 404 with valid IDs.** Check the path shape — Reviews v4 wants
`accounts/{a}/locations/{l}/reviews/{r}`, while Business Information returns
locations as `locations/{l}`. The two APIs genuinely disagree.

**429.** Business Profile quota is low by default. The client backs off with
full jitter; if it persists, request an increase.

---

## Production notes

- Set `MOCK_MODE=false` and `NODE_ENV=production`. Session cookies become
  `secure` automatically.
- Replace the shared-password console gate (Phase 8) before exposing this
  publicly. It is adequate for a single operator on localhost, not for a team.
- `TOKEN_ENCRYPTION_KEY` belongs in a secret manager, not a deploy env var, once
  you have one.
- The in-process single-flight token refresh assumes one instance. Multiple
  instances refreshing concurrently is safe but wasteful; revisit if you scale
  horizontally.
