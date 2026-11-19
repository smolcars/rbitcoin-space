import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Note } from "./Note";
import { mount } from "./test-utils";

const pointer = (el: Element, type: string, pointerType: string) =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: false, pointerType }));
/** The open note: drawn at the end of the page, outside whatever holds its figure. */
const shown = () => document.querySelector("body > .note");

afterEach(() => {
  vi.useRealTimers();
});

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
  });

  it("stays while the mouse crosses to it and rests on it, and goes when it leaves both", () => {
    vi.useFakeTimers();
    const el = mount(() => <Note title="Slow: 20 min or more" figure="35 min 8 s" />);
    const figure = el.querySelector(".note-figure");
    if (!figure) throw new Error("no figure");
    pointer(figure, "pointerenter", "mouse");
    flush();
    pointer(figure, "pointerleave", "mouse");
    const note = shown();
    if (!note) throw new Error("no note");
    pointer(note, "pointerenter", "mouse");
    vi.advanceTimersByTime(1000);
    flush();
    expect(shown()).not.toBeNull();
    pointer(note, "pointerleave", "mouse");
    vi.advanceTimersByTime(1000);
    flush();
    expect(shown()).toBeNull();
  });

  it("stays closed after Escape, though Escape gives the button focus", async () => {
    const el = mount(() => <Note focusable title="Slow: 20 min or more" figure="35 min 8 s" />);
    const button = el.querySelector("button");
    if (!button) throw new Error("no button");
    pointer(button, "pointerenter", "mouse");
    flush();
    expect(shown()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flush();
    expect(document.activeElement).toBe(button);
    await Promise.resolve();
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

  it("opens again when the focused button is pressed after Escape closed it", async () => {
    const el = mount(() => <Note focusable title="Slow: 20 min or more" figure="35 min 8 s" />);
    const button = el.querySelector("button");
    if (!button) throw new Error("no button");
    button.focus();
    flush();
    expect(shown()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await Promise.resolve();
    flush();
    expect(shown()).toBeNull();
    expect(document.activeElement).toBe(button);
    // Enter or Space on a button, and a tap, all arrive as a click.
    button.click();
    flush();
    expect(shown()).not.toBeNull();
    // A press while it is open leaves it open: it never toggles shut under a reader's finger.
    button.click();
    flush();
    expect(shown()).not.toBeNull();
  });

  it("names a button by its figure alone, and reads a plain figure's note in place", () => {
    const button = mount(() => (
      <Note focusable title="Slow: 20 min or more" figure="35 min 8 s">
        Blocks come every 10 min on average.
      </Note>
    )).querySelector("button");
    const described = document.getElementById(button?.getAttribute("aria-describedby") ?? "");
    // Its description still, though kept out of the name the button takes from its contents.
    expect(described?.getAttribute("aria-hidden")).toBe("true");
    expect(described?.textContent).toBe(
      "Slow: 20 min or more. Blocks come every 10 min on average.",
    );
    const plain = mount(() => <Note title="Slow: 20 min or more" figure="35 min 8 s" />);
    expect(plain.querySelector(".visually-hidden")?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("stays open when pressed again just after the mouse left and Escape closed it", async () => {
    vi.useFakeTimers();
    const el = mount(() => <Note focusable title="Slow: 20 min or more" figure="35 min 8 s" />);
    const button = el.querySelector("button");
    if (!button) throw new Error("no button");
    button.focus();
    pointer(button, "pointerenter", "mouse");
    flush();
    // The mouse leaves: the note is to close in a moment, unless something else does first.
    pointer(button, "pointerleave", "mouse");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await Promise.resolve();
    flush();
    expect(shown()).toBeNull();
    button.click();
    flush();
    expect(shown()).not.toBeNull();
    // The leave that was pending belonged to the note Escape closed, not to this one.
    vi.advanceTimersByTime(1000);
    flush();
    expect(shown()).not.toBeNull();
  });
});
