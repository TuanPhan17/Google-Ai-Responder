"use client";

import { formatDate, formatStars, type ReviewItem } from "@/app/components/api-client";

/** Read-only history: original review, final response, when it went out, and who's responsible for it. */
export function PublishedPanel({ reviews }: { reviews: ReviewItem[] }) {
  const published = reviews
    .filter((review) => review.status === "PUBLISHED")
    .sort((a, b) => (a.published_at ?? "") < (b.published_at ?? "") ? 1 : -1);

  return (
    <section className="panel">
      <h2>Published</h2>
      <p className="hint">Responses that reached Google, most recent first.</p>

      {published.length === 0 ? (
        <p className="empty-state">Nothing published yet.</p>
      ) : (
        <ul className="reviews">
          {published.map((review) => (
            <li key={review.id} className="review rail" data-state="ok">
              <header>
                <span className="who">
                  {review.reviewer_is_anonymous ? "Anonymous reviewer" : (review.reviewer_name ?? "Unnamed reviewer")}
                </span>
                <span className="meta">
                  published {formatDate(review.published_at)} · {review.location_title ?? review.google_review_id}
                </span>
              </header>

              <span className="stars">{formatStars(review.rating)}</span>

              <p className={`body${review.review_text ? "" : " empty"}`}>
                {review.review_text ?? "Rating only — no written review."}
              </p>

              <p className="body" style={{ color: "var(--text)" }}>
                {review.final_response ?? review.ai_response}
              </p>

              <div className="tags">
                <span className="tag" data-tone="ok">
                  {review.published_by === "auto" ? "automatic" : `approved by ${review.published_by ?? "unknown"}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
