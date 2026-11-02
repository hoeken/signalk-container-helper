import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { ManagedContainer } from "../src/managed-container.js";
import { ContainerHelperError } from "../src/util.js";
import type { ContainerConfig } from "../src/types.js";
import {
  clearManager,
  installManager,
  makeApp,
  makeManager,
  okFetch,
} from "./fixtures.js";

afterEach(() => {
  clearManager();
});

const IMAGE = "ghcr.io/example/service";

/** Local image ids by image ref or container name, as getImageDigest reads them. */
function imageIds(
  manager: ReturnType<typeof makeManager>,
  ids: Record<string, string>,
): void {
  (
    manager.getImageDigest as unknown as Mock<
      (ref: string) => Promise<string | null>
    >
  ).mockImplementation((ref) => Promise.resolve(ids[ref] ?? null));
}

function makeContainer(
  overrides: Partial<ConstructorParameters<typeof ManagedContainer>[0]> = {},
) {
  const app = makeApp();
  const buildConfig = vi.fn((tag: string): ContainerConfig => ({
    image: IMAGE,
    tag,
    restart: "unless-stopped",
    signalkAccessiblePorts: [9000],
  }));
  const container = new ManagedContainer({
    app,
    pluginId: "test-plugin",
    name: "test-service",
    image: IMAGE,
    buildConfig,
    managerTimeoutMs: 100,
    managerPollIntervalMs: 5,
    ...overrides,
  });
  return { app, buildConfig, container };
}

