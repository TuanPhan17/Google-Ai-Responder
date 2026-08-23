import { getDb } from "@/database/supabase";
import { encryptSecret, decryptSecret } from "@/auth/crypto";
import { DatabaseError } from "@/utils/errors";

/**
 * Storage for the Google OAuth connection.
 *
 * Encryption and decryption happen inside this module, not at call sites.
 * Callers deal in plaintext tokens and never touch a `*_encrypted` column, so
 * there is no route by which a plaintext token reaches the database.
 */

const DEFAULT_SLUG = "default";

/**
 * Fixed identity for the mock-mode stand-in connection. Mock mode still runs
 * data through the real google_accounts/locations tables, and connection_id
 * is a hard FK into google_connections — so this row has to actually exist,
 * not just be referenced.
 */
export const MOCK_CONNECTION_ID = "00000000-0000-4000-8000-000000000000";
const MOCK_CONNECTION_SLUG = "mock";

export type ConnectionStatus = "ACTIVE" | "REVOKED" | "ERROR";

export interface StoredConnection {
  id: string;
  googleEmail: string | null;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
  status: ConnectionStatus;
  lastError: string | null;
}

/** Safe to send to the browser: identifies the connection, reveals no credential. */
export interface ConnectionSummary {
  connected: boolean;
  googleEmail: string | null;
  status: ConnectionStatus | null;
  scope: string | null;
  lastError: string | null;
  connectedAt: string | null;
}

interface ConnectionRow {
  id: string;
  slug: string;
  google_email: string | null;
  refresh_token_encrypted: string;
  access_token_encrypted: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
  status: ConnectionStatus;
  last_error: string | null;
  created_at: string;
}

async function findRow(slug = DEFAULT_SLUG): Promise<ConnectionRow | null> {
  const { data, error } = await getDb()
    .from("google_connections")
    .select("*")
    .eq("slug", slug)
    .maybeSingle<ConnectionRow>();

  if (error) throw new DatabaseError("Could not read the Google connection.", { slug }, error);
  return data;
}

export async function getConnection(slug = DEFAULT_SLUG): Promise<StoredConnection | null> {
  const row = await findRow(slug);
  if (!row) return null;

  return {
    id: row.id,
    googleEmail: row.google_email,
    refreshToken: decryptSecret(row.refresh_token_encrypted),
    accessToken: row.access_token_encrypted ? decryptSecret(row.access_token_encrypted) : null,
    accessTokenExpiresAt: row.access_token_expires_at ? new Date(row.access_token_expires_at) : null,
    scope: row.scope,
    status: row.status,
    lastError: row.last_error,
  };
}

export async function getConnectionSummary(slug = DEFAULT_SLUG): Promise<ConnectionSummary> {
  const row = await findRow(slug);
  if (!row) {
    return { connected: false, googleEmail: null, status: null, scope: null, lastError: null, connectedAt: null };
  }

  return {
    connected: row.status === "ACTIVE",
    googleEmail: row.google_email,
    status: row.status,
    scope: row.scope,
    lastError: row.last_error,
    connectedAt: row.created_at,
  };
}

export interface SaveConnectionInput {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scope: string | null;
  googleEmail: string | null;
}

/**
 * Called once at the end of the OAuth callback. Upserts on `slug`, so
 * re-authorizing replaces the credential instead of accumulating rows.
 */
export async function saveConnection(
  input: SaveConnectionInput,
  slug = DEFAULT_SLUG,
): Promise<StoredConnection> {
  const { data, error } = await getDb()
    .from("google_connections")
    .upsert(
      {
        slug,
        google_email: input.googleEmail,
        refresh_token_encrypted: encryptSecret(input.refreshToken),
        access_token_encrypted: encryptSecret(input.accessToken),
        access_token_expires_at: input.accessTokenExpiresAt.toISOString(),
        scope: input.scope,
        status: "ACTIVE" satisfies ConnectionStatus,
        last_error: null,
        last_refreshed_at: new Date().toISOString(),
      },
      { onConflict: "slug" },
    )
    .select("*")
    .single<ConnectionRow>();

  if (error || !data) {
    throw new DatabaseError("Could not save the Google connection.", { slug }, error);
  }

  return {
    id: data.id,
    googleEmail: data.google_email,
    refreshToken: input.refreshToken,
    accessToken: input.accessToken,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    scope: data.scope,
    status: data.status,
    lastError: null,
  };
}

/**
 * Called after a successful refresh. Google does not return a new refresh
 * token on refresh, so this updates the access token only and leaves the
 * long-lived credential untouched.
 */
export async function updateAccessToken(
  connectionId: string,
  accessToken: string,
  expiresAt: Date,
): Promise<void> {
  const { error } = await getDb()
    .from("google_connections")
    .update({
      access_token_encrypted: encryptSecret(accessToken),
      access_token_expires_at: expiresAt.toISOString(),
      last_refreshed_at: new Date().toISOString(),
      status: "ACTIVE" satisfies ConnectionStatus,
      last_error: null,
    })
    .eq("id", connectionId);

  if (error) throw new DatabaseError("Could not store the refreshed access token.", { connectionId }, error);
}

/**
 * Records that the credential is unusable. The row is kept rather than deleted
 * so the console can explain *why* Google stopped working — a deleted row just
 * looks like "never connected".
 */
export async function markConnectionFailed(
  connectionId: string,
  status: Extract<ConnectionStatus, "REVOKED" | "ERROR">,
  reason: string,
): Promise<void> {
  const { error } = await getDb()
    .from("google_connections")
    .update({ status, last_error: reason.slice(0, 500), access_token_encrypted: null, access_token_expires_at: null })
    .eq("id", connectionId);

  if (error) throw new DatabaseError("Could not mark the connection as failed.", { connectionId }, error);
}

export async function deleteConnection(slug = DEFAULT_SLUG): Promise<void> {
  const { error } = await getDb().from("google_connections").delete().eq("slug", slug);
  if (error) throw new DatabaseError("Could not remove the Google connection.", { slug }, error);
}

/**
 * Seeds the placeholder connection row mock mode points its foreign keys at.
 *
 * Upserts on `id` rather than checking-then-inserting, so this is safe to call
 * on every fixture run without a race between the check and the insert.
 * refresh_token_encrypted is `not null`, and there is no real Google refresh
 * token in mock mode, so a dummy value is encrypted the same way a real one
 * would be rather than bypassing the column.
 */
export async function ensureMockConnection(): Promise<string> {
  const { data, error } = await getDb()
    .from("google_connections")
    .upsert(
      {
        id: MOCK_CONNECTION_ID,
        slug: MOCK_CONNECTION_SLUG,
        refresh_token_encrypted: encryptSecret("mock-mode-has-no-real-refresh-token"),
        status: "ACTIVE" satisfies ConnectionStatus,
      },
      { onConflict: "id" },
    )
    .select("id")
    .single<{ id: string }>();

  if (error || !data) {
    throw new DatabaseError("Could not seed the mock Google connection.", {}, error);
  }
  return data.id;
}
