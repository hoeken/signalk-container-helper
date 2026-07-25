import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatNumber,
  formatTimeAgo,
  formatUpdateMessage,
} from "../src/ui/format.js";
import type { UpdateCheckResult } from "../src/types.js";

function result(partial: Partial<UpdateCheckResult>): UpdateCheckResult {
  return {
    pluginId: "signalk-test",
    containerName: "test",
    runningTag: "latest",
    tagKind: "floating",
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    reason: "up-to-date",
    checkedAt: "2026-07-26T00:00:00Z",
    lastSuccessfulCheckAt: null,
    fromCache: false,
    ...partial,
  };
}

describe("ui/format: formatNumber", () => {
  it("passes small numbers through", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(999)).toBe("999");
  });

  it("abbreviates thousands and millions", () => {
    expect(formatNumber(1500)).toBe("1.5K");
    expect(formatNumber(2_340_000)).toBe("2.3M");
  });

  it("renders a dash for missing values", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
  });
});

describe("ui/format: formatTimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scales through seconds, minutes, hours, days", () => {
    expect(formatTimeAgo("2026-07-26T11:59:58Z")).toBe("just now");
    expect(formatTimeAgo("2026-07-26T11:59:20Z")).toBe("40s ago");
    expect(formatTimeAgo("2026-07-26T11:15:00Z")).toBe("45m ago");
    expect(formatTimeAgo("2026-07-26T06:00:00Z")).toBe("6h ago");
    expect(formatTimeAgo("2026-07-23T12:00:00Z")).toBe("3d ago");
  });

  it("clamps a server clock ahead of the client to 'just now'", () => {
    expect(formatTimeAgo("2026-07-26T12:00:05Z")).toBe("just now");
  });
});

describe("ui/format: formatUpdateMessage", () => {
  it("newer-version", () => {
    expect(
      formatUpdateMessage(
        result({
          reason: "newer-version",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          updateAvailable: true,
        }),
      ),
    ).toBe("Update available: 1.0.0 → 1.1.0");
  });

  it("digest-drift names the floating tag", () => {
    expect(
      formatUpdateMessage(
        result({
          reason: "digest-drift",
          runningTag: "latest",
          latestVersion: "1.1.0",
          updateAvailable: true,
        }),
      ),
    ).toBe("Image rebuild available for :latest (latest stable: 1.1.0)");
  });

  it("up-to-date on a floating tag mentions the stable version", () => {
    expect(
      formatUpdateMessage(
        result({
          reason: "up-to-date",
          tagKind: "floating",
          runningTag: "latest",
          latestVersion: "1.1.0",
        }),
      ),
    ).toBe("Up to date with :latest (latest stable: 1.1.0)");
  });

  it("up-to-date on a pinned tag uses the version", () => {
    expect(
      formatUpdateMessage(
        result({
          reason: "up-to-date",
          tagKind: "semver",
          runningTag: "1.1.0",
          currentVersion: "1.1.0",
        }),
      ),
    ).toBe("Up to date (1.1.0)");
  });

  it("older-than-pinned", () => {
    expect(
      formatUpdateMessage(
        result({
          reason: "older-than-pinned",
          currentVersion: "1.2.0",
          latestVersion: "1.1.0",
        }),
      ),
    ).toBe("Pinned to 1.2.0; latest stable is 1.1.0");
  });

  it("offline with a cached result reports the cache age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T12:00:00Z"));
    expect(
      formatUpdateMessage(
        result({
          reason: "offline",
          fromCache: true,
          lastSuccessfulCheckAt: "2026-07-26T09:00:00Z",
          updateAvailable: true,
        }),
      ),
    ).toBe("Offline — last checked 3h ago: update available");
    vi.useRealTimers();
  });

  it("offline without cache", () => {
    expect(formatUpdateMessage(result({ reason: "offline" }))).toBe(
      "Offline — never checked yet",
    );
  });

  it("error carries the message", () => {
    expect(
      formatUpdateMessage(result({ reason: "error", error: "boom" })),
    ).toBe("Check error: boom");
  });

  it("tolerates null/undefined input", () => {
    expect(formatUpdateMessage(null)).toBe("State: unknown");
    expect(formatUpdateMessage(undefined)).toBe("State: unknown");
  });
});
