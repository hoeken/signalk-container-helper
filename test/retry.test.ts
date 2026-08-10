import { afterEach, describe, expect, it, vi } from "vitest";
import { anySignal, retryForever } from "../src/retry.js";
import { ContainerHelperError } from "../src/util.js";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Drain the microtask queue and every pending timer until `promise` settles.
 *
 * A plain `advanceTimersByTimeAsync` is not enough on its own: each attempt
 * awaits `fn()` before the next sleep is even scheduled, so the loop has to be
 * pumped rather than fast-forwarded in one jump.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  for (let i = 0; i < 100; i++) {
    const done = await Promise.race([
      result.then(() => true),
      Promise.resolve().then(() => false),
    ]);
    if (done) break;
    // Step past the largest backoff the suite uses, so one pump always clears
    // one sleep no matter where the loop is on the ladder.
    await vi.advanceTimersByTimeAsync(300_000);
  }
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

describe("retryForever", () => {
  it("returns the first success without sleeping", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(retryForever(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until the attempt succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fn = vi.fn(async () => {
      if (++attempts < 4) throw new Error(`attempt ${attempts}`);
      return "up";
    });

    await expect(settle(retryForever(fn))).resolves.toBe("up");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("doubles the delay to the ceiling and saturates there", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      if (++attempts < 7) throw new Error("nope");
      return "up";
    });

    await settle(
      retryForever(fn, {
        onAttemptFailed: (_err, nextDelayMs) => delays.push(nextDelayMs),
      }),
    );

    // Defaults: 15s doubling to a 120s ceiling, then flat.
    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000]);
  });

  it("honours custom bounds", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      if (++attempts < 5) throw new Error("nope");
      return "up";
    });

    await settle(
      retryForever(fn, {
        minDelayMs: 1_000,
        maxDelayMs: 4_000,
        onAttemptFailed: (_err, nextDelayMs) => delays.push(nextDelayMs),
      }),
    );

    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
  });

  it("reports the error and a 1-based attempt number on each failure", async () => {
    vi.useFakeTimers();
    const seen: Array<{ message: string; attempt: number }> = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      if (++attempts < 3) throw new Error(`boom-${attempts}`);
      return "up";
    });

    await settle(
      retryForever(fn, {
        onAttemptFailed: (err, _next, attempt) =>
          seen.push({ message: (err as Error).message, attempt }),
      }),
    );

    expect(seen).toEqual([
      { message: "boom-1", attempt: 1 },
      { message: "boom-2", attempt: 2 },
    ]);
  });

  it("stops when the signal aborts between attempts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let attempts = 0;
    const fn = vi.fn(async () => {
      if (++attempts === 2) controller.abort();
      throw new Error("always fails");
    });

    await expect(
      settle(retryForever(fn, { signal: controller.signal })),
    ).rejects.toMatchObject({ code: "cancelled" });
    // The abort lands during attempt 2, so no third attempt is made.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not run at all when the signal is already aborted", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(
      retryForever(fn, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("propagates a cancelled ContainerHelperError instead of retrying it", async () => {
    const fn = vi.fn(async () => {
      throw new ContainerHelperError("cancelled", "caller stopped it", true);
    });

    await expect(retryForever(fn)).rejects.toMatchObject({
      code: "cancelled",
    });
    // Retrying a cancellation would outlive the stop that caused it.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying other ContainerHelperError codes", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fn = vi.fn(async () => {
      if (++attempts < 3) {
        throw new ContainerHelperError("not-ready", "still booting", true);
      }
      return "up";
    });

    await expect(settle(retryForever(fn))).resolves.toBe("up");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rejects a non-finite or negative delay bound before the first attempt", async () => {
    const fn = vi.fn(async () => "ok");
    for (const bad of [NaN, Infinity, -1]) {
      await expect(retryForever(fn, { minDelayMs: bad })).rejects.toMatchObject(
        { code: "invalid-option" },
      );
      await expect(retryForever(fn, { maxDelayMs: bad })).rejects.toMatchObject(
        { code: "invalid-option" },
      );
    }
    // setTimeout(NaN) fires on the next tick, so an unvalidated bound would
    // turn the backoff into a hot spin rather than failing.
    expect(fn).not.toHaveBeenCalled();
  });

  it("aborts promptly during a long backoff instead of waiting it out", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("down");
    });

    const settled = retryForever(fn, {
      minDelayMs: 300_000,
      signal: controller.signal,
    }).then(
      () => "resolved",
      (e: { code?: string }) => e.code,
    );

    // Let the first attempt fail so the loop is parked in its backoff.
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    // No timer advance: the abort alone must settle it, or a stop() during a
    // retry would stall for up to the full ceiling delay.
    await expect(settled).resolves.toBe("cancelled");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("aborts promptly when onAttemptFailed aborts the signal itself", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("down");
    });

    // onAttemptFailed runs AFTER the loop's abort check, so the signal is
    // already aborted by the time the backoff starts. Registering an abort
    // listener at that point would never fire and the sleep would run its
    // full course — here, 300s.
    const settled = retryForever(fn, {
      minDelayMs: 300_000,
      signal: controller.signal,
      onAttemptFailed: () => controller.abort(),
    }).then(
      () => "resolved",
      (e: { code?: string }) => e.code,
    );

    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toBe("cancelled");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not hold the process open between attempts", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: () => void,
    ) => {
      cb();
      return { unref } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      let attempts = 0;
      await retryForever(async () => {
        if (++attempts < 2) throw new Error("nope");
        return "up";
      });
      // A retry loop that never gives up will almost always have a pending
      // timer at shutdown; a ref'd one would keep Signal K alive.
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("anySignal", () => {
  it("returns undefined when nothing is given", () => {
    expect(anySignal([])).toBeUndefined();
    expect(anySignal([undefined, undefined])).toBeUndefined();
  });

  it("passes a lone signal straight through", () => {
    const c = new AbortController();
    expect(anySignal([c.signal, undefined])).toBe(c.signal);
  });

  it("aborts when either input aborts", () => {
    for (const which of [0, 1]) {
      const a = new AbortController();
      const b = new AbortController();
      const combined = anySignal([a.signal, b.signal])!;
      expect(combined.aborted).toBe(false);
      [a, b][which]!.abort();
      expect(combined.aborted).toBe(true);
    }
  });

  it("is already aborted when any input was", () => {
    const live = new AbortController();
    expect(anySignal([AbortSignal.abort(), live.signal])!.aborted).toBe(true);
    expect(anySignal([live.signal, AbortSignal.abort()])!.aborted).toBe(true);
  });

  it("deduplicates a repeated signal rather than double-registering it", () => {
    const c = new AbortController();
    // Same signal twice collapses to the single-signal path.
    expect(anySignal([c.signal, c.signal])).toBe(c.signal);
  });

  it("detaches its listeners once it has fired", () => {
    const a = new AbortController();
    const b = new AbortController();
    const removeA = vi.spyOn(a.signal, "removeEventListener");
    const removeB = vi.spyOn(b.signal, "removeEventListener");

    anySignal([a.signal, b.signal]);
    a.abort();

    // Both sides detach, so a long-lived signal does not accumulate listeners
    // from every composition it took part in.
    expect(removeA).toHaveBeenCalled();
    expect(removeB).toHaveBeenCalled();
  });
});
