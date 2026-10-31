import { describe, expect, it, vi } from "vitest";
import {
  listHostSerialDevices,
  SERIAL_BY_ID_DIR,
} from "../src/serial-devices.js";
import type {
  ContainerManagerApi,
  HostDeviceProbeResult,
} from "../src/types.js";

function manager(result: HostDeviceProbeResult | null): ContainerManagerApi {
  return {
    probeHostDevice: vi.fn(() => Promise.resolve(result)),
  } as unknown as ContainerManagerApi;
}

describe("listHostSerialDevices", () => {
  it("returns the links as full, sorted paths", async () => {
    const m = manager({
      exists: true,
      nodes: ["usb-Sonoff_Zigbee-if00-port0", "usb-FTDI_GPS-if00-port0"],
      groups: ["dialout"],
    });
    expect(await listHostSerialDevices(m)).toEqual([
      `${SERIAL_BY_ID_DIR}/usb-FTDI_GPS-if00-port0`,
      `${SERIAL_BY_ID_DIR}/usb-Sonoff_Zigbee-if00-port0`,
    ]);
    expect(m.probeHostDevice).toHaveBeenCalledWith(SERIAL_BY_ID_DIR);
  });

  it("returns an empty list when nothing is plugged in", async () => {
    const m = manager({ exists: false, nodes: [], groups: [] });
    expect(await listHostSerialDevices(m)).toEqual([]);
  });

  // null is "could not tell", which a caller must not read as "none".
  it("passes unknown through as null", async () => {
    expect(await listHostSerialDevices(manager(null))).toBeNull();
  });
});
