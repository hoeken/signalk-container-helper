import { describe, expect, it, vi } from "vitest";
import { probeHttpHealth, waitForHttpReady } from "../src/http.js";
import { flakyFetch, okFetch } from "./fixtures.js";

describe("waitForHttpReady", () => {
  it("resolves on first success", async () => {
    const fetchImpl = okFetch();
    await waitForHttpReady("http://x/health", {
      fetchImpl,
      maxMs: 200,
      intervalMs: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries failures until success", async () => {
    const fetchImpl = flakyFetch(2);
    await waitForHttpReady("http://x/health", {
      fetchImpl,
      maxMs: 2_000,
      intervalMs: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("treats non-2xx as not ready", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    await expect(
      waitForHttpReady("http://x/health", {
        fetchImpl,
        maxMs: 30,
        intervalMs: 5,
      }),
    ).rejects.toThrow(/did not become ready within 30ms.*HTTP 503/s);
  });

  it("throws with the last error after the deadline", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      waitForHttpReady("http://x/health", {
        fetchImpl,
        maxMs: 30,
        intervalMs: 5,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("probeHttpHealth", () => {
  it("returns reachable on a fast success", async () => {
    const result = await probeHttpHealth("http://x/health", {
      fetchImpl: okFetch(),
    });
    expect(result).toEqual({ reachable: true });
  });

  it("retries transient failures and succeeds", async () => {
    const fetchImpl = flakyFetch(1);
    const result = await probeHttpHealth("http://x/health", {
      fetchImpl,
      retryDelayMs: 1,
    });
    expect(result.reachable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("exhausts attempts and reports unreachable, never throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    const result = await probeHttpHealth("http://x/health", {
      fetchImpl,
      attempts: 3,
      retryDelayMs: 1,
    });
    expect(result).toEqual({ reachable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("counts non-2xx as a failed attempt", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    const result = await probeHttpHealth("http://x/health", {
      fetchImpl,
      attempts: 2,
      retryDelayMs: 1,
    });
    expect(result.reachable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("flags a slow success with the elapsed time", async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const result = await probeHttpHealth("http://x/health", {
      fetchImpl,
      slowMs: 5,
    });
    expect(result.reachable).toBe(true);
    expect(result.slowMs).toBeGreaterThanOrEqual(15);
  });
});
