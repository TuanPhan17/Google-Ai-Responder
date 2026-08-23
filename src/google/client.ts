import { z } from "zod";

import { getEnv } from "@/config/env";
import { getAccessToken, forceRefresh } from "@/auth/token-store";
import { GoogleApiError, SchemaValidationError } from "@/utils/errors";
import { withRetry } from "@/utils/retry";
import { logger } from "@/utils/logger";

/**
 * The single path by which this application talks to any Google API.
 *
 * Centralizing it means auth, timeouts, retry, error mapping and schema
 * validation are applied uniformly — a new endpoint cannot accidentally skip
 * the retry policy or forget to validate its response.
 */

const log = logger.child("google.client");

export interface GoogleRequest {
  /** Absolute URL; use the base constants from config/google-api.ts. */
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  searchParams?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Attempt override; defaults to GOOGLE_API_MAX_ATTEMPTS. */
  maxAttempts?: number;
  label?: string;
}

function buildUrl(url: string, searchParams?: GoogleRequest["searchParams"]): string {
  if (!searchParams) return url;
  const target = new URL(url);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== "") target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

function describeGoogleError(status: number, rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string; status?: string } };
    const message = parsed.error?.message;
    if (message) return message.slice(0, 300);
  } catch {
    /* fall through */
  }

  // The two failure modes that account for most first-run confusion.
  if (status === 403) {
    return "Google returned 403. The API is probably not enabled on the project, or Business Profile API access has not been approved yet.";
  }
  if (status === 429) {
    return "Google returned 429. Business Profile quota is low by default — request a quota increase or slow the poll rate.";
  }
  return `Google returned HTTP ${status}.`;
}

async function performRequest(request: GoogleRequest, accessToken: string): Promise<unknown> {
  const env = getEnv();
  const url = buildUrl(request.url, request.searchParams);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.GOOGLE_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: request.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const rawBody = await response.text();
      throw new GoogleApiError(describeGoogleError(response.status, rawBody), {
        status: response.status,
        retryAfterSeconds: undefined,
        context: {
          label: request.label ?? url,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        },
      });
    }

    if (response.status === 204) return {};
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Issues an authorized request and validates the response against `schema`.
 *
 * The 401 path is handled outside the retry loop on purpose: a 401 is not a
 * transient failure to back off from, it is a stale token to replace. We
 * refresh once and re-issue immediately. If the second attempt also 401s, the
 * credential is genuinely bad and backing off would only delay that finding.
 */
export async function googleRequest<T>(request: GoogleRequest, schema: z.ZodType<T>): Promise<T> {
  const env = getEnv();
  const label = request.label ?? request.url;

  const issue = async (token: string) =>
    withRetry(() => performRequest(request, token), {
      label,
      maxAttempts: request.maxAttempts ?? env.GOOGLE_API_MAX_ATTEMPTS,
      baseDelayMs: 500,
      maxDelayMs: 20_000,
      retryAfterMs: (error) =>
        error instanceof GoogleApiError
          ? (error.context["retryAfterMs"] as number | undefined)
          : undefined,
    });

  let raw: unknown;
  try {
    raw = await issue(await getAccessToken());
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 401) {
      log.info("Access token rejected; refreshing and retrying once", { label });
      raw = await issue(await forceRefresh());
    } else {
      throw error;
    }
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new SchemaValidationError("Google returned data in an unexpected shape.", {
      label,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }

  return parsed.data;
}

/**
 * Walks a paginated Google list endpoint.
 *
 * `maxPages` is a guard, not a limit we expect to hit: a bug in token handling
 * that returns the same page forever would otherwise loop until the process
 * dies, burning quota the whole time.
 */
export async function paginate<TPage, TItem>(
  fetchPage: (pageToken: string | undefined) => Promise<TPage>,
  selectItems: (page: TPage) => TItem[],
  selectNextToken: (page: TPage) => string | undefined,
  maxPages = 20,
): Promise<TItem[]> {
  const items: TItem[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(pageToken);
    items.push(...selectItems(result));

    const next = selectNextToken(result);
    if (!next) return items;
    pageToken = next;
  }

  log.warn("Stopped paginating at the page limit", { maxPages, collected: items.length });
  return items;
}
