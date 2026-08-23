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

  it("hides the URL field while the container is managed", () => {
    // `ui:disabled` cannot do this: a plugin's uiSchema is fetched once when
    // the form loads, so a greyed-out field would stay greyed until a page
    // reload. JSON Schema dependencies are re-evaluated by RJSF on every
    // change, so the field appears the moment the toggle is switched off.
    const dep = managedModeSchema(OPTS).dependencies as {
      managedContainer: { oneOf: { properties: Record<string, unknown> }[] };
    };
    const [managed, external] = dep.managedContainer.oneOf;
    expect(Object.keys(managed!.properties)).toEqual(["managedContainer"]);
    expect(Object.keys(external!.properties).sort()).toEqual([
      "externalUrl",
      "managedContainer",
    ]);
  });

  it("keys the branches on the toggle's own value", () => {
    const dep = managedModeSchema(OPTS).dependencies as {
      managedContainer: {
        oneOf: { properties: { managedContainer: { const: boolean } } }[];
      };
    };
    const consts = dep.managedContainer.oneOf.map(
      (b) => b.properties.managedContainer.const,
    );
    expect(consts).toEqual([true, false]);
  });

  it("uses the custom url field name in the dependency too", () => {
    const dep = managedModeSchema({ ...OPTS, urlFieldName: "serverUrl" })
      .dependencies as {
      managedContainer: { oneOf: { properties: Record<string, unknown> }[] };
    };
    expect(dep.managedContainer.oneOf[1]!.properties).toHaveProperty(
      "serverUrl",
    );
  });

  it("carries the same URL fragment into the dependency", () => {
    // Not a second copy that could drift from the standalone one.
    const m = managedModeSchema(OPTS);
    const dep = m.dependencies as {
      managedContainer: { oneOf: { properties: Record<string, unknown> }[] };
    };
    expect(dep.managedContainer.oneOf[1]!.properties.externalUrl).toBe(
      m.externalUrl,
    );
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
