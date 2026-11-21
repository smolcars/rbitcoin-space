// Following a link inside the page between the privacy check's words and the flow's cards
// (docs/FRONTEND.md "Privacy check"): the target scrolls into view, takes the focus, and is
// outlined for a moment so the eye finds it.

/** How long the outline stays, matched by the fade in Privacy.css. */
export const OUTLINE_MS = 1600;

/** The one target outlined now, and its timer: a second jump ends the first one's outline. */
let active: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;
/** The jump waiting for the next frame, so a newer one or an unmount can call it off. */
let frame: number | undefined;

/** Ends the outline now and calls off a jump still waiting: on unmount, or before another. */
export function clearFlash(): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  endOutline();
}

function endOutline() {
  if (!active) return;
  clearTimeout(active.timer);
  active.el.classList.remove("is-flashed");
  active = undefined;
}

/** Runs `jump` on the next frame, after what it needs is drawn, in place of one still waiting. */
export function nextFrame(jump: () => void): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = undefined;
    jump();
  });
}

/** Scrolls `el` to the middle of the window (or its top to the top), focuses `focus` (or `el`),
 * and outlines `el` for a moment. */
export function bringIntoView(
  el: HTMLElement,
  focus: HTMLElement = el,
  block: "center" | "start" = "center",
): void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block, behavior: reduce ? "auto" : "smooth" });
  focus.focus({ preventScroll: true });
  endOutline();
  // A fresh start for the fade when the same target is followed twice.
  void el.offsetWidth;
  el.classList.add("is-flashed");
  const timer = setTimeout(() => {
    el.classList.remove("is-flashed");
    if (active?.el === el) active = undefined;
  }, OUTLINE_MS);
  active = { el, timer };
}

/** The event a flow listens for to show one of its cards. */
export const SHOW = "flow:show";
/** A card's id, for the links that lead to it. */
export const cardId = (side: "in" | "out", index: number) => `flow-${side}-${index}`;

/**
 * Brings an input's or output's card into view on the page's flow (Flow.tsx), opening "Show more"
 * first when the card is behind it, and outlines it for a moment; the focus goes to its details
 * button.
 */
export function showCard(side: "in" | "out", index: number, from?: HTMLElement): void {
  document.dispatchEvent(new CustomEvent(SHOW, { detail: { side, index, from } }));
}

/** The element whose activation opened the details now open: named by the handler that did. */
let opener: HTMLElement | null = null;
/** Never the page itself: a click that focused nothing leaves the focus on `body`. */
export function setOpener(el: HTMLElement | null): void {
  opener = el === document.body || el === document.documentElement ? null : el;
}

const shownOnPage = (el: Element | null | undefined): el is HTMLElement =>
  el instanceof HTMLElement &&
  el !== document.body &&
  el.isConnected &&
  (typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true }));

/**
 * Where the focus goes when details close: what opened them if it is still on the page and
 * visible; else, in order, that input's or output's details button when its card is drawn, a
 * number in the privacy check leading to it, that side's "Show N more" button (there whenever
 * the card is not), and that side's list of cards, which is there whenever the flow is.
 */
export function returnFocus(side: "in" | "out", index: number): void {
  const from = opener;
  opener = null;
  const list = document.querySelector<HTMLElement>(`.tx-flow__col--${side}`);
  const target = [
    from,
    document.getElementById(cardId(side, index))?.querySelector(".tx-flow__open"),
    document.querySelector(`a.pv-ref[href="#${cardId(side, index)}"]`),
    document.querySelector(`.tx-flow__col--${side} .tx-flow__more`),
  ].find((el) => shownOnPage(el));
  if (target instanceof HTMLElement) target.focus();
  else if (list) {
    // Focusable by script only, so it never adds a stop to the tab order.
    if (!list.hasAttribute("tabindex")) list.tabIndex = -1;
    list.focus();
  }
}
