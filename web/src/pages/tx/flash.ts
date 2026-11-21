// Following a link inside the page between the privacy check's words and the flow's cards
// (docs/FRONTEND.md "Privacy check"): the target scrolls into view, takes the focus, and is
// outlined for a moment so the eye finds it.

/** How long the outline stays, matched by the fade in Privacy.css. */
const OUTLINE_MS = 1600;
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** Scrolls `el` to the middle of the window (or its top to the top), focuses `focus` (or `el`),
 * and outlines `el`. */
export function bringIntoView(
  el: HTMLElement,
  focus: HTMLElement = el,
  block: "center" | "start" = "center",
): void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block, behavior: reduce ? "auto" : "smooth" });
  focus.focus({ preventScroll: true });
  const before = timers.get(el);
  if (before !== undefined) clearTimeout(before);
  el.classList.remove("is-flashed");
  // A fresh start for the fade when the same target is followed twice.
  void el.offsetWidth;
  el.classList.add("is-flashed");
  timers.set(
    el,
    setTimeout(() => {
      el.classList.remove("is-flashed");
      timers.delete(el);
    }, OUTLINE_MS),
  );
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
export function showCard(side: "in" | "out", index: number): void {
  document.dispatchEvent(new CustomEvent(SHOW, { detail: { side, index } }));
}
