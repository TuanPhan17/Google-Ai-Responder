-- =============================================================================
-- 0001_init.sql — schema foundation
--
-- Design notes:
--
--  * Postgres enums (not TEXT + CHECK) for status columns. A typo in a status
--    string is the kind of bug that quietly disables a safety rule; an enum
--    makes it a write-time error instead.
--
--  * The reviews table carries the AI columns from day one even though Phase 1
--    never writes them. Adding nullable columns later is cheap, but shipping a
--    half-table means every downstream migration has to re-derive constraints.
--
--  * UNIQUE (location_id, google_review_id) is the load-bearing idempotency
--    guarantee. Pub/Sub delivers at-least-once, so duplicate processing is
--    normal, not exceptional. The constraint makes a duplicate an UPSERT rather
--    than a second row — and a second row is what would eventually become a
--    second reply to the same customer.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type review_status as enum (
  'RECEIVED',
  'PROCESSING',
  'GENERATED',
  'PENDING_APPROVAL',
  'APPROVED',
  'PUBLISHED',
  'REJECTED',
  'FAILED'
);

create type review_sentiment as enum ('positive', 'mixed', 'negative');

create type risk_level as enum ('low', 'medium', 'high');

create type publish_decision as enum ('AUTO_PUBLISH', 'REQUIRE_APPROVAL', 'BLOCKED');

create type google_reply_state as enum (
  'NONE',
  'EXISTING_REPLY_FOUND',
  'PUBLISH_PENDING',
  'PUBLISHED',
  'PUBLISH_FAILED'
);

create type connection_status as enum ('ACTIVE', 'REVOKED', 'ERROR');

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- google_connections — one row per connected Google login
--
-- The refresh token is stored encrypted (AES-256-GCM, application key). The
-- column is named *_encrypted so that a plaintext write is visibly wrong in
-- code review.
-- ---------------------------------------------------------------------------

create table google_connections (
  id                        uuid primary key default gen_random_uuid(),

  -- Single-tenant for now: exactly one connection, keyed by this slug. Phase 8
  -- can relax the unique constraint to support multiple businesses.
  slug                      text not null default 'default',

  google_email              text,
  refresh_token_encrypted   text not null,
  access_token_encrypted    text,
  access_token_expires_at   timestamptz,
  scope                     text,
  status                    connection_status not null default 'ACTIVE',
  last_error                text,
  last_refreshed_at         timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint google_connections_slug_key unique (slug)
);

create trigger google_connections_set_updated_at
  before update on google_connections
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- google_accounts / locations — cached copies of Google's org structure
--
-- Cached rather than fetched per request because the Reviews API has a low
-- default quota, and re-listing accounts on every page load would spend it on
-- data that changes maybe once a year.
-- ---------------------------------------------------------------------------

create table google_accounts (
  id                  uuid primary key default gen_random_uuid(),
  connection_id       uuid not null references google_connections (id) on delete cascade,

  google_account_id   text not null,           -- the {accountId} segment
  resource_name       text not null,           -- accounts/{accountId}
  account_name        text,
  account_type        text,
  verification_state  text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint google_accounts_unique unique (connection_id, google_account_id)
);

create trigger google_accounts_set_updated_at
  before update on google_accounts
  for each row execute function set_updated_at();

create table locations (
  id                  uuid primary key default gen_random_uuid(),
  google_account_id   uuid not null references google_accounts (id) on delete cascade,

  google_location_id  text not null,           -- the {locationId} segment
  resource_name       text not null,           -- locations/{locationId}
  title               text,
  store_code          text,
  address             text,
  website_uri         text,
  maps_uri            text,
  place_id            text,

  -- Per-location kill switch. Auto-publishing is opt-in: a location that has
  -- never been reviewed by a human cannot start replying on its own.
  auto_publish_enabled boolean not null default false,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint locations_unique unique (google_account_id, google_location_id)
);

create trigger locations_set_updated_at
  before update on locations
  for each row execute function set_updated_at();

create index locations_account_idx on locations (google_account_id);

-- ---------------------------------------------------------------------------
-- reviews
-- ---------------------------------------------------------------------------

