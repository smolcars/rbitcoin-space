import { onCleanup } from "solid-js";

/**
 * Use as a `ref` through `owned` (./owned.ts) on anything that scrolls sideways. It marks the
 * edges that hide more, `data-more-start` and `data-more-end`, and global.css fades them, so a
 * cut-off column reads as "there is more this way", not as a fault. While it scrolls, it also takes keyboard focus, so the
 * arrow keys can reach what is off to the side.
 */
export function scrollCue(el: HTMLElement): void {
  const mark = () => {
    const more = el.scrollWidth - el.clientWidth;
    el.toggleAttribute("data-more-start", el.scrollLeft > 1);
    el.toggleAttribute("data-more-end", el.scrollLeft < more - 1);
    if (more > 1) el.tabIndex = 0;
    else el.removeAttribute("tabindex");
  };
  el.addEventListener("scroll", mark, { passive: true });
  // Next frame, not inside the observer: the fade can change what it watches in WebKit, which
  // reports that as an uncaught resize loop. One mark however many notices.
  let frame = 0;
  const later = () => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      mark();
    });
  };
  // Absent where there is no layout (tests): there is nothing to measure there.
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(later);
  observer?.observe(el);
  if (el.firstElementChild) observer?.observe(el.firstElementChild);
  onCleanup(() => {
    observer?.disconnect();
    cancelAnimationFrame(frame);
    el.removeEventListener("scroll", mark);
  });
}
