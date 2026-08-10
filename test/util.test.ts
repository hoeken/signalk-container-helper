import { describe, expect, it, vi } from "vitest";
import {
  ContainerHelperError,
  errMsg,
  isValidImageTag,
  startSafely,
} from "../src/util.js";
import { makeApp } from "./fixtures.js";

describe("isValidImageTag", () => {
  it("accepts typical tags", () => {
    for (const tag of [
      "latest",
      "1.2.3",
      "v1.2.3-rc.1",
      "main",
      "sha_2024",
      "9.0",
    ]) {
      expect(isValidImageTag(tag)).toBe(true);
    }
  });

  it("rejects dangerous or malformed values", () => {
    for (const tag of [
      "",
      " ",
      "a b",
      "tag;rm -rf /",
      "a/b",
      "a:b",
      "$(x)",
      null,
      42,
      "x".repeat(200),
    ]) {
      expect(isValidImageTag(tag as never)).toBe(false);
    }
  });
});

describe("errMsg", () => {
  it("unwraps Error messages and stringifies the rest", () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
    expect(errMsg("plain")).toBe("plain");
    expect(errMsg(42)).toBe("42");
  });

  it("unwraps the undici fetch-failed shape", () => {
    const cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:3010"),
      { code: "ECONNREFUSED" },
    );
    const err = new TypeError("fetch failed", { cause });
    expect(errMsg(err)).toBe(
      "fetch failed: connect ECONNREFUSED 127.0.0.1:3010",
    );
  });

  it("flattens a Happy-Eyeballs AggregateError cause", () => {
    const agg = new AggregateError([
      new Error("connect ECONNREFUSED 127.0.0.1:3010"),
      new Error("connect ECONNREFUSED ::1:3010"),
    ]);
    const err = new TypeError("fetch failed", { cause: agg });
    expect(errMsg(err)).toBe(
      "fetch failed: connect ECONNREFUSED 127.0.0.1:3010; connect ECONNREFUSED ::1:3010",
    );
  });

  it("keeps an AggregateError message when it carries one", () => {
    const agg = new AggregateError(
      [new Error("a"), new Error("b")],
      "both probes failed",
    );
    expect(errMsg(agg)).toBe("both probes failed: a; b");
  });

  it("renders non-Error causes", () => {
    expect(errMsg(new Error("write failed", { cause: "disk full" }))).toBe(
      "write failed: disk full",
    );
  });

  it("ignores a null cause", () => {
    expect(errMsg(new Error("boom", { cause: null }))).toBe("boom");
  });

  it("caps the cause chain depth", () => {
    let err = new Error("level-6");
    for (let i = 5; i >= 0; i--) {
      err = new Error(`level-${i}`, { cause: err });
    }
    const rendered = errMsg(err);
    expect(rendered).toContain("level-0");
    expect(rendered).toContain("level-4");
    expect(rendered).not.toContain("level-5");
  });

  it("caps recursion into nested AggregateErrors", () => {
    let agg = new AggregateError([new Error("leaf")], "level-6");
    for (let i = 5; i >= 0; i--) {
      agg = new AggregateError([agg], `level-${i}`);
    }
    const rendered = errMsg(agg);
    expect(rendered).toContain("level-0");
    expect(rendered).toContain("level-4");
    expect(rendered).not.toContain("leaf");
  });

  it("survives a cyclic AggregateError", () => {
    // AggregateError snapshots its errors at construction — a genuine cycle
    // needs the own-property override.
    const agg = new AggregateError([], "cycle");
    Object.defineProperty(agg, "errors", { value: [agg] });
    expect(errMsg(agg)).toContain("cycle");
  });

  it("renders both the errors and the cause of an AggregateError carrying both", () => {
    const agg = new AggregateError(
      [new Error("probe-a"), new Error("probe-b")],
      "all probes failed",
      { cause: new Error("dns lookup failed") },
    );
    expect(errMsg(agg)).toBe(
      "all probes failed: probe-a; probe-b: dns lookup failed",
    );
  });

  it("keeps an empty AggregateError falling through to its own message", () => {
    expect(errMsg(new AggregateError([], "nothing to see"))).toBe(
      "nothing to see",
    );
  });
});

describe("startSafely", () => {
  it("reports unexpected errors via setPluginError", async () => {
    const app = makeApp();
    startSafely(app, async () => {
      throw new Error("kaboom");
    });
    await vi.waitFor(() => {
      expect(app.setPluginError).toHaveBeenCalledWith("Startup failed: kaboom");
    });
  });

  it("does not re-report ContainerHelperErrors already reported", async () => {
    const app = makeApp();
    startSafely(app, async () => {
      throw new ContainerHelperError("no-runtime", "no runtime", true);
    });
    await vi.waitFor(() => {
      expect(app.debug).toHaveBeenCalled();
    });
    expect(app.setPluginError).not.toHaveBeenCalled();
  });

  it("re-reports ContainerHelperErrors not yet reported", async () => {
    const app = makeApp();
    startSafely(app, async () => {
      throw new ContainerHelperError("invalid-tag", "bad tag", false);
    });
    await vi.waitFor(() => {
      expect(app.setPluginError).toHaveBeenCalledWith(
        "Startup failed: bad tag",
      );
    });
  });
});
