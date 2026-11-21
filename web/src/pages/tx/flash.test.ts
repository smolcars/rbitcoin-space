// Following a link inside the page (flash.ts): one outline at a time, gone after its fade, and
// nothing left behind when the page goes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bringIntoView, clearFlash, nextFrame, OUTLINE_MS } from "./flash";

/** A focusable element, and the spy on how it was scrolled into view. */
const box = () => {
  const el = document.createElement("div");
  el.tabIndex = -1;
  document.body.append(el);
  const scrolled = vi.spyOn(el, "scrollIntoView").mockReturnValue(undefined);
  return Object.assign(el, { scrolled });
};
const reduced = (on: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("reduce") }));

beforeEach(() => {
  vi.useFakeTimers();
  reduced(false);
});
afterEach(() => {
  clearFlash();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("bringing a target into view", () => {
  it("scrolls smoothly, focuses it and outlines it until the fade is done", () => {
    const el = box();
    bringIntoView(el);
    expect(el.scrolled).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(document.activeElement).toBe(el);
    expect(el.classList.contains("is-flashed")).toBe(true);
    vi.advanceTimersByTime(OUTLINE_MS - 1);
    expect(el.classList.contains("is-flashed")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains("is-flashed")).toBe(false);
  });

  it("jumps without motion when the reader asks for less", () => {
    reduced(true);
    const el = box();
    bringIntoView(el, el, "start");
    expect(el.scrolled).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
  });

  it("followed again, starts its outline afresh", () => {
    const el = box();
    bringIntoView(el);
    vi.advanceTimersByTime(OUTLINE_MS - 100);
    bringIntoView(el);
    vi.advanceTimersByTime(200);
    expect(el.classList.contains("is-flashed")).toBe(true);
    vi.advanceTimersByTime(OUTLINE_MS);
    expect(el.classList.contains("is-flashed")).toBe(false);
  });

  it("a second target ends the first one's outline", () => {
    const a = box();
    const b = box();
    bringIntoView(a);
    bringIntoView(b);
    expect(a.classList.contains("is-flashed")).toBe(false);
    expect(b.classList.contains("is-flashed")).toBe(true);
  });

  it("on unmount, the outline goes and a jump still waiting never runs", () => {
    const el = box();
    bringIntoView(el);
    const jump = vi.fn<() => void>();
    nextFrame(jump);
    clearFlash();
    expect(el.classList.contains("is-flashed")).toBe(false);
    vi.advanceTimersByTime(100);
    expect(jump).not.toHaveBeenCalled();
  });

  it("a newer jump takes the place of one still waiting", () => {
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    nextFrame(first);
    nextFrame(second);
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
