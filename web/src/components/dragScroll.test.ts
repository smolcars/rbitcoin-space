import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dragScroll } from "./dragScroll";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

/** A box 300 px wide over 3,000 px of content, holding one link, with the drag on it. */
function box() {
  const el = document.createElement("div");
  const link = document.createElement("a");
  link.href = "/block/1";
  el.append(link);
  document.body.append(el);
  let left = 0;
  Object.defineProperties(el, {
    scrollWidth: { value: 3000, configurable: true },
    clientWidth: { value: 300 },
    scrollLeft: {
      get: () => left,
      set: (v: number) => {
        left = Math.min(2700, Math.max(0, v));
      },
    },
  });
  // Pointer capture is the browser's; here it only has to be callable.
  el.setPointerCapture = () => {};
  el.hasPointerCapture = () => false;
  createRoot((d) => {
    dispose = d;
    dragScroll(el);
  });
  const followed = vi.fn<() => void>();
  link.addEventListener("click", (e) => {
    if (!e.defaultPrevented) followed();
  });
  const pointer = (
    target: Element,
    type: string,
    x: number,
    init: Partial<PointerEventInit> = {},
  ) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        ...init,
      }),
    );
  const click = () =>
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return { el, link, followed, pointer, click, left: () => left };
}

describe("dragScroll", () => {
  it("scrolls by the mouse's travel, and the release does not follow the link under it", () => {
    const b = box();
    b.pointer(b.link, "pointerdown", 500);
    b.pointer(b.el, "pointermove", 480);
    expect(b.left()).toBe(20);
    expect(b.el.dataset["dragging"]).toBeDefined();
    b.pointer(b.el, "pointermove", 380);
    expect(b.left()).toBe(120);
    b.pointer(b.el, "pointermove", 420);
    expect(b.left()).toBe(80);
    b.pointer(b.el, "pointerup", 420);
    b.click();
    expect(b.followed).not.toHaveBeenCalled();
  });

  it("keeps a press that hardly moves a click", () => {
    const b = box();
    b.pointer(b.link, "pointerdown", 500);
    b.pointer(b.el, "pointermove", 497);
    b.pointer(b.el, "pointerup", 497);
    b.click();
    expect(b.left()).toBe(0);
    expect(b.followed).toHaveBeenCalledOnce();
  });

  it("leaves touch to the browser, and a modified click to the link", () => {
    const b = box();
    b.pointer(b.link, "pointerdown", 500, { pointerType: "touch" });
    b.pointer(b.el, "pointermove", 400, { pointerType: "touch" });
    b.pointer(b.link, "pointerdown", 500, { ctrlKey: true });
    b.pointer(b.el, "pointermove", 400, { ctrlKey: true });
    b.pointer(b.el, "pointerup", 400, { ctrlKey: true });
    b.click();
    expect(b.left()).toBe(0);
    expect(b.followed).toHaveBeenCalledOnce();
  });

  it("marks a box the mouse can scroll, and not one that fits", () => {
    const b = box();
    b.pointer(b.el, "pointerenter", 0, { buttons: 0 });
    expect(b.el.dataset["grab"]).toBeDefined();
    Object.defineProperty(b.el, "scrollWidth", { value: 300 });
    b.pointer(b.el, "pointerenter", 0, { buttons: 0 });
    expect(b.el.dataset["grab"]).toBeUndefined();
  });
});
