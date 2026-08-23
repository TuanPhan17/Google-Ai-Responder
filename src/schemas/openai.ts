import { z } from "zod";

/**
 * Two different things get validated here, and they follow different rules:
 *
 *  - The Responses API envelope (`openAiResponseEnvelopeSchema`) is OpenAI's
 *    wire format. Like Google's, it gets `.passthrough()` everywhere: OpenAI
 *    adds fields regularly, and a strict schema would turn that into an outage.
 *
 *  - `reviewResponseSchema` is *our* structured-output shape, not OpenAI's. We
 *    define it, we send it to OpenAI as a strict JSON Schema, and we expect
 *    exact conformance — so no `.passthrough()` there. Anything that doesn't
 *    match is a bad generation, not an API evolving under us.
 */

const outputTextContentSchema = z
  .object({
    type: z.literal("output_text"),
    text: z.string(),
  })
  .passthrough();

const refusalContentSchema = z
  .object({
    type: z.literal("refusal"),
    refusal: z.string(),
  })
  .passthrough();

const outputContentSchema = z.union([
  outputTextContentSchema,
  refusalContentSchema,
  z.object({ type: z.string() }).passthrough(),
]);

const outputMessageSchema = z
  .object({
    type: z.literal("message"),
    role: z.string(),
    content: z.array(outputContentSchema),
  })
  .passthrough();

/** Reasoning items, tool calls, etc. We only act on `message` items. */
const outputItemSchema = z.union([outputMessageSchema, z.object({ type: z.string() }).passthrough()]);

export const openAiResponseEnvelopeSchema = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    model: z.string().optional(),
    output: z.array(outputItemSchema).default([]),
    error: z
      .object({ message: z.string() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type OpenAiResponseEnvelope = z.infer<typeof openAiResponseEnvelopeSchema>;

type OutputMessage = z.infer<typeof outputMessageSchema>;
type OutputTextContent = z.infer<typeof outputTextContentSchema>;
type RefusalContent = z.infer<typeof refusalContentSchema>;

/**
 * Pulls the structured-output JSON text (or a refusal) out of an envelope.
 * Returns null when there is no message content at all — a status like
 * "incomplete" can leave `output` empty.
 */
export function extractResponseOutput(
  envelope: OpenAiResponseEnvelope,
): { kind: "text"; text: string } | { kind: "refusal"; refusal: string } | null {
  for (const item of envelope.output) {
    // The catch-all union member types `type` as plain `string`, so TS can't
    // discriminate on it alone — the runtime check is enough to justify the cast.
    if (item.type !== "message") continue;
    const message = item as OutputMessage;

    for (const content of message.content) {
      // Same discriminated-union limitation as above: cast after the runtime check.
      if (content.type === "output_text") return { kind: "text", text: (content as OutputTextContent).text };
      if (content.type === "refusal") return { kind: "refusal", refusal: (content as RefusalContent).refusal };
    }
  }
  return null;
}

export const SENTIMENT_VALUES = ["positive", "mixed", "negative"] as const;
export const RISK_LEVEL_VALUES = ["low", "medium", "high"] as const;

/**
 * The structured output every review-response generation must produce.
 * Mirrors docs/SPEC.md "Structured AI Output" exactly.
 */
export const reviewResponseSchema = z.object({
  reply: z.string().min(1),
  sentiment: z.enum(SENTIMENT_VALUES),
  rating: z.number().int().min(1).max(5),
  needsHumanReview: z.boolean(),
  riskLevel: z.enum(RISK_LEVEL_VALUES),
  reason: z.string().min(1),
  /** Empty when nothing specific could be identified (e.g. a vague or star-only review). */
  referencedDetails: z.array(z.string()),
});
export type ReviewResponseOutput = z.infer<typeof reviewResponseSchema>;

/**
 * The same shape as `reviewResponseSchema`, hand-written as JSON Schema for
 * OpenAI's Structured Outputs (`strict: true`). Strict mode requires every
 * property listed in `required` and `additionalProperties: false` — kept in
 * sync with `reviewResponseSchema` by hand since the two describe the same
 * seven fields and are unlikely to drift unnoticed in code review.
 */
export const reviewResponseJsonSchema = {
  type: "object",
  properties: {
    reply: { type: "string" },
    sentiment: { type: "string", enum: [...SENTIMENT_VALUES] },
    rating: { type: "integer", minimum: 1, maximum: 5 },
    needsHumanReview: { type: "boolean" },
    riskLevel: { type: "string", enum: [...RISK_LEVEL_VALUES] },
    reason: { type: "string" },
    referencedDetails: { type: "array", items: { type: "string" } },
  },
  required: [
    "reply",
    "sentiment",
    "rating",
    "needsHumanReview",
    "riskLevel",
    "reason",
    "referencedDetails",
  ],
  additionalProperties: false,
} as const;
