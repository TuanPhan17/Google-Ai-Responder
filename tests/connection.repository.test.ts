import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";

/**
 * Fakes just enough of the Supabase query builder for
 * `.from("google_connections").upsert(row, { onConflict }).select("id").single()`.
 * Real Postgres semantics (FK enforcement, the id primary key, the not-null
 * constraint on refresh_token_encrypted) are covered by the migration and by
 * running the actual fixture endpoint — this test is about what the
 * repository sends, not the database engine.
 */
function createFakeDb() {
  const upserts: Array<{ row: Record<string, unknown>; onConflict: string }> = [];

  return {
    upserts,
    from(table: string) {
      if (table !== "google_connections") throw new Error(`unexpected table: ${table}`);
      return {
        upsert(row: Record<string, unknown>, options: { onConflict: string }) {
          upserts.push({ row, onConflict: options.onConflict });
          return {
            select: () => ({
              single: async () => ({ data: { id: row.id }, error: null }),
            }),
          };
        },
      };
    },
  };
}

let fakeDb: ReturnType<typeof createFakeDb>;

vi.mock("@/database/supabase", () => ({
  getDb: () => fakeDb,
}));

beforeEach(() => {
  fakeDb = createFakeDb();

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-placeholder-value";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.ADMIN_PASSWORD = "console-password-example";
  process.env.MOCK_MODE = "true";
  resetEnvCache();
});

describe("ensureMockConnection", () => {
  it("seeds the fixed mock connection id with a real encrypted refresh token", async () => {
    const { ensureMockConnection, MOCK_CONNECTION_ID } = await import(
      "@/database/repositories/connection.repository"
    );
    const { decryptSecret } = await import("@/auth/crypto");

    const id = await ensureMockConnection();
    expect(id).toBe(MOCK_CONNECTION_ID);

    const [call] = fakeDb.upserts;
    expect(call?.row.id).toBe(MOCK_CONNECTION_ID);
    expect(call?.row.slug).toBe("mock");
    expect(call?.onConflict).toBe("id");

    // Not a bypass: refresh_token_encrypted must survive a round trip, and
    // the raw value stored is never the plaintext.
    const encrypted = call?.row.refresh_token_encrypted as string;
    expect(encrypted).not.toBe("mock-mode-has-no-real-refresh-token");
    expect(decryptSecret(encrypted)).toBe("mock-mode-has-no-real-refresh-token");
  });

  it("is idempotent across repeated fixture runs", async () => {
    const { ensureMockConnection, MOCK_CONNECTION_ID } = await import(
      "@/database/repositories/connection.repository"
    );

    const first = await ensureMockConnection();
    const second = await ensureMockConnection();

    expect(first).toBe(MOCK_CONNECTION_ID);
    expect(second).toBe(MOCK_CONNECTION_ID);
    expect(fakeDb.upserts).toHaveLength(2);
    // Same conflict target both times — an upsert, never a bare insert that
    // would fail once the row already exists.
    expect(fakeDb.upserts.every((call) => call.onConflict === "id")).toBe(true);
  });
});