describe("ManagedContainer.start", () => {
  it("runs ensureRunning with the built config and default tag", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container, buildConfig } = makeContainer();

    const result = await container.start();

    expect(buildConfig).toHaveBeenCalledWith("latest");
    expect(manager.ensureRunning).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ image: IMAGE, tag: "latest" }),
      { pluginId: "test-plugin" },
    );
    expect(result.tag).toBe("latest");
    expect(result.address).toBeNull();
    expect(container.lastStartedTag).toBe("latest");
  });

  it("passes buildConfig's result to ensureRunning untouched", async () => {
    // Guards issue #35: signalkDataMount resolution belongs to
    // signalk-container, so the helper must never rewrite the config on its
    // way through. A "fix" that mutates mounts here would break drift
    // detection, which diffs against exactly what we send.
    const manager = makeManager();
    installManager(manager);
    const config: ContainerConfig = {
      image: IMAGE,
      tag: "latest",
      signalkDataMount: "/data",
      volumes: { "/extra": "/host/extra" },
    };
    const expected: ContainerConfig = {
      image: IMAGE,
      tag: "latest",
      signalkDataMount: "/data",
      volumes: { "/extra": "/host/extra" },
    };
    const { container } = makeContainer({ buildConfig: () => config });

    await container.start();

    const call = vi.mocked(manager.ensureRunning).mock.calls[0];
    expect(call?.[0]).toBe("test-service");
    // Same object, not a copy: nothing rewrote or re-wrapped the config.
    expect(call?.[1]).toBe(config);
    expect(call?.[2]).toEqual({ pluginId: "test-plugin" });
    // And it was not mutated in place on the way through.
    expect(config).toEqual(expected);
  });

  it("passes ensureOptions through", async () => {
    const manager = makeManager();
    installManager(manager);
    const onVolumeIssue = vi.fn();
    const { container } = makeContainer({ ensureOptions: { onVolumeIssue } });

    await container.start("1.0.0");

    expect(manager.ensureRunning).toHaveBeenCalledWith(
      "test-service",
      expect.anything(),
      { pluginId: "test-plugin", onVolumeIssue },
    );
  });

  it("lets an explicit ensureOptions.pluginId override the default", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer({
      ensureOptions: { pluginId: "@scope/other-owner" },
    });

    await container.start("1.0.0");

    expect(manager.ensureRunning).toHaveBeenCalledWith(
      "test-service",
      expect.anything(),
      { pluginId: "@scope/other-owner" },
    );
  });

  it("leaves out a plugin id signalk-container's manifest would reject", async () => {
    // The manifest only accepts lowercase npm-style names; passing anything
    // else would log a manifest error on every start.
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer({ pluginId: "MyPlugin" });

    await container.start("1.0.0");

    expect(manager.ensureRunning).toHaveBeenCalledWith(
      "test-service",
      expect.anything(),
      undefined,
    );
  });

  it("applies resolveTag mapping (auto → pinned)", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container, buildConfig } = makeContainer({
      resolveTag: (t) => (t === "auto" ? "2.5.0" : t),
    });

    const result = await container.start("auto");

    expect(buildConfig).toHaveBeenCalledWith("2.5.0");
    expect(result.tag).toBe("2.5.0");
  });

  it("self-heals via recreate when the live image differs", async () => {
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:0.9.0`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();

    await container.start("1.0.0");

    expect(manager.recreate).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ tag: "1.0.0" }),
      { pluginId: "test-plugin" },
    );
    expect(manager.ensureRunning).not.toHaveBeenCalled();
  });

  it("skips self-heal when the live image matches", async () => {
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:1.0.0`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();

    await container.start("1.0.0");

    expect(manager.recreate).not.toHaveBeenCalled();
    expect(manager.ensureRunning).toHaveBeenCalled();
  });

  it("skips self-heal when podman reports a Docker Hub short name qualified", async () => {
    // signalk-container qualifies `questdb/questdb` before creating it on
    // podman, which then lists it as `docker.io/questdb/questdb`. A raw string
    // compare recreated such a container on every start.
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: "docker.io/questdb/questdb:1.0.0",
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer({ image: "questdb/questdb" });

    await container.start("1.0.0");

    expect(manager.recreate).not.toHaveBeenCalled();
    expect(manager.ensureRunning).toHaveBeenCalled();
  });

  it("still self-heals a qualified Docker Hub image whose tag differs", async () => {
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: "docker.io/questdb/questdb:0.9.0",
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer({ image: "questdb/questdb" });

    await container.start("1.0.0");

    expect(manager.recreate).toHaveBeenCalled();
    expect(manager.ensureRunning).not.toHaveBeenCalled();
  });

  it("matches by name suffix (any namespace) when unprefixedName is absent", async () => {
    // The drifted image (0.1.0 vs requested 1.0.0) means the self-heal only
    // fires recreate if this container was actually found by suffix match.
    const manager = makeManager({
      containers: [
        { name: "sk-test-service", image: `${IMAGE}:0.1.0`, state: "running" },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();

    await container.start("1.0.0");

    expect(manager.recreate).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ image: IMAGE, tag: "1.0.0" }),
      { pluginId: "test-plugin" },
    );
  });

  it("matches under a non-default namespace (e.g. devpod-) without unprefixedName", async () => {
    // A hard-coded `sk-` guess would miss this container entirely and skip
    // the self-heal recreate. Suffix matching finds it regardless of prefix.
    const manager = makeManager({
      containers: [
        {
          name: "devpod-test-service",
          image: `${IMAGE}:0.1.0`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();

    await container.start("1.0.0");

    expect(manager.recreate).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ tag: "1.0.0" }),
      { pluginId: "test-plugin" },
    );
  });

  it("prefers unprefixedName over a suffix-matching decoy, regardless of order", async () => {
    // Decoy (suffix match, no unprefixedName) already at the desired image
    // appears FIRST; the real container (unprefixedName) has a drifted image.
    // Correct precedence recreates; picking the decoy would skip recreate.
    const manager = makeManager({
      containers: [
        {
          name: "other-test-service",
          image: `${IMAGE}:1.0.0`,
          state: "running",
        },
        {
          name: "devpod-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:0.1.0`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();

    await container.start("1.0.0");

    expect(manager.recreate).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ tag: "1.0.0" }),
      { pluginId: "test-plugin" },
    );
  });

  it("does not legacy-match a foreign container whose prefix contains a hyphen", async () => {
    // signalk-container namespaces are [a-z0-9]+ (no hyphen), so
    // `otherns-app-test-service` is some other plugin's container, not ours.
    // A naive `-test-service` suffix match would wrongly recreate it.
    const manager = makeManager({
      containers: [
        {
          name: "otherns-app-test-service",
          image: `${IMAGE}:0.1.0`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();

    await container.start("1.0.0");

    // No managed container found → no self-heal recreate; a clean start instead.
    expect(manager.recreate).not.toHaveBeenCalled();
    expect(manager.ensureRunning).toHaveBeenCalled();
  });

  it("treats a failed self-heal probe as non-fatal and falls back to ensureRunning", async () => {
    const manager = makeManager();
    manager.listContainers = vi.fn(async () => {
      throw new Error("list failed");
    }) as never;
    installManager(manager);
    const { app, container } = makeContainer();

    await container.start("1.0.0");

    expect(manager.ensureRunning).toHaveBeenCalled();
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("self-heal probe failed"),
    );
  });

  it("works against managers without recreate (pre-1.12.0)", async () => {
    const manager = makeManager({ withRecreate: false });
    installManager(manager);
    const { container } = makeContainer();

    await container.start("1.0.0");

    expect(manager.ensureRunning).toHaveBeenCalled();
  });

  it("reports and throws manager-unavailable when the global never appears", async () => {
    const { app, container } = makeContainer();

    const err = await container.start().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContainerHelperError);
    expect((err as ContainerHelperError).code).toBe("manager-unavailable");
    expect((err as ContainerHelperError).reported).toBe(true);
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("signalk-container"),
    );
  });

  it("reports and throws no-runtime when detection failed", async () => {
    installManager(makeManager({ runtime: null }));
    const { app, container } = makeContainer();

    const err = await container.start().catch((e: unknown) => e);

    expect((err as ContainerHelperError).code).toBe("no-runtime");
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("runtime"),
    );
  });

  it("rejects invalid tags before touching the runtime", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();

    const err = await container.start("bad;tag").catch((e: unknown) => e);

    expect((err as ContainerHelperError).code).toBe("invalid-tag");
    expect(manager.ensureRunning).not.toHaveBeenCalled();
  });

  it("registers with the update service using a live default currentTag", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer({
      updates: { versionSource: { githubReleases: "example/service" } },
    });

    await container.start("1.0.0");

    expect(manager.updates.register).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "test-plugin",
        containerName: "test-service",
        image: IMAGE,
      }),
    );
    const reg = (manager.updates.register as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      currentTag: () => string;
    };
    expect(reg.currentTag()).toBe("1.0.0");
    expect(manager.updates.sources.githubReleases).toHaveBeenCalledWith(
      "example/service",
      {},
    );
  });

  it("treats update registration failure as non-fatal", async () => {
    const manager = makeManager();
    manager.updates.register = vi.fn(() => {
      throw new Error("nope");
    }) as never;
    installManager(manager);
    const { app, container } = makeContainer({
      updates: { versionSource: { dockerHubTags: "example/service" } },
    });

    await expect(container.start("1.0.0")).resolves.toBeTruthy();
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("updates.register failed"),
    );
  });

  it("resolves the address and waits for HTTP readiness when configured", async () => {
    const manager = makeManager({ resolveAddress: "127.0.0.1:9010" });
    installManager(manager);
    const fetchImpl = okFetch();
    const { container } = makeContainer({
      readiness: { port: 9000, path: "/api/health", maxMs: 200, intervalMs: 5 },
      fetchImpl,
    });

    const result = await container.start("1.0.0");

    expect(manager.resolveContainerAddress).toHaveBeenCalledWith(
      "test-service",
      9000,
    );
    expect(result.address).toBe("http://127.0.0.1:9010");
    expect(container.address).toBe("http://127.0.0.1:9010");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9010/api/health",
      expect.anything(),
    );
  });

  it("falls back to listContainers port parsing when the resolver returns null", async () => {
    const manager = makeManager({
      resolveAddress: null,
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:1.0.0`,
          state: "running",
          ports: ["127.0.0.1:39000->9000/tcp", "0.0.0.0:8080->8080/tcp"],
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer({
      readiness: { port: 9000, maxMs: 200, intervalMs: 5 },
      fetchImpl: okFetch(),
    });

    const result = await container.start("1.0.0");

    expect(result.address).toBe("http://127.0.0.1:39000");
  });

  it("throws address-unresolved when no address can be found", async () => {
    const manager = makeManager({ resolveAddress: null, containers: [] });
    installManager(manager);
    const { container } = makeContainer({
      readiness: { port: 9000, maxMs: 50, intervalMs: 5 },
      fetchImpl: okFetch(),
    });

    const err = await container.start("1.0.0").catch((e: unknown) => e);

    expect((err as ContainerHelperError).code).toBe("address-unresolved");
  });

  it("throws not-ready when the app never answers", async () => {
    const manager = makeManager();
    installManager(manager);
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { container } = makeContainer({
      readiness: { port: 9000, maxMs: 30, intervalMs: 5 },
      fetchImpl,
    });

    const err = await container.start("1.0.0").catch((e: unknown) => e);

    expect((err as ContainerHelperError).code).toBe("not-ready");
  });
});

describe("ManagedContainer.stop", () => {
  it("unregisters updates then stops (not removes) the container", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer({
      updates: { versionSource: { githubReleases: "example/service" } },
    });
    await container.start("1.0.0");

    await container.stop();

    expect(manager.updates.unregister).toHaveBeenCalledWith("test-plugin");
    expect(manager.stop).toHaveBeenCalledWith("test-service");
    expect(manager.remove).not.toHaveBeenCalled();
    expect(container.address).toBeNull();
  });

  it("never throws, even when everything fails", async () => {
    const manager = makeManager();
    manager.stop = vi.fn(async () => {
      throw new Error("already stopped");
    }) as never;
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("1.0.0");

    await expect(container.stop()).resolves.toBeUndefined();
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("container stop failed"),
    );
  });

  it("is a no-op without a manager", async () => {
    const { container } = makeContainer();
    await expect(container.stop()).resolves.toBeUndefined();
  });

  it("leaves the container running on a server shutdown", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer({
      updates: { versionSource: { githubReleases: "example/service" } },
    });
    await container.start("1.0.0");

    await container.stop({ reason: "shutdown" });

    expect(manager.updates.unregister).toHaveBeenCalledWith("test-plugin");
    expect(manager.stop).not.toHaveBeenCalled();
  });

  // A restart may come back configured without a managed container, so it
  // stops like a disable.
  for (const reason of ["disable", "restart", "a-reason-not-known-yet"]) {
    it(`stops the container on ${reason}`, async () => {
      const manager = makeManager();
      installManager(manager);
      const { container } = makeContainer();
      await container.start("1.0.0");

      await container.stop({ reason });

      expect(manager.stop).toHaveBeenCalledWith("test-service");
    });
  }
});

describe("ManagedContainer.applyUpdate", () => {
  it("uses recreate when available", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");

    const result = await container.applyUpdate("2.0.0");

    expect(manager.recreate).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ tag: "2.0.0" }),
      { pluginId: "test-plugin" },
    );
    expect(manager.pullImage).not.toHaveBeenCalled();
    expect(result.tag).toBe("2.0.0");
    expect(container.lastStartedTag).toBe("2.0.0");
  });

  it("pulls the tag before the recreate when asked to", async () => {
    // recreate() pulls only an image missing from the host, so `latest`
    // would otherwise stay on the image it has.
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("latest");
    const order: string[] = [];
    (manager.pullImage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("pull");
    });
    (manager.recreate as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("recreate");
    });

    await container.applyUpdate("latest", { pull: true });

    expect(manager.pullImage).toHaveBeenCalledWith(`${IMAGE}:latest`);
    expect(order).toEqual(["pull", "recreate"]);
  });

  it("leaves the container as it is when the pull fails", async () => {
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:latest`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("latest");
    (manager.pullImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("offline"),
    );
    // The host's `latest` is the image the container already runs.
    imageIds(manager, {
      [`${IMAGE}:latest`]: "sha256:aaa",
      "sk-test-service": "sha256:aaa",
    });

    const err = await container
      .applyUpdate("latest", { pull: true })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContainerHelperError);
    expect(err).toMatchObject({ code: "pull-failed", reported: true });
    expect((err as Error).message).toContain("offline");
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining(`Could not pull ${IMAGE}:latest`),
    );
    expect(manager.recreate).not.toHaveBeenCalled();
  });

  it("does not recreate once the signal aborted during the pull", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("latest");
    const abort = new AbortController();
    (manager.pullImage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      abort.abort();
    });

    const err = await container
      .applyUpdate("latest", { pull: true, signal: abort.signal })
      .catch((e: unknown) => e);

    expect((err as ContainerHelperError).code).toBe("cancelled");
    expect(manager.recreate).not.toHaveBeenCalled();
  });

  it("pulls what the config runs, not the options' spelling", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container, buildConfig } = makeContainer();
    buildConfig.mockImplementation((tag: string) => ({
      image: "docker.io/test/image",
      tag,
    }));
    await container.start("latest");

    await container.applyUpdate("latest", { pull: true });

    expect(manager.pullImage).toHaveBeenCalledWith(
      "docker.io/test/image:latest",
    );
  });

  it("does not pull a config pinned to a digest", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container, buildConfig } = makeContainer();
    buildConfig.mockImplementation((tag: string) => ({
      image: IMAGE,
      tag,
      digest: "sha256:abc",
    }));
    await container.start("latest");

    await container.applyUpdate("latest", { pull: true });

    expect(manager.pullImage).not.toHaveBeenCalled();
    expect(manager.recreate).toHaveBeenCalled();
  });

  it("recreates on the host's image of another tag when its pull fails", async () => {
    // A rollback while offline.
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:2.0.0`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();
    await container.start("2.0.0");
    (manager.pullImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("offline"),
    );
    imageIds(manager, {
      [`${IMAGE}:1.0.0`]: "sha256:old",
      "sk-test-service": "sha256:new",
    });

    await container.applyUpdate("1.0.0", { pull: true });

    expect(manager.getImageDigest).toHaveBeenCalledWith(`${IMAGE}:1.0.0`);
    expect(manager.recreate).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ tag: "1.0.0" }),
      { pluginId: "test-plugin" },
    );
  });

  it("refuses an update before any start(), without pulling", async () => {
    // signalk-server mounts the routes of a disabled plugin too.
    const manager = makeManager();
    installManager(manager);
    const { app, container } = makeContainer();

    const err = await container
      .applyUpdate("latest", { pull: true })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "cancelled", reported: true });
    expect(app.setPluginError).not.toHaveBeenCalled();
    expect(manager.pullImage).not.toHaveBeenCalled();
    expect(manager.recreate).not.toHaveBeenCalled();
  });

  it("recreates where an update check already pulled the tag's new image", async () => {
    // podman lists the container under `latest` even once `latest` moved.
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:latest`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();
    await container.start("latest");
    (manager.pullImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("registry error"),
    );
    imageIds(manager, {
      [`${IMAGE}:latest`]: "sha256:new",
      "sk-test-service": "sha256:old",
    });

    await container.applyUpdate("latest", { pull: true });

    expect(manager.recreate).toHaveBeenCalled();
  });

  it("rejects as cancelled where the signal aborts while the fallback looks", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("latest");
    const abort = new AbortController();
    (manager.pullImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("offline"),
    );
    (manager.getImageDigest as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        abort.abort();
      },
    );

    const err = await container
      .applyUpdate("latest", { pull: true, signal: abort.signal })
      .catch((e: unknown) => e);

    expect((err as ContainerHelperError).code).toBe("cancelled");
    expect(manager.recreate).not.toHaveBeenCalled();
  });

  it("recreates on the host's image where a failed update left no container", async () => {
    // A recreate removes the container first; one that failed leaves none.
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");
    (manager.pullImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("offline"),
    );
    imageIds(manager, { [`${IMAGE}:1.0.0`]: "sha256:old" });

    await container.applyUpdate("1.0.0", { pull: true });

    expect(manager.recreate).toHaveBeenCalled();
  });

  it("lets a recreate without a pull run alongside a pulling update", async () => {
    // A device plugged in while an update pulls: neither cancels the other.
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("latest");
    let replug: Promise<unknown> | undefined;
    (manager.pullImage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      replug = container.applyUpdate("latest");
    });

    await container.applyUpdate("latest", { pull: true });
    await replug;

    expect(manager.recreate).toHaveBeenCalledTimes(2);
  });

  it("rejects with the pull's error where the host lacks the tag, or cannot tell", async () => {
    const live = [
      {
        name: "sk-test-service",
        unprefixedName: "test-service",
        image: `${IMAGE}:2.0.0`,
        state: "running" as const,
      },
    ];
    const answers: Array<(m: ReturnType<typeof makeManager>) => unknown> = [
      // The host has no image for the tag.
      (m) => imageIds(m, { "sk-test-service": "sha256:new" }),
      // The container's image cannot be read.
      (m) => imageIds(m, { [`${IMAGE}:1.0.0`]: "sha256:old" }),
      (m) =>
        (m.getImageDigest as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("socket closed"),
        ),
    ];
    for (const answer of answers) {
      const manager = makeManager({ containers: live });
      installManager(manager);
      const { container } = makeContainer();
      await container.start("2.0.0");
      (manager.pullImage as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("offline"),
      );
      answer(manager);

      await expect(
        container.applyUpdate("1.0.0", { pull: true }),
      ).rejects.toThrow("offline");
      expect(manager.recreate).not.toHaveBeenCalled();
    }
  });

  it("says it is pulling while it pulls", async () => {
    const manager = makeManager();
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("latest");
    let statusWhilePulling: unknown;
    (manager.pullImage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      statusWhilePulling = app.setPluginStatus.mock.calls.at(-1)?.[0];
    });

    await container.applyUpdate("latest", { pull: true });

    expect(statusWhilePulling).toBe(`Pulling ${IMAGE}:latest...`);
  });

  it("pulls once on a manager without recreate", async () => {
    const manager = makeManager({ withRecreate: false });
    installManager(manager);
    const { container } = makeContainer();
    await container.start("latest");

    await container.applyUpdate("latest", { pull: true });

    expect(manager.pullImage).toHaveBeenCalledTimes(1);
  });

  it("falls back to pull + remove + ensureRunning pre-1.12.0", async () => {
    const manager = makeManager({ withRecreate: false });
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");
    (manager.ensureRunning as ReturnType<typeof vi.fn>).mockClear();

    await container.applyUpdate("2.0.0");

    expect(manager.pullImage).toHaveBeenCalledWith(`${IMAGE}:2.0.0`);
    expect(manager.remove).toHaveBeenCalledWith("test-service");
    expect(manager.ensureRunning).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ tag: "2.0.0" }),
      { pluginId: "test-plugin" },
    );
  });

  it("surfaces the recreate-limbo error when the legacy path strands the container", async () => {
    const manager = makeManager({ withRecreate: false });
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("1.0.0");
    manager.ensureRunning = vi.fn(async () => {
      throw new Error("create failed");
    }) as never;

    const err = await container.applyUpdate("2.0.0").catch((e: unknown) => e);

    expect((err as ContainerHelperError).code).toBe("recreate-limbo");
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("Container removed but recreation failed"),
    );
  });

  it("validates the tag", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");

    const err = await container.applyUpdate("$(evil)").catch((e: unknown) => e);
    expect((err as ContainerHelperError).code).toBe("invalid-tag");
    expect(manager.recreate).not.toHaveBeenCalled();
  });
});

