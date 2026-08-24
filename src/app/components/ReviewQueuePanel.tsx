"use client";

import { useState } from "react";

import { call, formatDate, formatReasons, formatStars, type Notice, type ReviewItem } from "@/app/components/api-client";

/**
 * The New Reviews queue — everything except PUBLISHED, per docs/SPEC.md
 * Phase 8. Actions available on a row depend entirely on its `status`; see
 * `actionsFor` below, which is the one place that maps status to what a
 * human can legally do next (mirroring the status allowlists already
 * enforced server-side in approval.service.ts and publishing.service.ts —
 * this is a UX convenience, not a second copy of the safety check).
 */

const QUEUE_STATUSES = ["RECEIVED", "PROCESSING", "GENERATED", "PENDING_APPROVAL", "APPROVED", "FAILED", "REJECTED"];

type PublishOutcome = { outcome: string; error?: string };

function publishNotice(result: PublishOutcome): Notice {
  if (result.outcome === "published") return { tone: "ok", text: "Published to Google." };
  if (result.outcome === "blocked_existing_reply") {
    return {
      tone: "warn",
      text: "Google already has a different reply on this review — routed back for a human look.",
    };
  }
  return { tone: "error", text: `Publishing failed: ${result.error ?? "unknown error"}` };
}

function railState(status: string): "idle" | "ok" | "attention" | "blocked" {
  if (status === "FAILED" || status === "REJECTED") return "blocked";
  if (status === "GENERATED" || status === "PENDING_APPROVAL") return "attention";
  if (status === "APPROVED") return "ok";
  return "idle";
}

