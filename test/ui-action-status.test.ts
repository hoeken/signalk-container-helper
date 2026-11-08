import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionStatus } from "../src/ui/components.js";

function render(props: Parameters<typeof ActionStatus>[0]): string {
  return renderToStaticMarkup(createElement(ActionStatus, props));
}

describe("ActionStatus announces its message", () => {
  it("keeps an empty polite region mounted before any message", () => {
    expect(render({ message: "" })).toBe('<div role="status"></div>');
  });

  it("puts a success into the polite region", () => {
    const html = render({ message: "Saved!", id: "save-status" });
    expect(html).toMatch(
      /^<div role="status" id="save-status" style="[^"]+">Saved!<\/div>$/,
    );
  });

  it("raises a failure as an alert and empties the polite region", () => {
    const html = render({ message: "Interval too short", error: true });
    expect(html).toMatch(
      /^<div role="status"><\/div><div role="alert" style="[^"]+">Interval too short<\/div>$/,
    );
  });

  it("gives the id to the alert so a field can be described by it", () => {
    const html = render({ message: "Bad", error: true, id: "rate-error" });
    expect(html).toContain('<div role="alert" id="rate-error"');
    expect(html.match(/id="rate-error"/g)).toHaveLength(1);
  });

  it("renders no alert for an empty error", () => {
    expect(render({ message: "", error: true, id: "x" })).toBe(
      '<div role="status"></div>',
    );
  });
});
