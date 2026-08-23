import type { z } from "zod";

import { getEnv, getOpenAiApiKey } from "@/config/env";
import { OpenAiApiError, OpenAiRefusalError, SchemaValidationError, isRetryable } from "@/utils/errors";
import { withRetry, type RetryOptions } from "@/utils/retry";
import { extractResponseOutput, openAiResponseEnvelopeSchema } from "@/schemas/openai";

/**
 * The single path by which this application talks to its AI provider,
 * mirroring src/google/client.ts: one module owns auth, timeouts, retry, and
 * Zod validation, so no call site can accidentally skip one of them.
 *
 * "OpenAI" in this module's name is historical, not literal: OPENAI_BASE_URL
 * points at any Responses-API-compatible host (OpenAI, Groq, etc.), selected
 * entirely through env vars — nothing here assumes a specific provider.
 */

export interface OpenAiMessage {
  role: "system" | "user";
  content: string;
}

export interface StructuredRequest {
  messages: OpenAiMessage[];
  /** Label the provider attaches to the schema in its own tooling. Not customer data. */
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  /** Used only in our own logs/errors, never sent to the provider. */
  label?: string;
  temperature?: number;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  return undefined;
}

/** Never includes the request body in the message: it carries review text. */
function describeProviderError(status: number, rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    const message = parsed.error?.message;
    if (message) return message.slice(0, 300);
  } catch {
    /* fall through */
  }

  if (status === 401) return "The AI provider returned 401. Check that OPENAI_API_KEY is set and valid.";
  if (status === 429) return "The AI provider returned 429. Rate limited, or the account is out of quota.";
  return `The AI provider returned HTTP ${status}.`;
}

async function performRequest(request: StructuredRequest, label: string): Promise<unknown> {
  const env = getEnv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_API_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${getOpenAiApiKey()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        input: request.messages,
        temperature: request.temperature ?? 0.7,
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName,
            schema: request.jsonSchema,
            strict: env.OPENAI_STRICT_SCHEMA,
          },
        },
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    const rawBody = await response.text();

    if (!response.ok) {
      throw new OpenAiApiError(describeProviderError(response.status, rawBody), {
        status: response.status,
        context: { label, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) },
      });
    }

    try {
      return JSON.parse(rawBody) as unknown;
    } catch (cause) {
      throw new SchemaValidationError("AI provider response body was not valid JSON.", { label }, cause);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Issues a Structured Outputs request and validates the parsed JSON against
 * `schema` before returning it.
 *
 * A schema-validation failure is treated as retryable. With OPENAI_STRICT_SCHEMA
 * true on a model that supports it, the provider guarantees the JSON matches
 * our shape, so a validation failure here means the request itself didn't
 * complete cleanly rather than a bug worth repeating. With strict mode off (or
 * unsupported by the configured model), the provider is only making a
 * best-effort attempt, so a validation failure is the expected way an
 * occasional bad generation gets caught — retrying is exactly the right
 * response either way, not re-parsing the same text.
 */
export async function openAiStructuredRequest<T>(
  request: StructuredRequest,
  schema: z.ZodType<T>,
  retryOverrides: Partial<RetryOptions> = {},
): Promise<T> {
  const env = getEnv();
  const label = request.label ?? "openai.responses";

  return withRetry(
    async () => {
      const body = await performRequest(request, label);

      const envelope = openAiResponseEnvelopeSchema.safeParse(body);
      if (!envelope.success) {
        throw new SchemaValidationError("AI provider returned data in an unexpected shape.", {
          label,
          issues: envelope.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
      }

      const output = extractResponseOutput(envelope.data);
      if (!output) {
        throw new SchemaValidationError("AI provider response had no message content.", { label });
      }
      if (output.kind === "refusal") {
        throw new OpenAiRefusalError("The AI provider declined to generate a structured response.", { label });
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(output.text);
      } catch (cause) {
        throw new SchemaValidationError("The AI provider's structured output was not valid JSON.", { label }, cause);
      }

      const parsed = schema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new SchemaValidationError("The AI provider's structured output failed validation.", {
          label,
          issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
      }

      return parsed.data;
    },
    {
      label,
      maxAttempts: env.OPENAI_API_MAX_ATTEMPTS,
      baseDelayMs: 500,
      maxDelayMs: 20_000,
      shouldRetry: (error) => isRetryable(error) || error instanceof SchemaValidationError,
      retryAfterMs: (error) =>
        error instanceof OpenAiApiError ? (error.context["retryAfterMs"] as number | undefined) : undefined,
      ...retryOverrides,
    },
  );
}
