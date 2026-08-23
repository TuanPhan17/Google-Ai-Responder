import { describe, expect, it, vi } from "vitest";

import { computeBackoffMs, withRetry } from "@/utils/retry";
import { GoogleApiError } from "@/utils/errors";

const noSleep = async () => {};

describe("computeBackoffMs", () => {
  it("grows exponentially and stays within the cap", () => {
    // random() pinned to 1 gives the upper bound of the jitter window.
    expect(computeBackoffMs(0, 400, 15_000, () => 1)).toBe(400);
    expect(computeBackoffMs(1, 400, 15_000, () => 1)).toBe(800);
    expect(computeBackoffMs(2, 400, 15_000, () => 1)).toBe(1600);
    expect(computeBackoffMs(20, 400, 15_000, () => 1)).toBe(15_000);
  });

  it("jitters below the ceiling", () => {
    expect(computeBackoffMs(3, 400, 15_000, () => 0.25)).toBe(800);
  });
});

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("done");
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new GoogleApiError("rate limited", { status: 429 }))
      .mockResolvedValue("done");

    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx up to the attempt limit, then gives up", async () => {
    const fn = vi.fn().mockRejectedValue(new GoogleApiError("upstream down", { status: 503 }));

    await expect(withRetry(fn, { maxAttempts: 3, sleep: noSleep })).rejects.toThrow("upstream down");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 400 — an invalid request stays invalid", async () => {
    const fn = vi.fn().mockRejectedValue(new GoogleApiError("bad request", { status: 400 }));

    await expect(withRetry(fn, { maxAttempts: 5, sleep: noSleep })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 403 — missing API access will not fix itself", async () => {
    const fn = vi.fn().mockRejectedValue(new GoogleApiError("forbidden", { status: 403 }));

    await expect(withRetry(fn, { maxAttempts: 5, sleep: noSleep })).rejects.toThrow("forbidden");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honours a server-supplied retry delay over its own backoff", async () => {
    const slept: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new GoogleApiError("slow down", { status: 429 }))
      .mockResolvedValue("done");

    await withRetry(fn, {
      sleep: async (ms) => {
        slept.push(ms);
      },
      retryAfterMs: () => 5_000,
    });

    expect(slept).toEqual([5_000]);
  });
});
