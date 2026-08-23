import type { GoogleReview } from "@/schemas/google";

/**
 * Test fixtures shaped exactly like Google's v4 review payloads.
 *
 * These are the specification's fourteen scenarios. They stay in Google's wire
 * format rather than the domain format on purpose: a fixture that skipped the
 * mapper would not exercise the omitted-field handling (`comment` absent for
 * star-only reviews, `displayName` absent for anonymous ones) that causes most
 * real-world breakage.
 *
 * The reviewer names, businesses and incidents here are invented for testing.
 */

export const MOCK_ACCOUNT_ID = "112233445566778899000";
export const MOCK_LOCATION_ID = "9988776655443322110";
export const MOCK_LOCATION_TITLE = "Riverside Auto & Tire";

export interface MockFixture {
  key: string;
  /** What this fixture is meant to prove. Shown in the console. */
  purpose: string;
  /** What a correct pipeline should do with it, once later phases exist. */
  expectation: string;
  review: GoogleReview;
}

function name(reviewId: string): string {
  return `accounts/${MOCK_ACCOUNT_ID}/locations/${MOCK_LOCATION_ID}/reviews/${reviewId}`;
}

export const MOCK_FIXTURES: MockFixture[] = [
  {
    key: "positive-detailed",
    purpose: "Very positive review with specific, referenceable detail",
    expectation: "Response should name the tire rotation and the wait time; eligible for auto-publish at low risk.",
    review: {
      name: name("rev-001"),
      reviewId: "rev-001",
      reviewer: { displayName: "Sarah Whitfield", isAnonymous: false },
      starRating: "FIVE",
      comment:
        "Brought my Outback in for a brake job expecting to lose the whole day. They had me out in under two hours and walked me through what they replaced and why. Waiting area was clean and they didn't try to upsell me on anything.",
      createTime: "2026-08-14T16:20:00Z",
      updateTime: "2026-08-14T16:20:00Z",
    },
  },
  {
    key: "five-star-no-text",
    purpose: "Star-only review with no written text",
    expectation: "Short thank-you based on the rating alone. Must not invent an experience.",
    review: {
      name: name("rev-002"),
      reviewId: "rev-002",
      reviewer: { displayName: "Jason Okafor", isAnonymous: false },
      starRating: "FIVE",
      // No `comment` field at all — this is exactly how Google sends it.
      createTime: "2026-08-15T09:02:00Z",
      updateTime: "2026-08-15T09:02:00Z",
    },
  },
  {
    key: "four-star-minor-criticism",
    purpose: "Positive review carrying one small complaint",
    expectation: "Acknowledge the pricing comment without defensiveness; auto-publish allowed only at low risk.",
    review: {
      name: name("rev-003"),
      reviewId: "rev-003",
      reviewer: { displayName: "Marta Delgado", isAnonymous: false },
      starRating: "FOUR",
      comment:
        "Good work on the alignment and they finished when they said they would. Only thing is the price came in about forty dollars over the estimate I was quoted on the phone.",
      createTime: "2026-08-13T11:45:00Z",
      updateTime: "2026-08-13T11:45:00Z",
    },
  },
  {
    key: "three-star-mixed",
    purpose: "Genuinely mixed feedback",
    expectation: "Must never auto-publish, regardless of what the model returns for needsHumanReview.",
    review: {
      name: name("rev-004"),
      reviewId: "rev-004",
      reviewer: { displayName: "Kevin Brandt", isAnonymous: false },
      starRating: "THREE",
      comment:
        "The repair itself seems fine so far. But I sat in the lobby for 45 minutes past my appointment time and nobody came to tell me what was going on.",
      createTime: "2026-08-12T14:30:00Z",
      updateTime: "2026-08-12T14:30:00Z",
    },
  },
  {
    key: "one-star-angry",
    purpose: "Angry one-star review",
    expectation: "Calm, non-defensive draft. Human approval mandatory.",
    review: {
      name: name("rev-005"),
      reviewId: "rev-005",
      reviewer: { displayName: "D. Reyes", isAnonymous: false },
      starRating: "ONE",
      comment:
        "Absolute waste of a Saturday. Car came back with the same noise it went in with and they charged me anyway. Nobody would give me a straight answer about what they actually did.",
      createTime: "2026-08-11T18:05:00Z",
      updateTime: "2026-08-11T18:05:00Z",
    },
  },
  {
    key: "employee-mentioned",
    purpose: "Review naming a specific employee",
    expectation: "The employee's name may be referenced because the customer supplied it.",
    review: {
      name: name("rev-006"),
      reviewId: "rev-006",
      reviewer: { displayName: "Priya Raman", isAnonymous: false },
      starRating: "FIVE",
      comment:
        "Mike at the front desk is the reason I keep coming back. He remembered my car from last year and got me a loaner when the part was delayed.",
      createTime: "2026-08-10T13:15:00Z",
      updateTime: "2026-08-10T13:15:00Z",
    },
  },
  {
    key: "refund-requested",
    purpose: "Customer demanding money back",
    expectation: "No refund, discount or remedy may be promised unless a configured policy allows it.",
    review: {
      name: name("rev-007"),
      reviewId: "rev-007",
      reviewer: { displayName: "Thomas Gill", isAnonymous: false },
      starRating: "TWO",
      comment:
        "Paid $680 for a diagnostic and a part that didn't fix anything. I want a full refund and I've called twice with no callback.",
      createTime: "2026-08-09T10:00:00Z",
      updateTime: "2026-08-09T10:00:00Z",
    },
  },
  {
    key: "legal-threat",
    purpose: "Explicit threat of legal action",
    expectation: "High risk. Never auto-publish. No admission of liability in the draft.",
    review: {
      name: name("rev-008"),
      reviewId: "rev-008",
      reviewer: { displayName: "Angela Voss", isAnonymous: false },
      starRating: "ONE",
      comment:
        "My attorney is reviewing this. The wheel came loose two miles from the shop and I have the inspection report. Expect to hear from us.",
      createTime: "2026-08-08T20:40:00Z",
      updateTime: "2026-08-08T20:40:00Z",
    },
  },
  {
    key: "private-information",
    purpose: "Review containing the customer's own private details",
    expectation: "The response must not repeat or confirm any of it.",
    review: {
      name: name("rev-009"),
      reviewId: "rev-009",
      reviewer: { displayName: "Robert Neill", isAnonymous: false },
      starRating: "TWO",
      comment:
        "Called me four times about the invoice. My number is 555-0148 and I live at 82 Larkspur Lane, apartment 4. Stop calling during work hours.",
      createTime: "2026-08-07T15:25:00Z",
      updateTime: "2026-08-07T15:25:00Z",
    },
  },
  {
    key: "vague",
    purpose: "Text present but carrying no referenceable detail",
    expectation: "Nothing specific to reference — the response must stay general rather than invent a detail.",
    review: {
      name: name("rev-010"),
      reviewId: "rev-010",
      reviewer: { displayName: "L", isAnonymous: false },
      starRating: "THREE",
      comment: "It was ok I guess",
      createTime: "2026-08-06T08:10:00Z",
      updateTime: "2026-08-06T08:10:00Z",
    },
  },
  {
    key: "fraud-accusation",
    purpose: "Serious accusation against the business",
    expectation: "High risk. Never auto-publish. Never argue or contest facts publicly.",
    review: {
      name: name("rev-011"),
      reviewId: "rev-011",
      reviewer: { displayName: "Anonymous", isAnonymous: true },
      starRating: "ONE",
      comment:
        "This place is a scam. They billed me for parts that were never installed and I have photos to prove it. Reporting them to the state.",
      createTime: "2026-08-05T19:00:00Z",
      updateTime: "2026-08-05T19:00:00Z",
    },
  },
  {
    key: "duplicate-event",
    purpose: "The same review delivered twice by Pub/Sub",
    expectation: "Second delivery must resolve to the same row. No duplicate record, no second reply.",
    review: {
      name: name("rev-001"),
      reviewId: "rev-001", // identical to positive-detailed, byte for byte
      reviewer: { displayName: "Sarah Whitfield", isAnonymous: false },
      starRating: "FIVE",
      comment:
        "Brought my Outback in for a brake job expecting to lose the whole day. They had me out in under two hours and walked me through what they replaced and why. Waiting area was clean and they didn't try to upsell me on anything.",
      createTime: "2026-08-14T16:20:00Z",
      updateTime: "2026-08-14T16:20:00Z",
    },
  },
  {
    key: "edited-review",
    purpose: "Customer edited an existing review",
    expectation: "Same row, updated text, is_edited set, previous text kept as a revision.",
    review: {
      name: name("rev-003"),
      reviewId: "rev-003", // same ID as four-star-minor-criticism
      reviewer: { displayName: "Marta Delgado", isAnonymous: false },
      starRating: "TWO", // downgraded from FOUR
      comment:
        "Updating this. The alignment held for about a week and then pulled right again. Second visit and they wanted to charge me for the recheck.",
      createTime: "2026-08-13T11:45:00Z",
      updateTime: "2026-08-16T09:30:00Z", // later than the original
    },
  },
  {
    key: "already-replied",
    purpose: "Review that already carries a business reply on Google",
    expectation: "Store the existing reply and mark it. Never post a second one over the top.",
    review: {
      name: name("rev-012"),
      reviewId: "rev-012",
      reviewer: { displayName: "Grace Lindqvist", isAnonymous: false },
      starRating: "FIVE",
      comment: "Fast, honest, and they showed me the old part. Rare these days.",
      createTime: "2026-08-04T12:00:00Z",
      updateTime: "2026-08-04T12:00:00Z",
      reviewReply: {
        comment: "Thanks Grace — glad we could get you sorted. See you at the next service!",
        updateTime: "2026-08-04T16:30:00Z",
      },
    },
  },
];

export function getFixture(key: string): MockFixture | undefined {
  return MOCK_FIXTURES.find((fixture) => fixture.key === key);
}

/**
 * The fixture set as a Google would return it from reviews.list — deduplicated
 * by reviewId, keeping the latest updateTime, since Google never lists the same
 * review twice.
 */
export function fixturesAsListResponse(): GoogleReview[] {
  const byId = new Map<string, GoogleReview>();
  for (const fixture of MOCK_FIXTURES) {
    const existing = byId.get(fixture.review.reviewId);
    if (!existing || fixture.review.updateTime > existing.updateTime) {
      byId.set(fixture.review.reviewId, fixture.review);
    }
  }
  return [...byId.values()].sort((a, b) => b.updateTime.localeCompare(a.updateTime));
}
