"use client";

import { useEffect, useState } from "react";

import { call, type Notice, type ReviewItem } from "@/app/components/api-client";
import { ConnectionPanel, type StatusPayload } from "@/app/components/ConnectionPanel";
import { ReviewQueuePanel } from "@/app/components/ReviewQueuePanel";
import { PublishedPanel } from "@/app/components/PublishedPanel";
import { SettingsPanel } from "@/app/components/SettingsPanel";

/**
 * The dashboard shell — per docs/SPEC.md Phase 8.
 *
 * Four tabs share one status header and one notice line: Reviews (the
 * approval queue), Published (history), Settings (business voice and
 * auto-publish configuration), and Connection (Phase 1's Google/fixtures
 * setup, unchanged). Reviews and Published both read from the same
 * in-memory `reviews` list — they're two filtered views of one dataset, not
 * two separate fetches, so an action in one tab (e.g. publishing) is
 * immediately reflected if the operator switches to the other.
 */

const TABS = ["reviews", "published", "settings", "connection"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  reviews: "New reviews",
  published: "Published",
  settings: "Settings",
  connection: "Connection",
};

export default function Console() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [tab, setTab] = useState<Tab>("reviews");

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

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  const mock = status?.source === "mock";
  const pendingCount = reviews.filter((r) =>
    ["RECEIVED", "GENERATED", "PENDING_APPROVAL", "FAILED"].includes(r.status),
  ).length;

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <span className="eyebrow">Phase 8 · dashboard</span>
          <h1>Review console</h1>
          <p>Triage reviews, publish responses, and configure how the business sounds.</p>
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
          <dt>Needs attention</dt>
          <dd>{pendingCount}</dd>
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

      <nav className="tabs">
        {TABS.map((item) => (
          <button
            key={item}
            data-tone={tab === item ? "primary" : undefined}
            onClick={() => setTab(item)}
            aria-current={tab === item}
          >
            {TAB_LABELS[item]}
            {item === "reviews" && pendingCount > 0 ? ` (${pendingCount})` : ""}
          </button>
        ))}
      </nav>

      {tab === "reviews" ? (
        <ReviewQueuePanel reviews={reviews} onReviewsChange={setReviews} notify={setNotice} />
      ) : null}

      {tab === "published" ? <PublishedPanel reviews={reviews} /> : null}

      {tab === "settings" ? <SettingsPanel notify={setNotice} /> : null}

      {tab === "connection" ? (
        <ConnectionPanel
          status={status}
          onStatusChange={setStatus}
          onReviewsChange={setReviews}
          notify={setNotice}
        />
      ) : null}
    </main>
  );
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
