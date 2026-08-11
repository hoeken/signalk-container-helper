import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * src/types.ts is a hand-written mirror of signalk-container's API. The
 * type-level contract test pins its *shape*; nothing pins its *prose*, which
 * is how issue #35 happened: the mirror said signalkDataMount mounts "the
 * plugin's" data dir, and in a file whose every other line addresses a
 * consumer plugin author that reads as the consumer's. It is signalk-container's.
 *
 * Diffing against upstream's JSDoc would not have caught it — the canonical
 * text is equally ambiguous in isolation (it says "the SignalK data
 * directory"; the disambiguation lives in a neighbouring field's doc). So
 * instead of tracking upstream prose, pin the *claims* that a reader must not
 * be able to get wrong. These are cheap and only cover fields whose meaning
 * depends on WHICH plugin's app object resolves them.
 */
const TYPES = readFileSync(
  fileURLToPath(new URL("../src/types.ts", import.meta.url)),
  "utf8",
);

/** The JSDoc block immediately above a member's declaration. */
function docFor(member: string): string {
  const lines = TYPES.split("\n");
  const decl = new RegExp(`^\\s*${member}\\??[?(:]`);
  const i = lines.findIndex((l) => decl.test(l));
  expect(i, `declaration of ${member} not found`).toBeGreaterThan(-1);

  const end = i - 1;
  expect(
    lines[end]?.trim().endsWith("*/"),
    `${member} has no JSDoc block`,
  ).toBe(true);
  let start = end;
  while (start >= 0 && !lines[start]?.trim().startsWith("/**")) start--;
  return lines.slice(start, end + 1).join(" ");
}

describe("types.ts doc anchors", () => {
  // Both resolve from signalk-container's own app object, so neither can ever
  // yield the calling plugin's directory. A consumer who believes otherwise
  // silently reads the wrong files — the #35 failure.
  it.each(["signalkDataMount", "resolveSignalkDataMount"])(
    "%s names signalk-container as the owner of the resolved dir",
    (member) => {
      const doc = docFor(member);
      expect(doc).toMatch(/signalk-container's own/);
      expect(doc).toMatch(/resolveMount/);
    },
  );

  it("signalkConfigRootMount warns about scope and the throw", () => {
    const doc = docFor("signalkConfigRootMount");
    expect(doc).toMatch(/security\.json/);
    // Not per-plugin: every caller gets the same tree.
    expect(doc).toMatch(/NOT per-plugin/);
    // Behavioural fact, not flavour: it throws without app.config.configPath.
    expect(doc).toMatch(/[Tt]hrows/);
  });

  it("removeManagedData keeps its path-safety contract", () => {
    // A destructive operation: assert BOTH halves of the guard rail, so a
    // trim that drops either one fails rather than passing on the survivor.
    const doc = docFor("removeManagedData");
    expect(doc).toMatch(/getDataDirPath\(\)` or below/);
    expect(doc).toMatch(/empty paths and\s+\*?\s*filesystem roots are refused/);
  });
});
