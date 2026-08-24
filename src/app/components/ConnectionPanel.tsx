"use client";

import { useState } from "react";

import { call, type Notice, type ReviewItem } from "@/app/components/api-client";

/**
 * The Phase 1 setup panel — connect Google, sync accounts/locations, pull
 * reviews, run the mock fixtures. Unchanged in behavior from the original
 * Phase 1 console; extracted into its own component so the Phase 8 tabs
 * (Reviews, Published, Settings) don't have to share one 400-line file with
 * it.
 */

interface ConnectionSummary {
  connected: boolean;
  googleEmail: string | null;
  status: string | null;
  lastError: string | null;
  connectedAt: string | null;
}

export interface StatusPayload {
  mockMode: boolean;
  source: "google" | "mock";
  googleConfigured: boolean;
  connection: ConnectionSummary;
}

interface AccountItem {
  name: string;
  accountId: string;
  accountName: string | null;
}

interface LocationItem {
  name: string;
  locationId: string;
  title: string | null;
  address: string | null;
}

export function ConnectionPanel({
  status,
  onStatusChange,
  onReviewsChange,
  notify,
}: {
  status: StatusPayload | null;
  onStatusChange: (status: StatusPayload) => void;
  onReviewsChange: (reviews: ReviewItem[]) => void;
  notify: (notice: Notice) => void;
}) {
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [selectedLocation, setSelectedLocation] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, task: () => Promise<Notice>) => {
    setBusy(label);
    notify(null);
    try {
      notify(await task());
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Something went wrong." });
    } finally {
      setBusy(null);
    }
  };

  const loadAccounts = () =>
    run("accounts", async () => {
      const data = await call<{ accounts: AccountItem[] }>("/api/google/accounts");
      setAccounts(data.accounts);
      setSelectedAccount(data.accounts[0]?.name ?? "");
      return { tone: "ok", text: `Found ${data.accounts.length} account(s).` };
    });

  const loadLocations = () =>
    run("locations", async () => {
      const data = await call<{ locations: LocationItem[] }>(
        `/api/google/locations?account=${encodeURIComponent(selectedAccount)}`,
      );
      setLocations(data.locations);
      setSelectedLocation(data.locations[0]?.locationId ?? "");
      return { tone: "ok", text: `Found ${data.locations.length} location(s).` };
    });

  const pullReviews = () =>
    run("reviews", async () => {
      const location = locations.find((item) => item.locationId === selectedLocation);
      const data = await call<{
        fetched: number;
        created: number;
        updated: number;
        unchanged: number;
        failed: number;
        reviews: ReviewItem[];
      }>("/api/google/reviews", {
        method: "POST",
        body: JSON.stringify({
          accountId: selectedAccount.replace(/^accounts\//, ""),
          locationId: selectedLocation,
          locationTitle: location?.title ?? null,
        }),
      });
      onReviewsChange(data.reviews);
      return {
        tone: "ok",
        text: `Fetched ${data.fetched} · new ${data.created} · edited ${data.updated} · already stored ${data.unchanged}${
          data.failed ? ` · failed ${data.failed}` : ""
        }`,
      };
    });

  const runFixtures = () =>
    run("fixtures", async () => {
      const data = await call<{
        results: Array<{ key: string; action: string }>;
        reviews: ReviewItem[];
      }>("/api/dev/ingest-fixtures", { method: "POST", body: JSON.stringify({}) });

      onReviewsChange(data.reviews);

      const created = data.results.filter((item) => item.action === "created").length;
      const updated = data.results.filter((item) => item.action === "updated").length;
      const unchanged = data.results.filter((item) => item.action === "unchanged").length;

      return {
        tone: "ok",
        text: `Ran ${data.results.length} fixtures · new ${created} · edited ${updated} · deduplicated ${unchanged}`,
      };
    });

  const disconnect = () =>
    run("disconnect", async () => {
      await call("/api/auth/google/disconnect", { method: "POST" });
      onStatusChange(await call<StatusPayload>("/api/status"));
      setAccounts([]);
      setLocations([]);
      return { tone: "warn", text: "Google account disconnected." };
    });

  const mock = status?.source === "mock";

  return (
    <>
      {!mock ? (
        <section className="panel">
          <h2>Google account</h2>
          <p className="hint">
            Authorizing grants the business.manage scope. The refresh token is encrypted before it is stored
            and never reaches the browser.
          </p>
          <div className="row">
            <a className="button" href="/api/auth/google/start">
              {status?.connection.connected ? "Reconnect Google" : "Connect Google"}
            </a>
            {status?.connection.connected ? (
              <button data-tone="danger" onClick={disconnect} disabled={busy !== null}>
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            ) : null}
          </div>
          {status?.connection.lastError ? (
            <div className="notice" data-tone="error">
              {status.connection.lastError}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <h2>Accounts and locations</h2>
        <p className="hint">
          Synced copies are cached locally. The Reviews API has a low default quota, so this avoids
          re-listing structure that changes rarely.
        </p>

        <div className="row">
          <button onClick={loadAccounts} disabled={busy !== null}>
            {busy === "accounts" ? "Loading…" : "Load accounts"}
          </button>

          <select
            value={selectedAccount}
            onChange={(event) => setSelectedAccount(event.target.value)}
            disabled={accounts.length === 0}
            aria-label="Google account"
          >
            {accounts.length === 0 ? <option value="">No accounts loaded</option> : null}
            {accounts.map((account) => (
              <option key={account.name} value={account.name}>
                {account.accountName ?? account.accountId}
              </option>
            ))}
          </select>

          <button onClick={loadLocations} disabled={busy !== null || !selectedAccount}>
            {busy === "locations" ? "Loading…" : "Load locations"}
          </button>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <select
            value={selectedLocation}
            onChange={(event) => setSelectedLocation(event.target.value)}
            disabled={locations.length === 0}
            aria-label="Location"
          >
            {locations.length === 0 ? <option value="">No locations loaded</option> : null}
            {locations.map((location) => (
              <option key={location.locationId} value={location.locationId}>
                {location.title ?? location.locationId}
                {location.address ? ` — ${location.address}` : ""}
              </option>
            ))}
          </select>

          <button
            data-tone="primary"
            onClick={pullReviews}
            disabled={busy !== null || !selectedAccount || !selectedLocation}
          >
            {busy === "reviews" ? "Pulling…" : "Pull reviews"}
          </button>
        </div>
      </section>

      {mock ? (
        <section className="panel">
          <h2>Fixture run</h2>
          <p className="hint">
            Feeds all fourteen scenarios through the real ingest path. Watch for the duplicate event
            resolving to an existing row and the edited review incrementing its edit count rather than
            creating a second one.
          </p>
          <button onClick={runFixtures} disabled={busy !== null}>
            {busy === "fixtures" ? "Running…" : "Run all fixtures"}
          </button>
        </section>
      ) : null}
    </>
  );
}
