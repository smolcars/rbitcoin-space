// The page's small pop-ups (an exact amount, the network menu): one open at a time, closed by a
// press outside, Escape, and, where asked, a scroll that carries its button away. Not the browser's
// popover: while a top-layer element shows, iOS Safari repaints the band behind its toolbar and the
// page stops above it (WebKit bug 302272).
//
// A press outside only closes it (`absorb`): the reader is dismissing it, as with a native menu, and
// a tap that also followed the link beneath it took them to another page. The one exception is a
// press on another pop-up of the same kind (`through`): one tap moves an exact amount's note from
// one figure to the next, as it did before, so figures read side by side.

let closeOpen: (() => void) | undefined;

/**
 * Notes a pop-up as open, closing the one open before it. `inside` is what a press may land on
 * without closing it: its button first, which Escape returns focus to. Returns what closes it.
 */
export function openPop(
  onClose: () => void,
  inside: () => readonly (HTMLElement | undefined)[],
  options: { scroll?: boolean; absorb?: boolean; through?: string; follow?: boolean } = {},
): () => void {
  closeOpen?.();
  const press = (e: PointerEvent) => {
    if (
      inside().some((el) => el !== undefined && e.target instanceof Node && el.contains(e.target))
    )
      return;
    close();
    // A primary press only: a right-click ends in a menu of the browser's, never in a click.
    if (options.absorb !== true || e.button !== 0) return;
    if (
      options.through !== undefined &&
      e.target instanceof Element &&
      e.target.closest(options.through)
    )
      return;
    absorbClick();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    close();
    inside()[0]?.focus();
  };
  // A scroll or resize closes it once its button has moved: not a nudge, such as iOS Safari's
  // toolbar settling as the pop-up opens. With `follow`, a resize (a phone turned) does not: the
  // pop-up places itself again, and the button's new place, and any scroll the browser makes in
  // the next two frames to keep the page in range, become where it is measured from.
  let at = inside()[0]?.getBoundingClientRect();
  let settling = 0;
  const moved = (e: Event) => {
    const now = inside()[0]?.getBoundingClientRect();
    if (options.follow === true && (e.type === "resize" || settling > 0)) {
      at = now;
      if (e.type === "resize") {
        settling++;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            settling--;
            at = inside()[0]?.getBoundingClientRect();
          }),
        );
      }
      return;
    }
    if (at && now && Math.max(Math.abs(now.top - at.top), Math.abs(now.left - at.left)) > 16)
      close();
  };
  const close = () => {
    document.removeEventListener("pointerdown", press, true);
    document.removeEventListener("keydown", key);
    window.removeEventListener("scroll", moved, true);
    window.removeEventListener("resize", moved);
    if (closeOpen === close) closeOpen = undefined;
    onClose();
  };
  document.addEventListener("pointerdown", press, true);
  document.addEventListener("keydown", key);
  if (options.scroll === true) {
    window.addEventListener("scroll", moved, { capture: true, passive: true });
    window.addEventListener("resize", moved, { passive: true });
  }
  closeOpen = close;
  return close;
}

/**
 * Swallows the click that ends the press under way, so it activates nothing, and the press's
 * release, which a chart opens a point on. Only a pointer's click (a keyboard's has `detail` 0),
 * and only until that click, the next press, a cancelled press (a scroll), a key or the browser's
 * own menu: a later, unrelated activation always goes through. It never holds an event back: it
 * stops the one it is handed, or lets it pass, at once.
 */
function absorbClick(): void {
  const ends = ["pointerdown", "pointercancel", "keydown", "contextmenu"] as const;
  const release = (e: PointerEvent) => e.stopPropagation();
  const eat = (e: MouseEvent) => {
    if (e.detail === 0) return;
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => {
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("click", eat, true);
    for (const end of ends) window.removeEventListener(end, done, true);
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("click", eat, true);
  // Added while this press is being dispatched: the window's capture phase is already past for it.
  for (const end of ends) window.addEventListener(end, done, true);
}