describe("errors from signalk-container", () => {
  it("reports a failed ensureRunning in start() as ensure-failed", async () => {
    const manager = makeManager();
    manager.ensureRunning.mockRejectedValue(new Error("port in use"));
    installManager(manager);
    const { app, container } = makeContainer();

    const err = await container.start("1.0.0").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContainerHelperError);
    expect(err).toMatchObject({ code: "ensure-failed", reported: true });
    expect((err as Error).message).toBe(
      `Could not start ${IMAGE}:1.0.0: port in use`,
    );
    expect(app.setPluginError).toHaveBeenCalledWith(
      `Could not start ${IMAGE}:1.0.0: port in use`,
    );
  });

  it("reports a start cancelled during a failing ensureRunning as cancelled", async () => {
    const manager = makeManager();
    const abort = new AbortController();
    manager.ensureRunning.mockImplementation(() => {
      abort.abort();
      return Promise.reject(new Error("port in use"));
    });
    installManager(manager);
    const { app, container } = makeContainer();

    const err = await container
      .start("1.0.0", { signal: abort.signal })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "cancelled" });
    expect(app.setPluginError).not.toHaveBeenCalled();
  });

  it("reports a failed recreate in applyUpdate() as recreate-failed", async () => {
    const manager = makeManager();
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("1.0.0");
    (manager.recreate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("create failed"),
    );

    const err = await container.applyUpdate("2.0.0").catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "recreate-failed", reported: true });
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("create failed"),
    );
    expect(container.lastStartedTag).toBe("1.0.0");
  });

  it("keeps recreate-failed where the signal aborted during the recreate", async () => {
    // "cancelled" promises the container was left as it was; this one may not
    // have been.
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");
    const abort = new AbortController();
    manager.recreate = vi.fn(() => {
      abort.abort();
      return Promise.reject(new Error("create failed"));
    }) as never;

    const err = await container
      .applyUpdate("2.0.0", { signal: abort.signal })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "recreate-failed" });
  });

  it("reports the legacy path's failed pull as pull-failed, before the remove", async () => {
    const manager = makeManager({ withRecreate: false });
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("1.0.0");
    manager.pullImage.mockRejectedValue(new Error("offline"));

    const err = await container.applyUpdate("2.0.0").catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "pull-failed", reported: true });
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("offline"),
    );
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it("cancels the legacy path where the signal aborted during its pull", async () => {
    for (const pullFails of [false, true]) {
      const manager = makeManager({ withRecreate: false });
      installManager(manager);
      const { app, container } = makeContainer();
      await container.start("1.0.0");
      const abort = new AbortController();
      manager.pullImage.mockImplementation(() => {
        abort.abort();
        return pullFails
          ? Promise.reject(new Error("offline"))
          : Promise.resolve();
      });

      const err = await container
        .applyUpdate("2.0.0", { signal: abort.signal })
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ code: "cancelled" });
      expect(app.setPluginError).not.toHaveBeenCalled();
      expect(manager.remove).not.toHaveBeenCalled();
    }
  });

  it("reports the legacy path's failed remove as recreate-failed", async () => {
    const manager = makeManager({ withRecreate: false });
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");
    (manager.ensureRunning as ReturnType<typeof vi.fn>).mockClear();
    manager.remove.mockRejectedValue(new Error("device busy"));

    const err = await container.applyUpdate("2.0.0").catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "recreate-failed", reported: true });
    expect((err as Error).message).toContain("device busy");
    expect(manager.ensureRunning).not.toHaveBeenCalled();
  });
});