create table reviews (
  id                        uuid primary key default gen_random_uuid(),
  location_id               uuid not null references locations (id) on delete cascade,

  -- Identity as Google sees it. Denormalized alongside location_id so a review
  -- can be traced back to Google without a join, and so the v4 reply URL can be
  -- rebuilt from a single row.
  google_review_id          text not null,
  google_review_name        text,
  google_account_id         text not null,
  google_location_id        text not null,
  location_title            text,

  -- Reviewer. We store the display name Google gives us and nothing else — no
  -- profile photo, no inferred attributes.
  reviewer_name             text,
  reviewer_is_anonymous     boolean not null default false,

  rating                    smallint,
  review_text               text,
  review_created_at         timestamptz not null,
  review_updated_at         timestamptz not null,
  is_edited                 boolean not null default false,
  edit_count                integer not null default 0,

  -- AI output. Unused until Phase 2.
  ai_response               text,
  final_response            text,
  sentiment                 review_sentiment,
  risk_level                risk_level,
  needs_human_review        boolean,
  ai_reason                 text,
  referenced_details        text[] not null default '{}',
  ai_model                  text,

  -- Publishing. `publish_decision` records what the deterministic policy
  -- concluded, separately from the model's opinion, so the two can be audited
  -- against each other.
  status                    review_status not null default 'RECEIVED',
  publish_decision          publish_decision,
  publish_decision_reason   text,
  google_reply_state        google_reply_state not null default 'NONE',
  existing_google_reply     text,
  existing_reply_updated_at timestamptz,

  processing_attempts       integer not null default 0,
  last_error                text,

  approved_by               text,
  approved_at               timestamptz,
  published_at              timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- Google ratings are 1-5; null means STAR_RATING_UNSPECIFIED.
  constraint reviews_rating_range check (rating is null or (rating between 1 and 5)),

  -- The idempotency key. See header note.
  constraint reviews_google_identity_unique unique (location_id, google_review_id)
);

create trigger reviews_set_updated_at
  before update on reviews
  for each row execute function set_updated_at();

-- Dashboard queries: "what needs a human, newest first".
create index reviews_status_created_idx on reviews (status, review_created_at desc);
create index reviews_location_idx on reviews (location_id, review_created_at desc);
-- Lookup path used by the Pub/Sub handler, which knows Google's IDs only.
create index reviews_google_lookup_idx on reviews (google_location_id, google_review_id);

-- ---------------------------------------------------------------------------
-- review_revisions — history of what the customer wrote
--
-- Kept separate from reviews so the live row stays small and the history is
-- append-only. When a customer edits a review, the previous text lands here
-- before it is overwritten.
-- ---------------------------------------------------------------------------

create table review_revisions (
  id                  uuid primary key default gen_random_uuid(),
  review_id           uuid not null references reviews (id) on delete cascade,

  rating              smallint,
  review_text         text,
  review_updated_at   timestamptz not null,
  captured_at         timestamptz not null default now(),

  constraint review_revisions_rating_range check (rating is null or (rating between 1 and 5))
);

create index review_revisions_review_idx on review_revisions (review_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- review_events — append-only audit trail
--
-- Deliberately not an enum: audit event names will grow with every phase, and
-- an ALTER TYPE per phase is friction that discourages logging. The set of
-- valid names lives in src/types/review.ts.
-- ---------------------------------------------------------------------------

create table review_events (
  id            uuid primary key default gen_random_uuid(),
  review_id     uuid references reviews (id) on delete cascade,

  event         text not null,
  actor         text not null default 'system',   -- 'system' | 'google' | an admin identifier
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index review_events_review_idx on review_events (review_id, created_at desc);
create index review_events_event_idx on review_events (event, created_at desc);

-- ---------------------------------------------------------------------------
-- business_settings — the *verified* context the AI is allowed to use
--
-- Populated in Phase 8, read by Phase 2. Everything here is business-supplied
-- fact. Nothing outside this table is ever presented to the model as truth
-- about the business, which is how "never invent details" is enforced
-- structurally rather than by asking the model nicely.
-- ---------------------------------------------------------------------------

create table business_settings (
  id                          uuid primary key default gen_random_uuid(),
  location_id                 uuid references locations (id) on delete cascade,

  business_name               text,
  business_description        text,
  brand_voice                 text,
  preferred_tone              text,
  max_response_chars          integer not null default 600,

  contact_phone               text,
  contact_email               text,
  escalation_instructions     text,
  phrases_to_avoid            text[] not null default '{}',
  approved_policies           text[] not null default '{}',
  location_notes              text,

  auto_publish_five_star      boolean not null default false,
  auto_publish_four_star      boolean not null default false,
  -- Ratings at or below this value always require a human. The check clamps it
  -- to 3, so no configuration can ever let a 3-star review auto-publish.
  min_auto_publish_rating     smallint not null default 4,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint business_settings_location_unique unique (location_id),
  constraint business_settings_max_len check (max_response_chars between 120 and 2000),
  constraint business_settings_min_rating check (min_auto_publish_rating between 4 and 5)
);

create trigger business_settings_set_updated_at
  before update on business_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- RLS is enabled with *no* policies on every table. The service-role key used
-- by the Next.js server bypasses RLS; anon/authenticated keys do not. So if a
-- Supabase anon key is ever exposed in a browser bundle, it reads nothing.
-- This is fail-closed by construction rather than by remembering to add a
-- policy later.
-- ---------------------------------------------------------------------------

alter table google_connections enable row level security;
alter table google_accounts    enable row level security;
alter table locations          enable row level security;
alter table reviews            enable row level security;
alter table review_revisions   enable row level security;
alter table review_events      enable row level security;
alter table business_settings  enable row level security;
