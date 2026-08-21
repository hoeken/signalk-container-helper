import { describe, expect, it, vi } from "vitest";
import { probeHostDevice } from "../src/host-device.js";
import { ContainerHelperError } from "../src/util.js";
import type { ContainerManagerApi } from "../src/types.js";

const found = { exists: true, nodes: ["card0"], groups: ["video"] };

function manager(over: Partial<ContainerManagerApi> = {}): ContainerManagerApi {
  return {
    probeHostDevice: vi.fn(() => Promise.resolve(found)),
    ...over,
  } as unknown as ContainerManagerApi;
}

describe("probeHostDevice", () => {
  it("passes the result through", async () => {
    expect(await probeHostDevice(manager(), "/dev/dri")).toEqual(found);
  });

  it("forwards the path to the manager", async () => {
    const m = manager();
    await probeHostDevice(m, "/dev/dri");
    expect(m.probeHostDevice).toHaveBeenCalledWith("/dev/dri");
  });

  // null is "unknown", not "absent" — the distinction a caller must not lose.
  it("passes null through unchanged", async () => {
    const m = manager({ probeHostDevice: vi.fn(() => Promise.resolve(null)) });
    expect(await probeHostDevice(m, "/dev/dri")).toBeNull();
  });

  it("passes a definite absence through unchanged", async () => {
    const absent = { exists: false, nodes: [], groups: [] };
    const m = manager({
      probeHostDevice: vi.fn(() => Promise.resolve(absent)),
    });
    expect(await probeHostDevice(m, "/dev/dri")).toEqual(absent);
  });

  it("rejects a relative path rather than asking about an ambiguous one", async () => {
    await expect(probeHostDevice(manager(), "dev/dri")).rejects.toThrow(
      /must be absolute/,
    );
  });

  it("reports an old signalk-container as unsupported, not as no device", async () => {
    const m = manager({ probeHostDevice: undefined });
    await expect(probeHostDevice(m, "/dev/dri")).rejects.toBeInstanceOf(
      ContainerHelperError,
    );
    await expect(probeHostDevice(m, "/dev/dri")).rejects.toThrow(/1\.30\.0/);
  });
});
