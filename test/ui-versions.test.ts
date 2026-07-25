import { describe, it, expect } from "vitest";
import {
  deriveVersionsView,
  shownTags,
  runningTagFallback,
  splitVersions,
} from "../src/ui/versions.js";

describe("ui/versions: deriveVersionsView", () => {
  it("full success: returns the versions and no error line", () => {
    const v = deriveVersionsView(true, {
      versions: [
        { tag: "v3.4.0", prerelease: false },
        { tag: "pr429", pr: 429, title: "north-up fix" },
      ],
      sources: { releases: "ok", prImages: "ok" },
    });
    expect(v.versions).toEqual([
      { tag: "v3.4.0", prerelease: false },
      { tag: "pr429", pr: 429, title: "north-up fix" },
    ]);
    expect(v.versionsError).toBe("");
  });

  it("accepts the legacy bare-array body", () => {
    const v = deriveVersionsView(true, [
      { tag: "1.2.3", prerelease: false },
      { tag: "1.3.0-rc1", prerelease: true },
    ]);
    expect(v.versions).toEqual([
      { tag: "1.2.3", prerelease: false },
      { tag: "1.3.0-rc1", prerelease: true },
    ]);
    expect(v.versionsError).toBe("");
  });

  it("rate-limited PR images: keeps releases, names PR test images", () => {
    const v = deriveVersionsView(true, {
      versions: [{ tag: "v3.4.0", prerelease: false }],
      sources: { releases: "ok", prImages: "rate-limited" },
    });
    expect(v.versions).toEqual([{ tag: "v3.4.0", prerelease: false }]);
    expect(v.versionsError).toMatch(/rate-limited/);
    // Distinct from a generic error so the operator knows to retry, not
    // that no PR images exist.
    expect(v.versionsError).toContain("PR test images");
  });

  it("generic error is distinct from rate-limited", () => {
    const v = deriveVersionsView(true, {
      versions: [{ tag: "v3.4.0", prerelease: false }],
      sources: { releases: "ok", prImages: "error" },
    });
    expect(v.versionsError).toContain("Could not fetch");
    expect(v.versionsError).not.toMatch(/rate-limited/);
  });

  it("rate-limited releases does not falsely blame PR test images", () => {
    const v = deriveVersionsView(true, {
      versions: [],
      sources: { releases: "rate-limited", prImages: "ok" },
    });
    expect(v.versionsError).toMatch(/rate-limited/);
    expect(v.versionsError).toContain("some versions");
    expect(v.versionsError).not.toContain("PR test images");
  });

  it("does not throw on a malformed 200 body", () => {
    for (const body of [null, undefined, 42, "nope", {}]) {
      const v = deriveVersionsView(true, body);
      expect(v.versions).toEqual([]);
      expect(v.versionsError).toBe("");
    }
  });

  it("non-ok response: null list (keep prior) and a retry line", () => {
    const v = deriveVersionsView(false, { error: "bad gateway" });
    expect(v.versions).toBeNull();
    expect(v.versionsError).toContain("last known versions");
  });
});

const RELEASES = [
  { tag: "v3.4.0", prerelease: false },
  { tag: "v3.3.0", prerelease: false },
  { tag: "v3.2.0", prerelease: false },
  { tag: "v3.1.0", prerelease: false },
  { tag: "v3.0.0", prerelease: false },
  { tag: "v2.9.0", prerelease: false },
  { tag: "v3.5.0-rc1", prerelease: true },
  { tag: "pr429", pr: 429, title: "north-up fix" },
];

describe("ui/versions: splitVersions", () => {
  it("buckets PR images, stable, and pre-releases with default limits", () => {
    const { prVersions, stableVersions, preVersions } = splitVersions(RELEASES);
    expect(prVersions.map((v) => v.tag)).toEqual(["pr429"]);
    expect(stableVersions.map((v) => v.tag)).toEqual([
      "v3.4.0",
      "v3.3.0",
      "v3.2.0",
      "v3.1.0",
      "v3.0.0",
    ]);
    expect(preVersions.map((v) => v.tag)).toEqual(["v3.5.0-rc1"]);
  });

  it("honors custom slice limits", () => {
    const { stableVersions, preVersions } = splitVersions(RELEASES, {
      stableCount: 2,
      preCount: 0,
    });
    expect(stableVersions.map((v) => v.tag)).toEqual(["v3.4.0", "v3.3.0"]);
    expect(preVersions).toEqual([]);
  });
});

describe("ui/versions: shownTags / runningTagFallback", () => {
  it("includes the floating tags and every bucketed tag", () => {
    const tags = shownTags(RELEASES, ["latest", "main"]);
    for (const t of ["latest", "main", "v3.4.0", "v3.5.0-rc1", "pr429"]) {
      expect(tags.has(t)).toBe(true);
    }
    // v2.9.0 fell out of the top-5 stable slice
    expect(tags.has("v2.9.0")).toBe(false);
  });

  it("no fallback when the running tag is rendered", () => {
    expect(runningTagFallback("latest", RELEASES, ["latest"])).toBeNull();
    expect(runningTagFallback("v3.4.0", RELEASES)).toBeNull();
    expect(runningTagFallback("pr429", RELEASES)).toBeNull();
  });

  it("falls back for a tag missing from the rendered options", () => {
    // a pr<N> whose /pulls fetch was rate-limited
    expect(runningTagFallback("pr500", RELEASES)).toBe("pr500");
    // a stable pin that fell out of the top-N
    expect(runningTagFallback("v2.9.0", RELEASES)).toBe("v2.9.0");
    // "main" is only shown when declared as a floating option
    expect(runningTagFallback("main", RELEASES, ["latest"])).toBe("main");
    expect(runningTagFallback("main", RELEASES, ["latest", "main"])).toBeNull();
  });

  it("empty value never needs a fallback", () => {
    expect(runningTagFallback("", RELEASES)).toBeNull();
    expect(runningTagFallback(null, RELEASES)).toBeNull();
    expect(runningTagFallback(undefined, RELEASES)).toBeNull();
  });

  it("fallback respects custom slice limits", () => {
    expect(
      runningTagFallback("v3.3.0", RELEASES, ["latest"], { stableCount: 1 }),
    ).toBe("v3.3.0");
  });
});
