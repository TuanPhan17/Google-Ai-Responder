/**
 * Google Business Profile endpoint constants.
 *
 * Google split the old monolithic "Google My Business API v4.9" into a
 * federated set of APIs, each with its own base URL. Reviews were never
 * migrated — they are still served from the legacy mybusiness.googleapis.com/v4
 * host, which remains live. Everything else we need has a v1 replacement.
 *
 * Verified against Google's reference docs (Aug 2026). Keeping the hosts in one
 * file means a future migration is a single-file change.
 */

export const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Accounts: mybusinessaccountmanagement.googleapis.com/v1 */
export const ACCOUNT_MANAGEMENT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";

/** Locations: mybusinessbusinessinformation.googleapis.com/v1 (readMask required) */
export const BUSINESS_INFORMATION_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";

/** Reviews + review replies: still only available on the legacy v4 host. */
export const LEGACY_MY_BUSINESS_BASE = "https://mybusiness.googleapis.com/v4";

/** Pub/Sub notification settings — PATCH accounts/{id}/notificationSetting. */
export const NOTIFICATIONS_BASE = "https://mybusinessnotifications.googleapis.com/v1";

/**
 * One scope covers every Business Profile host above. `openid` + `email` are
 * requested only so the console can display which Google account is connected;
 * we store the email address and discard the ID token.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
  "openid",
  "email",
] as const;

/**
 * Fields requested from accounts.locations.list. readMask is *required* on this
 * endpoint — omitting it is a 400, which is the single most common first-run
 * error. Keep this list minimal: we only need enough to label a location.
 */
export const LOCATION_READ_MASK = [
  "name",
  "title",
  "storeCode",
  "storefrontAddress",
  "websiteUri",
  "metadata",
].join(",");

export const GOOGLE_MAX_PAGE_SIZE = 100;
