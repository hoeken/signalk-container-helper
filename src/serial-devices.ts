/**
 * Finding USB serial devices on the host by name.
 *
 * udev gives every USB serial device a link in `/dev/serial/by-id` named after
 * its vendor, product and serial number
 * (`usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_…-if00-port0`), and removes it
 * when the device is unplugged. That name is what lets a plugin recognise its
 * hardware without asking the user for a path, and the link is the path to
 * hand to the container: it survives a replug that changes the ttyUSB number.
 */

import { probeHostDevice } from "./host-device.js";
import type { ContainerManagerApi } from "./types.js";

export const SERIAL_BY_ID_DIR = "/dev/serial/by-id";

/**
 * The `/dev/serial/by-id` links on the host, as full paths, sorted.
 *
 * Returns `[]` when no USB serial device is plugged in, and **null when the
 * host could not be asked** — see {@link probeHostDevice}. With nothing
 * plugged in udev removes the directory itself, which a containerized Signal K
 * cannot mount, so there null usually means "none". A containerized Signal K
 * needs signalk-container 1.37.2 or later; older ones list nothing.
 *
 * @throws ContainerHelperError `unsupported-manager` on signalk-container
 * older than 1.30.0.
 */
export async function listHostSerialDevices(
  manager: ContainerManagerApi,
): Promise<string[] | null> {
  const probe = await probeHostDevice(manager, SERIAL_BY_ID_DIR);
  if (probe === null) return null;
  if (!probe.exists) return [];
  return probe.nodes.map((name) => `${SERIAL_BY_ID_DIR}/${name}`).sort();
}
