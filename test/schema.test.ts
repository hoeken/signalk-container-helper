import { describe, it, expect } from "vitest";
import { managedModeSchema } from "../src/schema.js";

const OPTS = {
  productName: "backup-server",
  image: "ghcr.io/dirkwa/signalk-backup-server",
  exampleUrl: "http://192.168.1.50:3010",
};

describe("managedModeSchema", () => {
  it("emits a boolean toggle defaulting to managed", () => {
    const s = managedModeSchema(OPTS).managedContainer;
    expect(s.type).toBe("boolean");
    expect(s.default).toBe(true);
    expect(s.title).toBe(
      "Manage backup-server container via signalk-container",
    );
    expect(s.description).toContain("ghcr.io/dirkwa/signalk-backup-server");
  });

  it("emits a string URL field defaulting to empty", () => {
    const s = managedModeSchema(OPTS).externalUrl;
    expect(s.type).toBe("string");
    expect(s.default).toBe("");
    expect(s.title).toBe("External backup-server URL");
    expect(s.description).toContain("http://192.168.1.50:3010");
  });

  it("warns that traffic leaves the host", () => {
    // Most of these services have no auth and assume a trusted LAN.
    expect(managedModeSchema(OPTS).externalUrl.description).toContain(
      "leaves this host",
    );
  });

  it("derives defaults from the same literals as the fragments", () => {
    const s = managedModeSchema(OPTS);
    expect(s.defaults).toEqual({ managedContainer: true, externalUrl: "" });
    expect(s.defaults.managedContainer).toBe(s.managedContainer.default);
    expect(s.defaults.externalUrl).toBe(s.externalUrl.default);
  });

  it("keys defaults by a custom url field name", () => {
    const s = managedModeSchema({ ...OPTS, urlFieldName: "serverUrl" });
    expect(s.defaults).toEqual({ managedContainer: true, serverUrl: "" });
  });

  it("honours defaultManaged: false", () => {
    const s = managedModeSchema({ ...OPTS, defaultManaged: false });
    expect(s.managedContainer.default).toBe(false);
    expect(s.defaults.managedContainer).toBe(false);
  });

  it("does not claim '(default)' when the default is disabled", () => {
    const on = managedModeSchema(OPTS).managedContainer.description as string;
    const off = managedModeSchema({ ...OPTS, defaultManaged: false })
      .managedContainer.description as string;
    expect(on).toContain("When enabled (default)");
    expect(off).toContain("When enabled,");
    expect(off).not.toContain("(default)");
  });

  it("omits the image clause when no image is given", () => {
    const s = managedModeSchema({ productName: "QuestDB" });
    expect(s.managedContainer.description).toContain("managed container");
    expect(s.managedContainer.description).not.toContain("undefined");
  });

  it("emits pure JSON — the property that makes Type.Unsafe work", () => {
    // Both TypeBox packages accept these only because they are plain data:
    // no symbols, no functions, no class instances.
    const s = managedModeSchema(OPTS);
    for (const frag of [s.managedContainer, s.externalUrl]) {
      expect(JSON.parse(JSON.stringify(frag))).toEqual(frag);
      expect(Object.getOwnPropertySymbols(frag)).toHaveLength(0);
      for (const v of Object.values(frag)) {
        expect(typeof v).not.toBe("function");
      }
    }
  });
});
