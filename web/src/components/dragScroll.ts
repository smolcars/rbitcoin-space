import { onCleanup } from "solid-js";

/** How far a press moves before it is a drag, not a click. */
const THRESHOLD = 6;
/** Moves older than this at release say the pointer had stopped: no glide. */
const SAMPLE_MS = 80;
/** The glide's speed kept per 16 ms frame. */
const FRICTION = 0.95;
/** Below this speed, in px per ms, the glide ends. */
const MIN_SPEED = 0.02;

/**
 * Use as a `ref` through `owned` (./owned.ts) on anything that scrolls sideways with its scrollbar
 * hidden. A mouse press and drag scrolls it, and on release it glides on and slows, as a swipe
 * does on a touch screen (unless motion is reduced). Touch and pen are left to the browser. A press that moves less than
 * a few pixels is still a click, and a drag released over a link does not follow it. While the
 * mouse is over a box that can scroll, it is marked `data-grab`; while dragging, `data-dragging`.
 * Returns a stop for the glide: call it before scrolling the box from code, since a smooth scroll
 * may not have moved the box by the glide's next frame, which would then carry on over it.
 */
export function dragScroll(el: HTMLElement): () => void {
  let pointer: number | undefined;
  let lastX = 0;
  let dragging = false;
  /** Recent moves, for the speed at release. */
  let samples: { t: number; x: number }[] = [];
  let glide = 0;
  /** Where the glide last put the box; a scroll from anything else ends it. */
  let at = 0;
  let unclick: ReturnType<typeof setTimeout> | undefined;
  let swallow = false;

  const stopGlide = () => {
    cancelAnimationFrame(glide);
    glide = 0;
    el.toggleAttribute("data-dragging", false);
  };
  const onEnter = (e: PointerEvent) => {
    if (e.pointerType === "mouse") {
      el.toggleAttribute("data-grab", el.scrollWidth - el.clientWidth > 1);
    }
  };
  const onDown = (e: PointerEvent) => {
    stopGlide();
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    // A modified click opens a link elsewhere or selects: it stays a click.
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (el.scrollWidth - el.clientWidth <= 1) return;
    pointer = e.pointerId;
    lastX = e.clientX;
    dragging = false;
    samples = [{ t: e.timeStamp, x: e.clientX }];
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    // The button was let go where we could not see it.
    if (e.buttons === 0) {
      end(e);
      return;
    }
    const dx = e.clientX - lastX;
    if (!dragging) {
      if (Math.abs(dx) < THRESHOLD) return;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      el.toggleAttribute("data-dragging", true);
      window.getSelection()?.removeAllRanges();
    }
    // By the step, not from where the drag began: the page moves the box itself at times (the
    // home strip keeps its place in the past when a block comes), and the drag must not undo it.
    el.scrollLeft -= dx;
    lastX = e.clientX;
    samples.push({ t: e.timeStamp, x: e.clientX });
    samples = samples.filter((s) => e.timeStamp - s.t <= SAMPLE_MS);
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = undefined;
    if (!dragging) return;
    dragging = false;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    // The click this release makes is the drag's, not the link's under it.
    swallow = true;
    clearTimeout(unclick);
    unclick = setTimeout(() => {
      swallow = false;
    }, 0);
    const first = samples.find((s) => e.timeStamp - s.t <= SAMPLE_MS);
    const span = first ? e.timeStamp - first.t : 0;
    const speed = first && span > 0 ? (first.x - lastX) / span : 0;
    if (Math.abs(speed) < MIN_SPEED || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.toggleAttribute("data-dragging", false);
      return;
    }
    let v = speed;
    let t = performance.now();
    at = el.scrollLeft;
    const step = (now: number) => {
      // Someone else scrolled it (a button, a key, the page): theirs wins.
      if (Math.abs(el.scrollLeft - at) > 1) return stopGlide();
      const dt = Math.min(now - t, 50);
      t = now;
      const before = el.scrollLeft;
      el.scrollLeft = before + v * dt;
      at = el.scrollLeft;
      v *= FRICTION ** (dt / 16);
      // Slow enough, or against an end.
      if (Math.abs(v) < MIN_SPEED || at === before) return stopGlide();
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  };
  const onClick = (e: MouseEvent) => {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  };
  // A link or an image would otherwise be picked up and carried instead.
  const onDragStart = (e: DragEvent) => e.preventDefault();

  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("wheel", stopGlide, { passive: true });
  el.addEventListener("keydown", stopGlide);
  el.addEventListener("click", onClick, true);
  el.addEventListener("dragstart", onDragStart);
  onCleanup(() => {
    stopGlide();
    clearTimeout(unclick);
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    el.removeEventListener("wheel", stopGlide);
    el.removeEventListener("keydown", stopGlide);
    el.removeEventListener("click", onClick, true);
    el.removeEventListener("dragstart", onDragStart);
  });
  return stopGlide;
}
