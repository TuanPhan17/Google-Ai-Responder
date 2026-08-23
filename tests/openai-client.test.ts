import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { resetEnvCache } from "@/config/env";
import { OpenAiApiError, OpenAiRefusalError, SchemaValidationError } from "@/utils/errors";
import { reviewResponseJsonSchema, reviewResponseSchema } from "@/schemas/openai";

const VALID_OUTPUT = {
  reply: "Thanks so much!",
  sentiment: "positive",
  rating: 5,
  needsHumanReview: false,
  riskLevel: "low",
  reason: "Positive review, no risk factors.",
  referencedDetails: [],
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function envelopeWithText(text: string) {
  return {
    id: "resp_1",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ],
  };
}

function envelopeWithRefusal(refusal: string) {
  return {
    id: "resp_1",
    output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal }] }],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-placeholder-value";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.ADMIN_PASSWORD = "console-password-example";
  process.env.MOCK_MODE = "true";
  process.env.OPENAI_API_KEY = "sk-test-key-not-real";
  process.env.OPENAI_API_MAX_ATTEMPTS = "3";
  resetEnvCache();

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function callClient(sleep: () => Promise<void> = async () => {}) {
  const { openAiStructuredRequest } = await import("@/openai/client");
  return openAiStructuredRequest(
    {
      messages: [{ role: "user", content: "irrelevant" }],
      schemaName: "review_response",
      jsonSchema: reviewResponseJsonSchema,
      label: "test",
    },
    reviewResponseSchema,
    { sleep },
  );
}

describe("openAiStructuredRequest", () => {
  it("sends the API key as a bearer token and returns validated output", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, envelopeWithText(JSON.stringify(VALID_OUTPUT))));

    const result = await callClient();

    expect(result).toEqual(VALID_OUTPUT);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-key-not-real");
  });

  it("requests strict Structured Outputs matching our schema", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, envelopeWithText(JSON.stringify(VALID_OUTPUT))));

    await callClient();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema).toEqual(reviewResponseJsonSchema);
  });

  it("throws OpenAiApiError and does not retry a 400", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: "bad request" } }));

    await expect(callClient()).rejects.toThrow(OpenAiApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and eventually succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "rate limited" } }))
      .mockResolvedValueOnce(jsonResponse(200, envelopeWithText(JSON.stringify(VALID_OUTPUT))));

    const result = await callClient();

    expect(result).toEqual(VALID_OUTPUT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries structured output that fails Zod validation, then gives up after max attempts", async () => {
    const invalid = { ...VALID_OUTPUT, sentiment: "very happy" };
    // A fresh Response per call: Response bodies can only be read once, and
    // every retry attempt reads .text() on whatever fetch() returns.
    fetchMock.mockImplementation(async () => jsonResponse(200, envelopeWithText(JSON.stringify(invalid))));

    await expect(callClient()).rejects.toThrow(SchemaValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // OPENAI_API_MAX_ATTEMPTS
  });

  it("throws OpenAiRefusalError without retrying when the model refuses", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, envelopeWithRefusal("cannot assist with this request")));

    await expect(callClient()).rejects.toThrow(OpenAiRefusalError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws SchemaValidationError when the output text is not valid JSON", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, envelopeWithText("not json")));

    await expect(callClient()).rejects.toThrow(SchemaValidationError);
  });
});
