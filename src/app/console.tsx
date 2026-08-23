"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Phase 1 console.
 *
 * Intentionally thin. Its job is to prove the pipe works end to end: connect
 * Google, pull the org structure, pull reviews, confirm rows landed. The
 * approval UI, the response editor and settings are Phase 8 — building them now
 * would mean building against a data model that Phases 2-6 are still shaping.
 *
 * The status rail on each row is already the visual language those phases fill
 * in: everything reads RECEIVED today, but the operator learns to scan the left
 * edge before there is anything urgent on it.
 */

interface ConnectionSummary {
  connected: boolean;
  googleEmail: string | null;
  status: string | null;
  lastError: string | null;
  connectedAt: string | null;
}

interface StatusPayload {
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

interface ReviewItem {
  id: string;
  google_review_id: string;
  reviewer_name: string | null;
  reviewer_is_anonymous: boolean;
  rating: number | null;
  review_text: string | null;
  review_created_at: string;
  status: string;
  is_edited: boolean;
  edit_count: number;
  google_reply_state: string;
  location_title: string | null;
}

type Notice = { tone: "ok" | "error" | "warn"; text: string } | null;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok: boolean; data?: T; error?: string }
    | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `Request failed (${response.status}).`);
  }
  return payload.data as T;
}

export default function Console() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [selectedLocation, setSelectedLocation] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(async (label: string, task: () => Promise<Notice>) => {
    setBusy(label);
    setNotice(null);
    try {
      setNotice(await task());
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setStatus(await call<StatusPayload>("/api/status"));
        setReviews((await call<{ reviews: ReviewItem[] }>("/api/google/reviews")).reviews);
      } catch (error) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load status." });
      }
    })();
  }, []);

  // Surface the outcome of the OAuth redirect, then clean the URL so a refresh
  // does not re-announce a connection that happened minutes ago.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    const connected = params.get("connected");
    if (!error && !connected) return;

    setNotice(
      connected
        ? { tone: "ok", text: "Google account connected." }
        : { tone: "error", text: describeOAuthError(error) },
    );
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

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
      setReviews(data.reviews);
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

      setReviews(data.reviews);

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
      setStatus(await call<StatusPayload>("/api/status"));
      setAccounts([]);
      setLocations([]);
      return { tone: "warn", text: "Google account disconnected." };
    });

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  const mock = status?.source === "mock";

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <span className="eyebrow">Phase 1 · foundation</span>
          <h1>Review console</h1>
          <p>Connect Google Business Profile, sync locations, and pull reviews into the database.</p>
        </div>
        <button onClick={signOut}>Sign out</button>
      </header>

      <dl className="statusline">
        <div>
          <dt>Data source</dt>
          <dd>{status ? (mock ? "mock fixtures" : "google business profile") : "…"}</dd>
        </div>
        <div>
          <dt>Google connection</dt>
          <dd>{status ? describeConnection(status) : "…"}</dd>
        </div>
        <div>
          <dt>Reviews stored</dt>
          <dd>{reviews.length}</dd>
        </div>
      </dl>

      {notice ? (
        <div className="notice" data-tone={notice.tone} role="status">
          {notice.text}
        </div>
      ) : null}

      {mock ? (
        <div className="notice" data-tone="warn">
          Mock mode is on. Nothing reaches Google, and no reply can be published. Set MOCK_MODE=false once
          your Business Profile API access is approved.
        </div>
      ) : null}

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

      <section className="panel">
        <h2>Stored reviews</h2>
        <p className="hint">
          Everything sits at RECEIVED. Generation, risk scoring and publishing arrive in later phases.
        </p>

        {reviews.length === 0 ? (
          <p className="empty-state">
            Nothing stored yet. {mock ? "Run the fixtures" : "Pull reviews for a location"} to populate this
            list.
          </p>
        ) : (
          <ul className="reviews">
            {reviews.map((review) => (
              <li key={review.id} className="review rail" data-state={railState(review)}>
                <header>
                  <span className="who">
                    {review.reviewer_is_anonymous
                      ? "Anonymous reviewer"
                      : (review.reviewer_name ?? "Unnamed reviewer")}
                  </span>
                  <span className="meta">
                    {formatDate(review.review_created_at)} · {review.google_review_id}
                  </span>
                </header>

                <span className="stars">{formatStars(review.rating)}</span>

                <p className={`body${review.review_text ? "" : " empty"}`}>
                  {review.review_text ?? "Rating only — no written review."}
                </p>

                <div className="tags">
                  <span className="tag">{review.status}</span>
                  {review.is_edited ? (
                    <span className="tag" data-tone="attention">
                      edited ×{review.edit_count}
                    </span>
                  ) : null}
                  {review.google_reply_state !== "NONE" ? (
                    <span className="tag" data-tone="blocked">
                      {review.google_reply_state.toLowerCase().replace(/_/g, " ")}
                    </span>
                  ) : null}
                  {review.rating !== null && review.rating <= 3 ? (
                    <span className="tag" data-tone="attention">
                      human approval required
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function railState(review: ReviewItem): "idle" | "ok" | "attention" | "blocked" {
  if (review.google_reply_state !== "NONE") return "blocked";
  if (review.rating !== null && review.rating <= 3) return "attention";
  if (review.is_edited) return "attention";
  return "idle";
}

function formatStars(rating: number | null): string {
  if (rating === null) return "no rating";
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}

function formatDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function describeConnection(status: StatusPayload): string {
  if (status.source === "mock") return "not needed in mock mode";
  if (!status.googleConfigured) return "credentials not configured";
  if (!status.connection.connected) return status.connection.status?.toLowerCase() ?? "not connected";
  return status.connection.googleEmail ?? "connected";
}

function describeOAuthError(code: string | null): string {
  switch (code) {
    case "google_declined":
      return "Authorization was declined at Google.";
    case "invalid_state":
      return "That sign-in link did not match this browser session. Start the connection again.";
    case "missing_code":
      return "Google did not return an authorization code.";
    case "mock_mode_active":
      return "Mock mode is on, so there is nothing to connect. Set MOCK_MODE=false first.";
    case "exchange_failed":
      return "Could not exchange the authorization code. Check the server logs.";
    default:
      return "Connecting to Google failed.";
  }
}