/** A promise to settle by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function pullMock(manager: ReturnType<typeof makeManager>) {
  return manager.pullImage as unknown as Mock<(ref: string) => Promise<void>>;
}

describe("updates and the plugin lifecycle", () => {
  it("refuses an update after stop() and takes one after the next start()", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");
    await container.stop();

    await expect(container.applyUpdate("2.0.0")).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(manager.recreate).not.toHaveBeenCalled();

    await container.start("1.0.0");
    await container.applyUpdate("2.0.0");
    expect(manager.recreate).toHaveBeenCalledTimes(1);
  });

  it("does not make stop() wait for a pull, and then stands down", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("latest");
    const pull = deferred();
    manager.pullImage.mockImplementation(() => pull.promise);

    const update = container
      .applyUpdate("latest", { pull: true })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(manager.pullImage).toHaveBeenCalled());
    // Resolves while the pull is still running.
    await container.stop();
    expect(manager.stop).toHaveBeenCalledWith("test-service");

    pull.resolve();
    expect(await update).toMatchObject({ code: "cancelled", reported: true });
    expect(manager.recreate).not.toHaveBeenCalled();
  });

  it("cancels an update a restart overtook, though the plugin runs again", async () => {
    // A config save restarts the plugin: the update the old run asked for
    // must not recreate the container under the new configuration.
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("latest");
    const pull = deferred();
    manager.pullImage.mockImplementationOnce(() => pull.promise);

    const update = container
      .applyUpdate("latest", { pull: true })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(manager.pullImage).toHaveBeenCalled());
    await container.stop();
    await container.start("latest");
    pull.resolve();

    expect(await update).toMatchObject({ code: "cancelled" });
    expect(manager.recreate).not.toHaveBeenCalled();
    // One called after the restart applies.
    await container.applyUpdate("latest", { pull: true });
    expect(manager.recreate).toHaveBeenCalledTimes(1);
  });

  it("cancels an update a stop overtook while it waited for the lock", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");
    const busy = deferred();
    // A start that holds the lock while the update waits for it.
    manager.ensureRunning.mockImplementationOnce(() => busy.promise);
    const restart = container.start("1.0.0");

    const update = container.applyUpdate("2.0.0").catch((e: unknown) => e);
    const stopped = container.stop();
    busy.resolve();
    await restart;
    await stopped;

    expect(await update).toMatchObject({ code: "cancelled" });
    expect(manager.recreate).not.toHaveBeenCalled();
  });

  it("applies updates in call order, though a later pull would end first", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");
    const slow = deferred();
    pullMock(manager).mockImplementation((ref) =>
      ref.endsWith(":2.0.0") ? slow.promise : Promise.resolve(),
    );

    const first = container.applyUpdate("2.0.0", { pull: true });
    const second = container.applyUpdate("3.0.0", { pull: true });
    await vi.waitFor(() => expect(manager.pullImage).toHaveBeenCalled());
    // The second update waits for the first, pull included.
    expect(manager.pullImage).toHaveBeenCalledTimes(1);
    slow.resolve();
    await first;
    await second;

    expect(
      (manager.recreate as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => (c[1] as ContainerConfig).tag,
      ),
    ).toEqual(["2.0.0", "3.0.0"]);
    expect(container.lastStartedTag).toBe("3.0.0");
  });

  it("keeps a retrying start() retrying when an update fails before its recreate", async () => {
    vi.useFakeTimers();
    try {
      const manager = makeManager();
      manager.ensureRunning.mockRejectedValue(new Error("down"));
      // The host has no other image to fall back on.
      manager.pullImage.mockRejectedValue(new Error("offline"));
      installManager(manager);
      const { container } = makeContainer({
        readinessRetry: { minDelayMs: 100, maxDelayMs: 100 },
      });

      const started = container.start("1.0.0");
      started.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(150);

      await expect(
        container.applyUpdate("2.0.0", { pull: true }),
      ).rejects.toMatchObject({ code: "pull-failed" });
      manager.ensureRunning.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(500);

      await expect(started).resolves.toMatchObject({ tag: "1.0.0" });
      expect(manager.recreate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ManagedContainer queries", () => {
  it("checkForUpdate proxies updates.checkOne and returns null without a manager", async () => {
    const { container } = makeContainer();
    expect(await container.checkForUpdate()).toBeNull();

    const manager = makeManager();
    installManager(manager);
    const result = await container.checkForUpdate();
    expect(result?.updateAvailable).toBe(true);
    expect(manager.updates.checkOne).toHaveBeenCalledWith("test-plugin");
  });

  it("getInfo returns state and live image, never throwing", async () => {
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:1.0.0`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { container } = makeContainer();

    expect(await container.getInfo()).toEqual({
      state: "running",
      image: `${IMAGE}:1.0.0`,
    });
  });

  it("getInfo degrades to unknown without a manager", async () => {
    const { container } = makeContainer();
    expect(await container.getInfo()).toEqual({ state: "unknown", image: "" });
  });

  it("getLogs feature-detects and returns null when unsupported", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    expect(await container.getLogs({ tail: 50 })).toEqual(["line1", "line2"]);
    (manager as { getLogs?: unknown }).getLogs = undefined;
    expect(await container.getLogs()).toBeNull();
  });
});

describe("ManagedContainer.registerUpdateRoutes", () => {
  function makeRouter() {
    const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
    return {
      routes,
      get: vi.fn((path: string, handler: never) =>
        routes.set(`GET ${path}`, handler),
      ),
      post: vi.fn((path: string, handler: never) =>
        routes.set(`POST ${path}`, handler),
      ),
    };
  }

  function makeRes() {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
      },
    };
    return res;
  }

  it("mounts check and apply routes on the default base path", () => {
    const { container } = makeContainer();
    const router = makeRouter();
    container.registerUpdateRoutes(router as never);
    expect(router.routes.has("GET /api/update/check")).toBe(true);
    expect(router.routes.has("POST /api/update/apply")).toBe(true);
  });

  it("check returns 503 without a manager and the result with one", async () => {
    const { container } = makeContainer();
    const router = makeRouter();
    container.registerUpdateRoutes(router as never);
    const handler = router.routes.get("GET /api/update/check")!;

    const res503 = makeRes();
    await handler({}, res503);
    expect(res503.statusCode).toBe(503);

    installManager(makeManager());
    const resOk = makeRes();
    await handler({}, resOk);
    expect(resOk.statusCode).toBe(200);
    expect((resOk.body as { updateAvailable: boolean }).updateAvailable).toBe(
      true,
    );
  });

  it("apply recreates with the requested tag and reports both tags to onApplied", async () => {
    const manager = makeManager();
    installManager(manager);
    const onApplied = vi.fn();
    const { container } = makeContainer({
      resolveTag: (t) => (t === "auto" ? "3.0.0" : t),
    });
    await container.start("1.0.0");
    const router = makeRouter();
    container.registerUpdateRoutes(router as never, { onApplied });
    const handler = router.routes.get("POST /api/update/apply")!;

    const res = makeRes();
    await handler({ body: { tag: "auto" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, tag: "3.0.0" });
    expect(onApplied).toHaveBeenCalledWith("auto", "3.0.0");
  });

  it("apply pulls the resolved tag before the recreate", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer({
      resolveTag: (t) => (t === "auto" ? "3.0.0" : t),
    });
    await container.start("3.0.0");
    const router = makeRouter();
    container.registerUpdateRoutes(router as never);
    const handler = router.routes.get("POST /api/update/apply")!;

    const res = makeRes();
    await handler({ body: { tag: "auto" } }, res);

    expect(res.statusCode).toBe(200);
    expect(manager.pullImage).toHaveBeenCalledWith(`${IMAGE}:3.0.0`);
    expect(manager.recreate).toHaveBeenCalledWith(
      "test-service",
      expect.objectContaining({ tag: "3.0.0" }),
      { pluginId: "test-plugin" },
    );
  });

  it("apply reports a failed pull as 500 with a plugin error", async () => {
    const manager = makeManager({
      containers: [
        {
          name: "sk-test-service",
          unprefixedName: "test-service",
          image: `${IMAGE}:latest`,
          state: "running",
        },
      ],
    });
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("latest");
    (manager.pullImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("offline"),
    );
    const router = makeRouter();
    container.registerUpdateRoutes(router as never);
    const handler = router.routes.get("POST /api/update/apply")!;

    const res = makeRes();
    await handler({ body: {} }, res);

    expect(res.statusCode).toBe(500);
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringMatching(/^Update failed: Could not pull .*: offline$/),
    );
    expect(manager.recreate).not.toHaveBeenCalled();
  });

  it("apply answers 409 for a stopped plugin, without onApplied or a plugin error", async () => {
    const manager = makeManager();
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("1.0.0");
    await container.stop();
    const onApplied = vi.fn();
    const router = makeRouter();
    container.registerUpdateRoutes(router as never, { onApplied });
    const handler = router.routes.get("POST /api/update/apply")!;

    const res = makeRes();
    await handler({ body: { tag: "2.0.0" } }, res);

    expect(res.statusCode).toBe(409);
    expect(onApplied).not.toHaveBeenCalled();
    expect(app.setPluginError).not.toHaveBeenCalled();
    expect(manager.pullImage).not.toHaveBeenCalled();
  });

  it("apply answers 409 without onApplied when the plugin stops during the recreate", async () => {
    // onApplied would save the tag over settings a config save just wrote.
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();
    await container.start("1.0.0");
    let stopped: Promise<void> | undefined;
    (manager.recreate as ReturnType<typeof vi.fn>).mockImplementation(() => {
      stopped = container.stop();
    });
    const onApplied = vi.fn();
    const router = makeRouter();
    container.registerUpdateRoutes(router as never, { onApplied });
    const handler = router.routes.get("POST /api/update/apply")!;

    const res = makeRes();
    await handler({ body: { tag: "2.0.0" } }, res);
    await stopped;

    expect(manager.recreate).toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("not saved");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("apply rejects invalid tags with 400", async () => {
    installManager(makeManager());
    const { container } = makeContainer();
    const router = makeRouter();
    container.registerUpdateRoutes(router as never);
    const handler = router.routes.get("POST /api/update/apply")!;

    const res = makeRes();
    await handler({ body: { tag: "bad tag!" } }, res);
    expect(res.statusCode).toBe(400);
  });

  it("apply surfaces failures as 500 with the error message", async () => {
    const manager = makeManager();
    manager.recreate = vi.fn(async () => {
      throw new Error("pull failed");
    }) as never;
    installManager(manager);
    const { app, container } = makeContainer();
    await container.start("1.0.0");
    const router = makeRouter();
    container.registerUpdateRoutes(router as never);
    const handler = router.routes.get("POST /api/update/apply")!;

    const res = makeRes();
    await handler({ body: { tag: "2.0.0" } }, res);

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toContain("pull failed");
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("Update failed"),
    );
  });
});

describe("cancellation", () => {
  it("refuses to start when the signal is already aborted", async () => {
    const { container } = makeContainer();
    installManager(makeManager());

    await expect(
      container.start("1.0.0", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("does not call ensureRunning once aborted", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();

    await expect(
      container.start("1.0.0", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(manager.ensureRunning).not.toHaveBeenCalled();
  });

  it("marks the cancellation as already reported", async () => {
    // startSafely logs a reported error at debug instead of surfacing it via
    // setPluginError — a stop the caller asked for is not a startup failure.
    const { container, app } = makeContainer();
    installManager(makeManager());

    const err = await container
      .start("1.0.0", { signal: AbortSignal.abort() })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContainerHelperError);
    expect((err as ContainerHelperError).reported).toBe(true);
    expect(app.setPluginError).not.toHaveBeenCalled();
  });

  it("stops mid-start when aborted between steps", async () => {
    // ensureRunning itself is not interruptible (signalk-container takes no
    // signal there), so the abort lands at the next step boundary — before
    // readiness polling, which is where the minutes would otherwise go.
    const controller = new AbortController();
    const manager = makeManager();
    manager.ensureRunning.mockImplementation(async () => {
      controller.abort();
    });
    installManager(manager);
    const { container } = makeContainer({
      readiness: { port: 9000, maxMs: 60_000 },
    });

    await expect(
      container.start("1.0.0", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(manager.ensureRunning).toHaveBeenCalledOnce();
  });

  it("leaves start unaffected when no signal is passed", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();

    const result = await container.start("1.0.0");
    expect(result.tag).toBe("1.0.0");
    expect(manager.ensureRunning).toHaveBeenCalledOnce();
  });
});

describe("serialization", () => {
  it("runs an overlapping start and stop in order", async () => {
    // Without the chain both interleave against the same container: stop can
    // land between ensureRunning and readiness, leaving the plugin believing
    // it started something it just tore down.
    const order: string[] = [];
    const manager = makeManager();
    manager.ensureRunning.mockImplementation(async () => {
      order.push("start:begin");
      await new Promise((r) => setTimeout(r, 20));
      order.push("start:end");
    });
    manager.stop.mockImplementation(async () => {
      order.push("stop");
    });
    installManager(manager);
    const { container } = makeContainer();

    const started = container.start("1.0.0");
    const stopped = container.stop();
    await Promise.all([started, stopped]);

    expect(order).toEqual(["start:begin", "start:end", "stop"]);
  });

  it("does not wedge the chain when an operation rejects", async () => {
    const manager = makeManager();
    manager.ensureRunning.mockRejectedValueOnce(new Error("boom"));
    installManager(manager);
    const { container } = makeContainer();

    await expect(container.start("1.0.0")).rejects.toThrow("boom");
    // The next operation must still run rather than inheriting the rejection.
    await expect(container.start("1.0.0")).resolves.toMatchObject({
      tag: "1.0.0",
    });
  });
});

describe("ManagedContainer readinessRetry", () => {
  it("retries a failing bring-up until it succeeds", async () => {
    vi.useFakeTimers();
    try {
      const manager = makeManager();
      manager.ensureRunning
        .mockRejectedValueOnce(new Error("boot race"))
        .mockRejectedValueOnce(new Error("boot race"));
      installManager(manager);
      const onAttemptFailed = vi.fn();
      const { container } = makeContainer({
        readinessRetry: { minDelayMs: 1_000, maxDelayMs: 4_000 },
      });
      // Re-create with the spy attached (readinessRetry is read per start()).
      container.options.readinessRetry!.onAttemptFailed = onAttemptFailed;

      const started = container.start("1.0.0");
      const settled = started.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      for (let i = 0; i < 20; i++) {
        const done = await Promise.race([
          settled.then(() => true),
          Promise.resolve().then(() => false),
        ]);
        if (done) break;
        await vi.advanceTimersByTimeAsync(10_000);
      }

      await expect(started).resolves.toMatchObject({ tag: "1.0.0" });
      expect(manager.ensureRunning).toHaveBeenCalledTimes(3);
      expect(onAttemptFailed).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold the lock while sleeping, so stop() is not blocked", async () => {
    vi.useFakeTimers();
    try {
      const manager = makeManager();
      // Never succeeds: without per-attempt serialization the retry would own
      // the chain forever and stop() could never run.
      manager.ensureRunning.mockRejectedValue(new Error("always down"));
      installManager(manager);
      const controller = new AbortController();
      const { container } = makeContainer({
        readinessRetry: { minDelayMs: 1_000, maxDelayMs: 1_000 },
      });

      const started = container.start("1.0.0", { signal: controller.signal });
      started.catch(() => undefined);
      // Let a couple of attempts fail so the loop is mid-backoff.
      await vi.advanceTimersByTimeAsync(3_000);

      const stopped = container.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(stopped).resolves.toBeUndefined();
      expect(manager.stop).toHaveBeenCalledWith("test-service");

      controller.abort();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(started).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stands down when applyUpdate supersedes the retrying start", async () => {
    vi.useFakeTimers();
    try {
      const manager = makeManager();
      manager.ensureRunning.mockRejectedValue(new Error("down"));
      installManager(manager);
      const { container } = makeContainer({
        readinessRetry: { minDelayMs: 100, maxDelayMs: 100 },
      });

      const started = container.start("OLD");
      started.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(300);

      await container.applyUpdate("NEW");
      const before = manager.ensureRunning.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);

      // A loop still retrying OLD would restart the container on the image the
      // operator just moved away from — a silent revert of their update.
      expect(manager.ensureRunning.mock.calls.length).toBe(before);
      expect(container.lastStartedTag).toBe("NEW");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels when either the call signal or the retry signal aborts", async () => {
    for (const which of ["call", "retry"] as const) {
      vi.useFakeTimers();
      try {
        const manager = makeManager();
        manager.ensureRunning.mockRejectedValue(new Error("down"));
        installManager(manager);
        const retryAbort = new AbortController();
        const callAbort = new AbortController();
        const { container } = makeContainer({
          readinessRetry: {
            minDelayMs: 100,
            maxDelayMs: 100,
            signal: retryAbort.signal,
          },
        });

        const started = container.start("1.0.0", { signal: callAbort.signal });
        const settled = started.then(
          () => "resolved",
          (e: { code?: string }) => e.code,
        );
        await vi.advanceTimersByTimeAsync(250);
        (which === "call" ? callAbort : retryAbort).abort();
        await vi.advanceTimersByTimeAsync(500);

        await expect(settled).resolves.toBe("cancelled");
      } finally {
        vi.useRealTimers();
        clearManager();
      }
    }
  });

  it("is off by default — a failing start still rejects once", async () => {
    const manager = makeManager();
    manager.ensureRunning.mockRejectedValue(new Error("boom"));
    installManager(manager);
    const { container } = makeContainer();

    await expect(container.start("1.0.0")).rejects.toThrow("boom");
    expect(manager.ensureRunning).toHaveBeenCalledTimes(1);
  });
});

describe("ManagedContainer.getStateDetail", () => {
  it("passes the manager's detail through", async () => {
    const manager = makeManager();
    installManager(manager);
    const { container } = makeContainer();

    expect(await container.getStateDetail()).toEqual({
      state: "running",
      exitCode: 0,
      oomKilled: false,
      restartCount: 2,
    });
  });

  it("falls back to the coarse state on a manager without the method", async () => {
    // signalk-container < 1.31.0 has getState but not getStateDetail. The
    // caller still gets a usable `state`, with the extra fields undefined.
    const manager = makeManager({ withStateDetail: false });
    installManager(manager);
    const { container } = makeContainer();

    expect(await container.getStateDetail()).toEqual({ state: "running" });
  });

  it("reports no-runtime when the manager is absent", async () => {
    clearManager();
    const { container } = makeContainer();

    expect(await container.getStateDetail()).toEqual({ state: "no-runtime" });
  });

  it("never throws when the manager rejects", async () => {
    const manager = makeManager();
    manager.getStateDetail = vi.fn(async () => {
      throw new Error("daemon gone");
    });
    installManager(manager);
    const { container } = makeContainer();

    expect(await container.getStateDetail()).toEqual({ state: "no-runtime" });
  });
});
