// Following a link inside the page (flash.ts): one outline at a time, gone after its fade, and
// nothing left behind when the page goes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bringIntoView, clearFlash, nextFrame, OUTLINE_MS, returnFocus, setOpener } from "./flash";

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

describe("giving the focus back when details close", () => {
  /** A flow's output column with output 0's card drawn, and a "Show N more" button. */
  const flow = (drawn: boolean) => {
    const list = document.createElement("ul");
    list.className = "tx-flow__col tx-flow__col--out";
    if (drawn) {
      const card = document.createElement("li");
      card.id = "flow-out-0";
      card.innerHTML = '<button type="button" class="tx-flow__open">Details</button>';
      list.append(card);
    }
    const more = document.createElement("button");
    more.className = "tx-flow__more";
    list.append(more);
    document.body.append(list);
    return { list, more, open: list.querySelector<HTMLButtonElement>(".tx-flow__open") };
  };

  it("never takes the page itself as what opened them", () => {
    const { open } = flow(true);
    setOpener(document.body);
    returnFocus("out", 0);
    expect(document.activeElement).toBe(open);
  });

  it("with nothing else left, the list of cards takes it, out of the tab order", () => {
    const { list, more } = flow(false);
    more.remove();
    setOpener(null);
    returnFocus("out", 0);
    expect(document.activeElement).toBe(list);
    expect(list.tabIndex).toBe(-1);
  });
});