export function ReviewQueuePanel({
  reviews,
  onReviewsChange,
  notify,
}: {
  reviews: ReviewItem[];
  onReviewsChange: (reviews: ReviewItem[]) => void;
  notify: (notice: Notice) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const queue = reviews
    .filter((review) => QUEUE_STATUSES.includes(review.status))
    .sort((a, b) => (a.review_created_at < b.review_created_at ? 1 : -1));

  async function refresh() {
    const data = await call<{ reviews: ReviewItem[] }>("/api/google/reviews");
    onReviewsChange(data.reviews);
  }

  async function run(key: string, task: () => Promise<Notice>) {
    setBusyKey(key);
    try {
      notify(await task());
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Something went wrong." });
    } finally {
      await refresh().catch(() => {});
      setBusyKey(null);
    }
  }

  const generate = (id: string) =>
    run(`${id}:generate`, async () => {
      await call(`/api/reviews/${id}/process`, { method: "POST", body: "{}" });
      return { tone: "ok", text: "Response generated." };
    });

  const regenerate = (id: string) =>
    run(`${id}:regenerate`, async () => {
      await call(`/api/reviews/${id}/regenerate`, { method: "POST", body: "{}" });
      return { tone: "ok", text: "Response regenerated." };
    });

  const reject = (id: string) =>
    run(`${id}:reject`, async () => {
      await call(`/api/reviews/${id}/reject`, { method: "POST", body: "{}" });
      return { tone: "warn", text: "Review rejected." };
    });

  const unapprove = (id: string) =>
    run(`${id}:unapprove`, async () => {
      await call(`/api/reviews/${id}/unapprove`, { method: "POST", body: "{}" });
      return { tone: "warn", text: "Sent back to the queue for a fresh sign-off." };
    });

  const retryPublish = (id: string) =>
    run(`${id}:publish`, async () => {
      const result = await call<PublishOutcome>(`/api/reviews/${id}/publish`, { method: "POST", body: "{}" });
      return publishNotice(result);
    });

  const approveAndPublish = (id: string) =>
    run(`${id}:approve`, async () => {
      await call(`/api/reviews/${id}/approve`, { method: "POST", body: "{}" });
      const result = await call<PublishOutcome>(`/api/reviews/${id}/publish`, { method: "POST", body: "{}" });
      return publishNotice(result);
    });

  const saveEdit = (id: string) =>
    run(`${id}:edit`, async () => {
      const response = (drafts[id] ?? "").trim();
      if (!response) throw new Error("Enter a response before saving.");
      await call(`/api/reviews/${id}/edit`, { method: "POST", body: JSON.stringify({ response }) });
      return { tone: "ok", text: "Edit saved." };
    });

  return (
    <section className="panel">
      <h2>New reviews</h2>
      <p className="hint">
        Every draft still needs a human — REQUIRE_APPROVAL_FOR_ALL is on by default, so nothing here
        publishes itself. See why each review needs a look in its "why approval" tags below.
      </p>

      {queue.length === 0 ? (
        <p className="empty-state">Nothing in the queue. Pull reviews or run fixtures from Connection.</p>
      ) : (
        <ul className="reviews">
          {queue.map((review) => {
            const draft = drafts[review.id] ?? review.final_response ?? review.ai_response ?? "";
            const isBusy = (suffix: string) => busyKey === `${review.id}:${suffix}`;
            const anyBusy = busyKey?.startsWith(`${review.id}:`) ?? false;

            return (
              <li key={review.id} className="review rail" data-state={railState(review.status)}>
                <header>
                  <span className="who">
                    {review.reviewer_is_anonymous ? "Anonymous reviewer" : (review.reviewer_name ?? "Unnamed reviewer")}
                  </span>
                  <span className="meta">
                    {formatDate(review.review_created_at)} · {review.location_title ?? review.google_review_id}
                  </span>
                </header>

                <span className="stars">{formatStars(review.rating)}</span>

                <p className={`body${review.review_text ? "" : " empty"}`}>
                  {review.review_text ?? "Rating only — no written review."}
                </p>

                <div className="tags">
                  <span className="tag">{review.status}</span>
                  {review.sentiment ? <span className="tag">{review.sentiment}</span> : null}
                  {review.risk_level ? (
                    <span className="tag" data-tone={review.risk_level === "low" ? undefined : "attention"}>
                      risk: {review.risk_level}
                    </span>
                  ) : null}
                  {review.is_edited ? (
                    <span className="tag" data-tone="attention">
                      edited ×{review.edit_count}
                    </span>
                  ) : null}
                  {formatReasons(review.publish_decision_reason).map((reason) => (
                    <span key={reason} className="tag" data-tone="attention">
                      {reason}
                    </span>
                  ))}
                </div>

                {review.referenced_details.length > 0 ? (
                  <p className="hint" style={{ margin: "8px 0 0" }}>
                    Referenced: {review.referenced_details.join(", ")}
                  </p>
                ) : null}

                {review.status === "RECEIVED" ? (
                  <div className="row" style={{ marginTop: 12 }}>
                    <button data-tone="primary" onClick={() => generate(review.id)} disabled={anyBusy}>
                      {isBusy("generate") ? "Generating…" : "Generate response"}
                    </button>
                  </div>
                ) : null}

                {review.status === "PROCESSING" ? (
                  <p className="hint" style={{ margin: "8px 0 0" }}>
                    Generation in progress — reload to check back.
                  </p>
                ) : null}

                {review.status === "FAILED" ? (
                  <>
                    {review.last_error ? (
                      <div className="notice" data-tone="error">
                        {review.last_error}
                      </div>
                    ) : null}
                    <div className="row" style={{ marginTop: 12 }}>
                      <button onClick={() => regenerate(review.id)} disabled={anyBusy}>
                        {isBusy("regenerate") ? "Retrying…" : "Retry"}
                      </button>
                    </div>
                  </>
                ) : null}

                {review.status === "GENERATED" || review.status === "PENDING_APPROVAL" ? (
                  <>
                    <textarea
                      value={draft}
                      onChange={(event) => setDrafts((prev) => ({ ...prev, [review.id]: event.target.value }))}
                      rows={3}
                      style={{ width: "100%", marginTop: 10 }}
                      aria-label="Response draft"
                    />
                    <div className="row" style={{ marginTop: 10 }}>
                      <button data-tone="primary" onClick={() => approveAndPublish(review.id)} disabled={anyBusy}>
                        {isBusy("approve") ? "Publishing…" : "Approve & publish"}
                      </button>
                      <button onClick={() => saveEdit(review.id)} disabled={anyBusy}>
                        {isBusy("edit") ? "Saving…" : "Save edit"}
                      </button>
                      <button onClick={() => regenerate(review.id)} disabled={anyBusy}>
                        {isBusy("regenerate") ? "Regenerating…" : "Regenerate"}
                      </button>
                      <button data-tone="danger" onClick={() => reject(review.id)} disabled={anyBusy}>
                        {isBusy("reject") ? "Rejecting…" : "Reject"}
                      </button>
                    </div>
                  </>
                ) : null}

                {review.status === "APPROVED" ? (
                  <>
                    <p className="body">{review.final_response ?? review.ai_response}</p>
                    <div className="row" style={{ marginTop: 10 }}>
                      <button data-tone="primary" onClick={() => retryPublish(review.id)} disabled={anyBusy}>
                        {isBusy("publish") ? "Publishing…" : "Publish"}
                      </button>
                      <button onClick={() => unapprove(review.id)} disabled={anyBusy}>
                        {isBusy("unapprove") ? "Reverting…" : "Unapprove"}
                      </button>
                    </div>
                  </>
                ) : null}

                {review.status === "REJECTED" ? <p className="hint">Rejected — no response will be published.</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
