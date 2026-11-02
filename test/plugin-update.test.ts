import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLaterVersion,
  updateImageAfterPluginUpdate,
  type ImageAfterPluginUpdateOptions,
} from "../src/plugin-update.js";
import { ManagedContainer } from "../src/managed-container.js";
import { ContainerHelperError, classifyTag } from "../src/util.js";
// signalk-container's own classifier, which classifyTag() mirrors. A test may
// import the devDependency; the library itself never does.
import { classifyTag as canonicalClassifyTag } from "../node_modules/signalk-container/dist/updates/tagClassifier.js";
import {
  clearManager,
  installManager,
  makeApp,
  makeManager,
} from "./fixtures.js";

describe("isLaterVersion", () => {
  it("compares major, minor and patch as numbers", () => {
    expect(isLaterVersion("10.1.0", "9.4.3")).toBe(true);
    expect(isLaterVersion("9.4.3", "10.1.0")).toBe(false);
    expect(isLaterVersion("9.10.0", "9.9.9")).toBe(true);
    expect(isLaterVersion("9.4.3", "9.4.3")).toBe(false);
    expect(isLaterVersion("9.4", "9.4.0")).toBe(false);
    expect(isLaterVersion("v10.1.0", "9.4.3")).toBe(true);
  });

  it("takes a release for later than its pre-releases, and those in order", () => {
    expect(isLaterVersion("2.4.0", "2.4.0-beta.1")).toBe(true);
    expect(isLaterVersion("2.4.0-beta.1", "2.4.0")).toBe(false);
    expect(isLaterVersion("2.4.0-beta.10", "2.4.0-beta.9")).toBe(true);
    expect(isLaterVersion("2.4.0-beta.1", "2.3.2")).toBe(true);
    expect(isLaterVersion("2.4.0-beta.1", "2.4.0-beta.1")).toBe(false);
  });

  it("orders pre-releases by semver precedence", () => {
    expect(isLaterVersion("1.0.0-alpha.1", "1.0.0-alpha")).toBe(true);
    expect(isLaterVersion("1.0.0-alpha.0", "1.0.0-alpha")).toBe(true);
    expect(isLaterVersion("1.0.0-alpha", "1.0.0-alpha.1")).toBe(false);
    expect(isLaterVersion("1.0.0-alpha.beta", "1.0.0-alpha.1")).toBe(true);
    expect(isLaterVersion("1.0.0-beta", "1.0.0-alpha.beta")).toBe(true);
    expect(isLaterVersion("1.0.0-rc.1", "1.0.0-beta.11")).toBe(true);
  });

  it("ignores build metadata", () => {
    expect(isLaterVersion("1.2.10", "1.2.3+abc")).toBe(true);
    expect(isLaterVersion("1.2.3+build5", "1.2.3")).toBe(false);
    expect(isLaterVersion("1.2.3", "1.2.3+build5")).toBe(false);
  });

  it("compares parts with digits only as numbers", () => {
    // Number() would read "1e3" as 1000 and the two as equal; a name sorts
    // after a number instead, as in a pre-release.
    expect(isLaterVersion("1e3.0.0", "1000.0.0")).toBe(true);
    expect(isLaterVersion("1000.0.0", "1e3.0.0")).toBe(false);
  });
});

describe("classifyTag", () => {
  it("agrees with signalk-container's classifier", () => {
    const tags = [
      "latest",
      "LATEST",
      " latest ",
      "main",
      "master",
      "edge",
      "nightly",
      "stable",
      "dev",
      "rolling",
      "head",
      "trunk",
      "lts",
      "9",
      "v10",
      "V3",
      "9.4",
      "9.4.3",
      "v9.4.3",
      "9.4.3-rc1",
      "2.0.0-beta.1",
      "9.4.3.1",
      "9.4.3+build",
      "sha256:abc",
      "my-build",
      "10-alpine",
      "",
      "   ",
    ];
    for (const tag of tags) {
      expect([tag, classifyTag(tag)]).toEqual([tag, canonicalClassifyTag(tag)]);
    }
  });

  it("agrees with signalk-container's classifier on generated tags", () => {
    // A fixed seed, so a failure names a tag that fails again.
    const chars = "v0123456789.-_+ aLtesN";
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (let i = 0; i < 5000; i++) {
      let tag = "";
      for (let n = next() % 10; n > 0; n--) tag += chars[next() % chars.length];
      expect([tag, classifyTag(tag)]).toEqual([tag, canonicalClassifyTag(tag)]);
    }
  });

  it("tells floating tags, releases and the rest apart", () => {
    expect(classifyTag("latest")).toBe("floating");
    expect(classifyTag("Nightly")).toBe("floating");
    expect(classifyTag("9")).toBe("floating");
    expect(classifyTag("v10")).toBe("floating");
    expect(classifyTag("9.4.3")).toBe("semver");
    expect(classifyTag("v9.4")).toBe("semver");
    expect(classifyTag("9.4.3-rc1")).toBe("semver");
    expect(classifyTag("my-build")).toBe("unknown");
    expect(classifyTag("")).toBe("unknown");
  });
});

