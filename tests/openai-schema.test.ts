import { describe, expect, it } from "vitest";

import {
  extractResponseOutput,
  openAiResponseEnvelopeSchema,
  reviewResponseJsonSchema,
  reviewResponseSchema,
} from "@/schemas/openai";

const VALID_OUTPUT = {
  reply: "Thanks for the kind words, Sarah! We're glad Mike got you sorted ahead of schedule.",
  sentiment: "positive",
  rating: 5,
  needsHumanReview: false,
  riskLevel: "low",
  reason: "Positive customer review with no sensitive issues.",
  referencedDetails: ["fast service", "employee Mike"],
};

describe("reviewResponseSchema", () => {
  it("accepts the exact shape from docs/SPEC.md", () => {
    expect(reviewResponseSchema.safeParse(VALID_OUTPUT).success).toBe(true);
  });

  it("accepts an empty referencedDetails array for a vague review", () => {
    const result = reviewResponseSchema.safeParse({ ...VALID_OUTPUT, referencedDetails: [] });
    expect(result.success).toBe(true);
  });

  it("rejects a sentiment value outside the allowed enum", () => {
    const result = reviewResponseSchema.safeParse({ ...VALID_OUTPUT, sentiment: "very happy" });
    expect(result.success).toBe(false);
  });

  it("rejects a riskLevel value outside the allowed enum", () => {
    const result = reviewResponseSchema.safeParse({ ...VALID_OUTPUT, riskLevel: "extreme" });
    expect(result.success).toBe(false);
  });

  it("rejects a rating outside 1-5", () => {
    expect(reviewResponseSchema.safeParse({ ...VALID_OUTPUT, rating: 0 }).success).toBe(false);
    expect(reviewResponseSchema.safeParse({ ...VALID_OUTPUT, rating: 6 }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { reply: _reply, ...withoutReply } = VALID_OUTPUT;
    expect(reviewResponseSchema.safeParse(withoutReply).success).toBe(false);
  });

  it("rejects an empty reply", () => {
    expect(reviewResponseSchema.safeParse({ ...VALID_OUTPUT, reply: "" }).success).toBe(false);
  });
});

describe("reviewResponseJsonSchema", () => {
  it("requires every field reviewResponseSchema requires, for OpenAI strict mode", () => {
    const zodKeys = Object.keys(reviewResponseSchema.shape).sort();
    expect([...reviewResponseJsonSchema.required].sort()).toEqual(zodKeys);
  });

  it("disallows additional properties, matching strict Structured Outputs", () => {
    expect(reviewResponseJsonSchema.additionalProperties).toBe(false);
  });
});

describe("extractResponseOutput", () => {
  function envelope(output: unknown) {
    const parsed = openAiResponseEnvelopeSchema.parse({ id: "resp_1", output });
    return parsed;
  }

  it("extracts output_text from a message item", () => {
    const result = extractResponseOutput(
      envelope([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"reply":"hi"}' }],
        },
      ]),
    );
    expect(result).toEqual({ kind: "text", text: '{"reply":"hi"}' });
  });

  it("extracts a refusal when the model declines", () => {
    const result = extractResponseOutput(
      envelope([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I can't help with that." }],
        },
      ]),
    );
    expect(result).toEqual({ kind: "refusal", refusal: "I can't help with that." });
  });

  it("returns null when there is no message content", () => {
    expect(extractResponseOutput(envelope([]))).toBeNull();
  });

  it("ignores non-message output items (e.g. reasoning) and keeps looking", () => {
    const result = extractResponseOutput(
      envelope([
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"reply":"hi"}' }],
        },
      ]),
    );
    expect(result).toEqual({ kind: "text", text: '{"reply":"hi"}' });
  });
});
