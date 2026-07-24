import { afterEach, describe, expect, it, vi } from "vitest";
import { AdoptedContainer } from "../src/adopted-container.js";
import {
  clearManager,
  installManager,
  makeApp,
  makeManager,
} from "./fixtures.js";

afterEach(() => {
  clearManager();
});

function makeAdopted(
  overrides: Partial<ConstructorParameters<typeof AdoptedContainer>[0]> = {},
) {
  const app = makeApp();
  const adopted = new AdoptedContainer({
    app,
    pluginId: "test-plugin",
    containerName: "test-engine",
    image: "ghcr.io/example/engine",
    currentTag: "latest",
    versionSource: { githubReleases: "example/engine" },
    checkInterval: "24h",
    managerTimeoutMs: 60,
    managerPollIntervalMs: 5,
    ...overrides,
  });
  return { app, adopted };
}

describe("AdoptedContainer.register", () => {
  it("registers with the update service and returns true", async () => {
    const manager = makeManager();
    installManager(manager);
    const currentVersion = vi.fn(async () => "1.0.0");
    const { adopted } = makeAdopted({ currentVersion });

    expect(await adopted.register()).toBe(true);

    expect(manager.updates.register).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "test-plugin",
        containerName: "test-engine",
        image: "ghcr.io/example/engine",
        checkInterval: "24h",
        currentVersion,
      }),
    );
    const reg = (manager.updates.register as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      currentTag: () => string;
    };
    expect(reg.currentTag()).toBe("latest");
  });

  it("accepts a live currentTag getter", async () => {
    const manager = makeManager();
    installManager(manager);
    let tag = "latest";
    const { adopted } = makeAdopted({ currentTag: () => tag });

    await adopted.register();

    const reg = (manager.updates.register as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      currentTag: () => string;
    };
    tag = "2.0.0";
    expect(reg.currentTag()).toBe("2.0.0");
  });

  it("reports missing manager via setPluginError and returns false", async () => {
    const { app, adopted } = makeAdopted();

    expect(await adopted.register()).toBe(false);
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("signalk-container is not loaded"),
    );
  });

  it("reports missing runtime distinctly and returns false", async () => {
    installManager(makeManager({ runtime: null }));
    const { app, adopted } = makeAdopted();

    expect(await adopted.register()).toBe(false);
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("No container runtime detected"),
    );
  });

  it("reports registration failure and returns false, never throwing", async () => {
    const manager = makeManager();
    manager.updates.register = vi.fn(() => {
      throw new Error("bad registration");
    }) as never;
    installManager(manager);
    const { app, adopted } = makeAdopted();

    expect(await adopted.register()).toBe(false);
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("update registration failed"),
    );
  });
});

describe("AdoptedContainer.unregister", () => {
  it("unregisters after a successful register and never throws", async () => {
    const manager = makeManager();
    installManager(manager);
    const { adopted } = makeAdopted();
    await adopted.register();

    adopted.unregister();
    expect(manager.updates.unregister).toHaveBeenCalledWith("test-plugin");
  });

  it("is a no-op when never registered", () => {
    const manager = makeManager();
    installManager(manager);
    const { adopted } = makeAdopted();

    adopted.unregister();
    expect(manager.updates.unregister).not.toHaveBeenCalled();
  });

  it("swallows unregister errors", async () => {
    const manager = makeManager();
    manager.updates.unregister = vi.fn(() => {
      throw new Error("gone");
    }) as never;
    installManager(manager);
    const { app, adopted } = makeAdopted();
    await adopted.register();

    expect(() => adopted.unregister()).not.toThrow();
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("unregister failed"),
    );
  });
});

describe("AdoptedContainer.checkForUpdate", () => {
  it("returns null without a manager, the result with one", async () => {
    const { adopted } = makeAdopted();
    expect(await adopted.checkForUpdate()).toBeNull();

    installManager(makeManager());
    const result = await adopted.checkForUpdate();
    expect(result?.updateAvailable).toBe(true);
  });
});