describe("updateImageAfterPluginUpdate", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "plugin-update-"));
    stateFile = join(dir, "image-check.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const recorded = async () => {
    try {
      return JSON.parse(await readFile(stateFile, "utf8")) as {
        pluginVersion: string;
      };
    } catch {
      return null;
    }
  };

  /**
   * A plugin updated from 2.3.2 to 2.4.0, on `latest`, with a container its
   * update moves from 9.4.3 to 10.1.0, on a free link.
   */
  const setup = async (over: Partial<ImageAfterPluginUpdateOptions> = {}) => {
    await writeFile(stateFile, JSON.stringify({ pluginVersion: "2.3.2" }));
    const manager = makeManager();
    manager.internet = { isRestricted: vi.fn(async () => false) };
    const fetchLatest = vi.fn(async () => ({
      kind: "version" as const,
      latest: "10.1.0",
    }));
    manager.updates.sources.githubReleases.mockReturnValue({
      fetch: fetchLatest,
    });
    let running = "9.4.3";
    const update = vi.fn(async () => {
      running = "10.1.0";
      return true;
    });
    const options: ImageAfterPluginUpdateOptions = {
      manager,
      pluginVersion: "2.4.0",
      stateFile,
      tag: "latest",
      versionSource: { githubReleases: "questdb/questdb" },
      currentVersion: async () => running,
      update,
      // Short, so waiting on the link and for a version takes no time here.
      linkRetryMs: 5,
      versionWaitMs: 20,
      signal: new AbortController().signal,
      ...over,
    };
    return { manager, options, update, fetchLatest };
  };

  it("updates to a later release, then records the plugin version", async () => {
    const { manager, options, update } = await setup();
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "updated",
    );
    expect(update).toHaveBeenCalledOnce();
    expect(manager.updates.sources.githubReleases).toHaveBeenCalledWith(
      "questdb/questdb",
      {},
    );
    expect(manager.internet!.isRestricted).toHaveBeenCalledWith({
      waitMs: 60_000,
      signal: options.signal,
    });
    expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
  });

  it("records the version without an update where the release is the latest", async () => {
    const { options, update } = await setup({
      currentVersion: async () => "10.1.0",
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "up-to-date",
    );
    expect(update).not.toHaveBeenCalled();
    expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
  });

  it("does nothing, not even ask for the link, without a plugin update", async () => {
    const { manager, options } = await setup({ pluginVersion: "2.3.2" });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "plugin-unchanged",
    );
    expect(manager.internet!.isRestricted).not.toHaveBeenCalled();
  });

  it("runs where no version was recorded, as on the first start", async () => {
    const { options } = await setup();
    await rm(stateFile);
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "updated",
    );
    expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
  });

  it("leaves a tag that is not floating as it is, and asks for nothing", async () => {
    for (const tag of ["9.4.3", "my-build"]) {
      const { manager, options, update } = await setup({ tag });
      await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
        "tag-not-floating",
      );
      expect(manager.internet!.isRestricted).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      // Not recorded: a later switch to `latest` is checked.
      expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
    }
  });

  it("waits on a restricted link, asking again until it is free", async () => {
    // As on a boat that boots before its modem is up.
    const { manager, options, update } = await setup();
    const answers = [true, true, false];
    const waits: Array<number | undefined> = [];
    const isRestricted = vi.fn(async (asked?: { waitMs?: number }) => {
      waits.push(asked?.waitMs);
      return answers.shift() ?? false;
    });
    manager.internet = { isRestricted };
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "updated",
    );
    // The first state may take a while after a restart; after that, ask.
    // Later asks wait a little too, which bounds the plugin-list read; the
    // last is the one right before the update.
    expect(waits).toEqual([60_000, 5_000, 5_000, 5_000]);
    expect(update).toHaveBeenCalledOnce();
  });

  it("asks for the link again right before the update", async () => {
    // Free while the versions are read, metered by the time of the pull.
    const { manager, options, update } = await setup();
    const answers = [false, true, false, false];
    let asks = 0;
    let asksBeforeUpdate = 0;
    manager.internet = {
      isRestricted: vi.fn(async () => {
        asks++;
        return answers.shift() ?? false;
      }),
    };
    update.mockImplementation(async () => {
      asksBeforeUpdate = asks;
      return true;
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "behind-after-update",
    );
    expect(update).toHaveBeenCalledOnce();
    expect(asksBeforeUpdate).toBe(4);
  });

  it("stops waiting on a restricted link once the signal aborts", async () => {
    const abort = new AbortController();
    const { manager, options, update, fetchLatest } = await setup({
      signal: abort.signal,
      linkRetryMs: 60_000,
    });
    manager.internet = { isRestricted: vi.fn(async () => true) };
    const outcome = updateImageAfterPluginUpdate(options);
    await vi.waitFor(() =>
      expect(manager.internet!.isRestricted).toHaveBeenCalled(),
    );
    abort.abort();
    await expect(outcome).resolves.toBe("aborted");
    expect(update).not.toHaveBeenCalled();
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("takes the link for restricted on a signalk-container that cannot tell", async () => {
    const { manager, options, update, fetchLatest } = await setup();
    delete manager.internet;
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "link-restricted",
    );
    expect(update).not.toHaveBeenCalled();
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("takes the link for restricted where asking for it fails, and asks again", async () => {
    const failing = [
      () => Promise.reject(new Error("stopping")),
      () => {
        throw new Error("not started");
      },
    ];
    for (const fail of failing) {
      const { manager, options, update, fetchLatest } = await setup();
      let calls = 0;
      let fetchedBeforeSecondAsk = false;
      const isRestricted = vi.fn(() => {
        calls++;
        if (calls === 1) return fail();
        if (calls === 2)
          fetchedBeforeSecondAsk = fetchLatest.mock.calls.length > 0;
        return Promise.resolve(false);
      });
      manager.internet = { isRestricted };
      await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
        "updated",
      );
      expect(fetchedBeforeSecondAsk).toBe(false);
      expect(isRestricted).toHaveBeenCalledTimes(3);
      expect(update).toHaveBeenCalledOnce();
    }
  });

  it("rejects a plugin version that is not one, and records nothing", async () => {
    for (const pluginVersion of ["", "next", "QuestDB plugin 2.4.0"]) {
      const { options, update } = await setup({ pluginVersion });
      await expect(updateImageAfterPluginUpdate(options)).rejects.toThrow(
        "Not a plugin version",
      );
      expect(update).not.toHaveBeenCalled();
      expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
    }
  });

  it("asks again where the running version is not one", async () => {
    // Taken for a name, "QuestDB 9.4.3" would sort above 10.1.0 and pass
    // for up to date.
    for (const reported of [
      "QuestDB 9.4.3",
      "dev",
      " ",
      "build 10",
      "9.4.3 (build 5)",
      "9.4.3-rc1 (build 5)",
      "9.4.3+any text",
      "9.4.3-",
    ]) {
      let reads = 0;
      let running = "9.4.3";
      const update = vi.fn(async () => {
        running = "10.1.0";
        return true;
      });
      const { options, fetchLatest } = await setup({
        currentVersion: async () => (reads++ === 0 ? reported : running),
        update,
      });
      await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
        "updated",
      );
      // Not before the running version reads as one.
      expect(fetchLatest).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
    }
  });

  it("asks again where the latest version is not one, or cannot be read", async () => {
    const answers = [
      async () => ({ kind: "version" as const, latest: "release-10.1" }),
      async () => ({ kind: "error" as const, error: "HTTP 403" }),
      () => Promise.reject(new Error("fetch failed")),
    ];
    for (const first of answers) {
      const { manager, options } = await setup();
      let calls = 0;
      const fetch = vi.fn(() =>
        calls++ === 0
          ? first()
          : Promise.resolve({ kind: "version" as const, latest: "10.1.0" }),
      );
      manager.updates.sources.githubReleases.mockReturnValue({ fetch });
      await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
        "updated",
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("asks again where the running version cannot be read", async () => {
    const failing = [
      async () => null,
      () => Promise.reject(new Error("not answering")),
      () => {
        throw new Error("no client");
      },
    ];
    for (const fail of failing) {
      let reads = 0;
      let running = "9.4.3";
      const { options } = await setup({
        currentVersion: () =>
          reads++ === 0 ? fail() : Promise.resolve(running),
        update: async () => {
          running = "10.1.0";
          return true;
        },
      });
      await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
        "updated",
      );
    }

    const noRuntime = await setup();
    noRuntime.manager.getRuntime.mockReturnValueOnce(null);
    await expect(updateImageAfterPluginUpdate(noRuntime.options)).resolves.toBe(
      "updated",
    );
  });

  it("stops asking for versions once the signal aborts, and records nothing", async () => {
    const abort = new AbortController();
    let reads = 0;
    const { options, update, fetchLatest } = await setup({
      signal: abort.signal,
      currentVersion: async () => {
        if (++reads === 3) abort.abort();
        return null;
      },
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "aborted",
    );
    expect(reads).toBe(3);
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("waits linkRetryMs between asks", async () => {
    const { manager, options } = await setup({ linkRetryMs: 150 });
    const asked: number[] = [];
    const answers = [true, false];
    manager.internet = {
      isRestricted: vi.fn(async () => {
        asked.push(Date.now());
        return answers.shift() ?? false;
      }),
    };
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "updated",
    );
    expect(asked).toHaveLength(3);
    expect(asked[1]! - asked[0]!).toBeGreaterThanOrEqual(140);
  });

  it("leaves no timer or abort listener behind while it waits, or after", async () => {
    const abort = new AbortController();
    const { manager, options } = await setup({ signal: abort.signal });
    let asks = 0;
    let listenersSeen = 0;
    manager.internet = {
      isRestricted: vi.fn(async () => {
        listenersSeen = Math.max(
          listenersSeen,
          getEventListeners(abort.signal, "abort").length,
        );
        if (++asks === 5) abort.abort();
        return true;
      }),
    };
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "aborted",
    );
    expect(asks).toBe(5);
    // Each wait removes its listener when it ends.
    expect(listenersSeen).toBe(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  it("caps a long retry rather than firing it at once, and clears it on abort", async () => {
    const abort = new AbortController();
    const { manager, options } = await setup({
      signal: abort.signal,
      linkRetryMs: 2 ** 40,
    });
    const isRestricted = vi.fn(async () => true);
    manager.internet = { isRestricted };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = updateImageAfterPluginUpdate(options);
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      // Uncapped, setTimeout would take 2^40 ms for 1 ms and ask again.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(isRestricted).toHaveBeenCalledOnce();
      abort.abort();
      await expect(outcome).resolves.toBe("aborted");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the state file under a temp name of its own, and leaves none", async () => {
    // Two checks on one file at once, as across a plugin restart.
    const first = await setup();
    const second = await setup();
    await expect(
      Promise.all([
        updateImageAfterPluginUpdate(first.options),
        updateImageAfterPluginUpdate(second.options),
      ]),
    ).resolves.toEqual(["updated", "updated"]);
    expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a duration that would make the timer fire at once", async () => {
    const invalid: Array<Partial<ImageAfterPluginUpdateOptions>> = [
      { linkWaitMs: 0 },
      { linkRetryMs: 0 },
      { linkRetryMs: Number.NaN },
      { linkRetryMs: Number.POSITIVE_INFINITY },
      { linkRetryMs: -1 },
      { linkWaitMs: -1 },
      { versionWaitMs: Number.NaN },
    ];
    for (const over of invalid) {
      const { options, update } = await setup(over);
      await expect(updateImageAfterPluginUpdate(options)).rejects.toThrow(
        "must be a number",
      );
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("records nothing where the update was not applied", async () => {
    // The container stays on 9.4.3 either way; only the answer differs.
    const { options } = await setup({ update: async () => false });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "not-applied",
    );
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("records the version where the container still runs an older release", async () => {
    // A bare-major tag that never reaches the latest, or a registry tag that
    // does not name it yet: checking again would recreate at every start.
    const update = vi.fn(async () => true);
    const { options } = await setup({ update });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "behind-after-update",
    );
    expect(update).toHaveBeenCalledOnce();
    expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "plugin-unchanged",
    );
    expect(update).toHaveBeenCalledOnce();
  });

  it("records the version where the container reports none after the update", async () => {
    let calls = 0;
    const { options } = await setup({
      currentVersion: async () => (calls++ === 0 ? "9.4.3" : null),
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "behind-after-update",
    );
    expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
  });

  it("leaves a container newer than the latest release alone", async () => {
    const { options, update } = await setup({
      currentVersion: async () => "10.2.0",
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "up-to-date",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("waits for the recreated container to report its version", async () => {
    let reported: string | null = "9.4.3";
    let reads = 0;
    const { options } = await setup({
      versionWaitMs: 5_000,
      currentVersion: async () => {
        // Not answering yet on the first read after the recreate.
        if (reported === "10.1.0" && reads++ === 0) return null;
        return reported;
      },
      update: async () => {
        reported = "10.1.0";
        return true;
      },
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "updated",
    );
    expect(reads).toBe(2);
  });

  it("waits for the recreated container to report the new version", async () => {
    // Still answering with the old release at first.
    let reads = 0;
    let updated = false;
    const { options } = await setup({
      versionWaitMs: 5_000,
      currentVersion: async () => (updated && reads++ > 0 ? "10.1.0" : "9.4.3"),
      update: async () => {
        updated = true;
        return true;
      },
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "updated",
    );
    expect(reads).toBe(2);
  });

  it("records an update, and ends, when the signal aborts while it waits for the version", async () => {
    const abort = new AbortController();
    let updated = false;
    const { options } = await setup({
      signal: abort.signal,
      versionWaitMs: 60_000,
      currentVersion: async () => {
        if (updated) abort.abort();
        return "9.4.3";
      },
      update: async () => {
        updated = true;
        return true;
      },
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "aborted",
    );
    expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
  });

  it("waits for the version by a clock the wall clock cannot move", async () => {
    // A GPS or NTP fix that jumps the clock a day ahead during the wait.
    let reads = 0;
    let updated = false;
    const { options } = await setup({
      versionWaitMs: 5_000,
      currentVersion: async () => {
        if (!updated) return "9.4.3";
        return reads++ === 0 ? null : "10.1.0";
      },
      update: async () => {
        updated = true;
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
        return true;
      },
    });
    try {
      await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
        "updated",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("returns aborted where update() throws as the signal aborts", async () => {
    // As ManagedContainer.applyUpdate() does when the plugin stops.
    const abort = new AbortController();
    const { options } = await setup({
      signal: abort.signal,
      update: async () => {
        abort.abort();
        throw new Error("cancelled");
      },
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "aborted",
    );
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("records an update applied while the signal aborts", async () => {
    // Not recorded, a tag that stays behind would recreate at the next start.
    const abort = new AbortController();
    const currentVersion = vi.fn(async () => "9.4.3");
    const { options } = await setup({
      signal: abort.signal,
      currentVersion,
      update: async () => {
        abort.abort();
        return true;
      },
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "aborted",
    );
    expect(currentVersion).toHaveBeenCalledOnce();
    expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
  });

  it("records nothing where the update was not applied as the signal aborted", async () => {
    const abort = new AbortController();
    const { options } = await setup({
      signal: abort.signal,
      update: async () => {
        abort.abort();
        return false;
      },
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "aborted",
    );
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("stops without reading versions once the signal aborts during the link check", async () => {
    const abort = new AbortController();
    const currentVersion = vi.fn(async () => "9.4.3");
    const { manager, options, update, fetchLatest } = await setup({
      signal: abort.signal,
      currentVersion,
    });
    // A known state comes back free whatever the signal says.
    manager.internet = {
      isRestricted: vi.fn(async () => {
        abort.abort();
        return false;
      }),
    };
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "aborted",
    );
    expect(currentVersion).not.toHaveBeenCalled();
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("stops before the update once the signal aborts while versions are read", async () => {
    const abort = new AbortController();
    const { options, update, fetchLatest } = await setup({
      signal: abort.signal,
      currentVersion: async () => {
        abort.abort();
        return "9.4.3";
      },
    });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "aborted",
    );
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("hands its signal to update()", async () => {
    const abort = new AbortController();
    const { options, update } = await setup({ signal: abort.signal });
    await updateImageAfterPluginUpdate(options);
    expect(update).toHaveBeenCalledWith(abort.signal);
  });

  it("does nothing for an older plugin version than the one recorded", async () => {
    const { manager, options } = await setup({ pluginVersion: "2.3.1" });
    await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
      "plugin-unchanged",
    );
    expect(manager.internet!.isRestricted).not.toHaveBeenCalled();
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("runs where the state file holds no version", async () => {
    for (const content of ["not json", "{}", '{"pluginVersion":"abc"}']) {
      const { options } = await setup();
      await writeFile(stateFile, content);
      await expect(updateImageAfterPluginUpdate(options)).resolves.toBe(
        "updated",
      );
      expect(await recorded()).toEqual({ pluginVersion: "2.4.0" });
    }
  });

  it("rejects before any update when the state file cannot be written", async () => {
    // Found only after the recreate, the file would let every start
    // recreate again.
    const { options, update } = await setup({
      stateFile: join(dir, "missing-dir", "image-check.json"),
    });
    await expect(updateImageAfterPluginUpdate(options)).rejects.toThrow(
      /ENOENT/,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("passes the wait and the signal on to the link check", async () => {
    const abort = new AbortController();
    const { manager, options } = await setup({
      linkWaitMs: 5_000,
      signal: abort.signal,
    });
    await updateImageAfterPluginUpdate(options);
    expect(manager.internet!.isRestricted).toHaveBeenCalledWith({
      waitMs: 5_000,
      signal: abort.signal,
    });
  });

  it("rejects when the update throws, and records nothing", async () => {
    const { options } = await setup({
      update: () => Promise.reject(new Error("pull failed")),
    });
    await expect(updateImageAfterPluginUpdate(options)).rejects.toThrow(
      "pull failed",
    );
    expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
  });

  it("leaves an operator's pin made while it waited, with the README recipe", async () => {
    // Issue #79: on a metered link the check waits; meanwhile "Update now"
    // pins 9.4.3. Once the link is free, the recipe must not move the
    // container back to `latest`.
    const { manager, options } = await setup();
    installManager(manager);
    try {
      const container = new ManagedContainer({
        app: makeApp(),
        pluginId: "test-plugin",
        name: "questdb",
        image: "questdb/questdb",
        buildConfig: (t) => ({ image: "questdb/questdb", tag: t }),
      });
      const tag = "latest";
      await container.start(tag);
      let restricted = true;
      manager.internet = { isRestricted: vi.fn(async () => restricted) };
      const update = async (signal: AbortSignal) => {
        try {
          await container.applyUpdate(tag, { pull: true, ifTag: tag, signal });
          return true;
        } catch (err) {
          if (
            err instanceof ContainerHelperError &&
            err.code === "tag-mismatch"
          ) {
            return false;
          }
          throw err;
        }
      };

      const check = updateImageAfterPluginUpdate({ ...options, tag, update });
      await vi.waitFor(() =>
        expect(manager.internet!.isRestricted).toHaveBeenCalled(),
      );
      await container.applyUpdate("9.4.3", { pull: true });
      restricted = false;

      await expect(check).resolves.toBe("not-applied");
      expect(container.lastStartedTag).toBe("9.4.3");
      expect(manager.recreate).toHaveBeenCalledTimes(1);
      // Not recorded: the next start reads the pinned tag and leaves it.
      expect(await recorded()).toEqual({ pluginVersion: "2.3.2" });
    } finally {
      clearManager();
    }
  });
});
