/**
 * Shared fetch helper and wire types for the dashboard's client components.
 *
 * `ReviewItem` mirrors `ReviewRow` (src/database/repositories/review.repository.ts)
 * field-for-field, since that row is what every reviews API route returns
 * as JSON — kept as a separate type rather than importing the server type
 * because this file is client code and the server type lives in a module
 * tree that includes server-only imports.
 */

export type Notice = { tone: "ok" | "error" | "warn"; text: string } | null;

export async function call<T>(url: string, init?: RequestInit): Promise<T> {
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

export interface ReviewItem {
  id: string;
  google_review_id: string;
  reviewer_name: string | null;
  reviewer_is_anonymous: boolean;
  rating: number | null;
  review_text: string | null;
  review_created_at: string;
  review_updated_at: string;
  is_edited: boolean;
  edit_count: number;
  status: string;
  google_reply_state: string;
  existing_google_reply: string | null;
  location_title: string | null;
  ai_response: string | null;
  final_response: string | null;
  sentiment: string | null;
  risk_level: string | null;
  needs_human_review: boolean | null;
  human_review_required: boolean;
  ai_reason: string | null;
  referenced_details: string[];
  ai_model: string | null;
  publish_decision: string | null;
  publish_decision_reason: string | null;
  processing_attempts: number;
  last_error: string | null;
  published_at: string | null;
  published_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
}

export function formatStars(rating: number | null): string {
  if (rating === null) return "no rating";
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toISOString().slice(0, 16).replace("T", " ");
}

/** Reason codes from decidePublishing (publishing-policy.ts), e.g. "rating_requires_approval" -> "rating requires approval". */
export function formatReasons(reasonCsv: string | null): string[] {
  if (!reasonCsv) return [];
  return reasonCsv
    .split(",")
    .map((code) => code.trim().replace(/_/g, " "))
    .filter(Boolean);
}
