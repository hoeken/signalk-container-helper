import { describe, expect, it } from "vitest";
import { resolveMount } from "../src/host-path.js";
import { ContainerHelperError } from "../src/util.js";
import type { ContainerManagerApi } from "../src/types.js";
import { makeManager } from "./fixtures.js";

const DATA_DIR = "/home/x/.signalk/plugin-config-data/my-plugin";

function asApi(manager: ReturnType<typeof makeManager>): ContainerManagerApi {
  return manager as unknown as ContainerManagerApi;
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<ContainerHelperError> {
  try {
    await promise;
  } catch (err) {
    const e = err as ContainerHelperError;
    expect(e).toBeInstanceOf(ContainerHelperError);
    expect(e.code).toBe(code);
    // Not pre-reported: resolveMount has no app to setPluginError with.
    expect(e.reported).toBe(false);
    return e;
  }
  throw new Error(`expected ${code} to be thrown`);
}

describe("resolveMount", () => {
  it("passes a bind-mount resolution through unchanged", async () => {
    const manager = makeManager({
      hostPath: { source: DATA_DIR, subPath: "" },
    });

    const mount = await resolveMount(asApi(manager), {
      containerPath: "/data",
      hostPath: DATA_DIR,
    });

    expect(mount).toEqual({
      source: DATA_DIR,
      subPath: "",
      containerPath: "/data",
    });
    expect(manager.resolveHostPath).toHaveBeenCalledWith(DATA_DIR);
  });

  it("joins subPath into containerPath for a named volume", async () => {
    // Runtimes reject `-v volume/sub:/dest`, so the mount root is the volume
    // and the plugin's dir sits inside it. A consumer using the bare mount
    // point would silently read the volume root.
    const manager = makeManager({
      hostPath: {
        source: "signalk-config",
        subPath: "plugin-config-data/my-plugin",
      },
    });

    const mount = await resolveMount(asApi(manager), {
      containerPath: "/data",
      hostPath: DATA_DIR,
    });

    expect(mount.source).toBe("signalk-config");
    expect(mount.containerPath).toBe("/data/plugin-config-data/my-plugin");
  });

  it("does not double a trailing slash on containerPath", async () => {
    const manager = makeManager({
      hostPath: { source: "vol", subPath: "inner" },
    });

    const mount = await resolveMount(asApi(manager), {
      containerPath: "/data/",
      hostPath: DATA_DIR,
    });

    expect(mount.containerPath).toBe("/data/inner");
  });

  it("throws unsupported-manager when resolveHostPath is absent", async () => {
    const manager = makeManager({ withResolveHostPath: false });

    const err = await expectCode(
      resolveMount(asApi(manager), {
        containerPath: "/data",
        hostPath: DATA_DIR,
      }),
      "unsupported-manager",
    );
    expect(err.message).toContain("1.7.0");
  });

  it("throws path-unreachable when no mount covers the path", async () => {
    const manager = makeManager({ hostPath: null });

    const err = await expectCode(
      resolveMount(asApi(manager), {
        containerPath: "/data",
        hostPath: DATA_DIR,
      }),
      "path-unreachable",
    );
    expect(err.message).toContain(DATA_DIR);
  });

  it("rejects a relative hostPath without calling the resolver", async () => {
    const manager = makeManager();

    await expectCode(
      resolveMount(asApi(manager), {
        containerPath: "/data",
        hostPath: "relative/dir",
      }),
      "invalid-option",
    );
    expect(manager.resolveHostPath).not.toHaveBeenCalled();
  });

  it("rejects a relative containerPath without calling the resolver", async () => {
    const manager = makeManager();

    await expectCode(
      resolveMount(asApi(manager), {
        containerPath: "data",
        hostPath: DATA_DIR,
      }),
      "invalid-option",
    );
    expect(manager.resolveHostPath).not.toHaveBeenCalled();
  });
});
