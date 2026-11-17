import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { Note } from "./Note";
import { mount } from "./test-utils";

const pointer = (el: Element, type: string, pointerType: string) =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: false, pointerType }));
/** The open note: drawn at the end of the page, outside whatever holds its figure. */
const shown = () => document.querySelector("body > .note");

describe("Note", () => {
  it("opens while a mouse is on its figure, and not for a touch", () => {
    const el = mount(() => (
      <Note title="Timed 5 s before block 5 047" figure="−5 s">
        Miners set the time.
      </Note>
    ));
    const figure = el.querySelector(".note-figure");
    if (!figure) throw new Error("no figure");
    expect(shown()).toBeNull();
    pointer(figure, "pointerenter", "touch");
    flush();
    expect(shown()).toBeNull();
    pointer(figure, "pointerenter", "mouse");
    flush();
    expect(shown()?.textContent).toBe("Timed 5 s before block 5 047Miners set the time.");
    expect(el.contains(shown())).toBe(false);
    pointer(figure, "pointerleave", "mouse");
    flush();
    expect(shown()).toBeNull();
  });

  it("is a button's description, opened by its focus and closed by Escape", () => {
    const el = mount(() => (
      <Note focusable title="Slow: 20 min or more" figure="35 min 8 s">
        Blocks come every 10 min on average.
      </Note>
    ));
    const button = el.querySelector("button");
    if (!button) throw new Error("no button");
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe(
      "Slow: 20 min or more. Blocks come every 10 min on average.",
    );
    button.focus();
    flush();
    expect(shown()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flush();
    expect(shown()).toBeNull();
  });
});
