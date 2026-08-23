import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getEnv } from "@/config/env";

/**
 * Server-side Supabase client using the service-role key.
 *
 * The service-role key bypasses Row Level Security, so this module must never
 * be reachable from client code. The window guard makes that a loud failure
 * rather than a silent secret leak into a browser bundle.
 */
if (typeof window !== "undefined") {
  throw new Error("src/database/supabase.ts uses the service-role key and must stay on the server.");
}

let client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (client) return client;

  const env = getEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // No user sessions here — this is a trusted backend caller.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { "x-application-name": "google-review-responder" },
    },
  });

  return client;
}

/** Postgres unique-violation. Surfaces as a duplicate-key collision. */
export const PG_UNIQUE_VIOLATION = "23505";

/** Supabase returns this when `.single()` matches no rows. */
export const PG_NO_ROWS = "PGRST116";
