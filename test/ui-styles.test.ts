import { describe, expect, it } from "vitest";
import { panelStyles as S } from "../src/ui/styles.js";

describe("collapsible section header reads as a control", () => {
  // A signalk-questdb user reported a config field as uneditable when it was
  // only collapsed: the header inherited sectionTitle's muted #888 and read
  // as a caption rather than something to click
  // (dirkwa/signalk-questdb#123). CollapsibleSection spreads sectionToggle
  // OVER sectionTitle, so this override is what makes the header legible.
  it("overrides the muted heading colour", () => {
    expect(S.sectionTitle.color).toBe("#888");
    expect(S.sectionToggle.color).toBe("#555");
  });

  it("uses the same tone as a field label", () => {
    // #555 is not arbitrary — it is the panel's established "this is an
    // actual control" colour, so headers match the fields they reveal.
    expect(S.sectionToggle.color).toBe(S.label.color);
  });

  it("keeps the spread order meaningful", () => {
    // If sectionToggle ever stopped carrying colour, the spread would fall
    // back to sectionTitle's #888 and silently restore the bug.
    const merged = { ...S.sectionTitle, ...S.sectionToggle };
    expect(merged.color).toBe("#555");
  });

  it("renders the disclosure marker large enough to read", () => {
    expect(S.sectionMarker.fontSize).toBe(11);
  });
});
