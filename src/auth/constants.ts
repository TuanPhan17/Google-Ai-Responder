/**
 * Cookie names, isolated from any Node-only dependency.
 *
 * `middleware.ts` runs on the Edge runtime, where `node:crypto` cannot be
 * bundled. Importing these names from `session.ts` would drag the whole crypto
 * module into that bundle and fail the build — which is exactly what happened
 * the first time. Keeping the constants dependency-free is the fix.
 */
export const SESSION_COOKIE = "grr_session";
export const OAUTH_STATE_COOKIE = "grr_oauth_state";
