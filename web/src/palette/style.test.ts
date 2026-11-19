// The palette's stylesheet, read as text: the parts no browser test can reach.
import { describe, expect, it } from "vitest";
import css from "./Palette.css?raw";

/** The body of a rule written at the top of the components layer, outside any @supports or @media. */
function topRule(selector: string): string {
  const at = css.indexOf(`\n  ${selector} {`);
  if (at === -1) throw new Error(`Palette.css has no top-level ${selector}`);
  const start = css.indexOf("{", at) + 1;
  return css.slice(start, css.indexOf("}", start));
}

describe("the palette's solid fallback", () => {
  // Without backdrop-filter the pane is solid, and its selected row is the solid accent-soft
  // (docs/DESIGN.md "Command palette"); the lit glass tint is for glass only.
  it("draws the selected row in accent-soft outside the glass block", () => {
    expect(topRule('.palette__row[aria-selected="true"]')).toContain(
      "background: var(--color-accent-soft);",
    );
    expect(topRule(".palette__panel")).toContain("background: var(--color-surface-raised);");
  });
});
