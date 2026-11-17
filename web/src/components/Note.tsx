import { createSignal, createUniqueId, flush, onCleanup, Show } from "solid-js";
import { type JSX, Portal } from "@solidjs/web";
import { openPop } from "./pop";
import "./Note.css";

/** Room kept between the note and the screen's edges, and between it and its figure, in px. */
const EDGE = 8;
const GAP = 6;
/** How long a note waits after the mouse leaves its figure, so the mouse can cross to it, in ms. */
const LINGER = 150;

/**
 * A figure that explains itself: a note opens over the page while a mouse is on it or it has
 * keyboard focus. The note is drawn at the end of the page, so nothing around the figure clips it
 * (the block strip's faded edges would), above the figure, or below it when asked or when the room
 * above is short. Screen readers hear the same words as the figure's description.
 */
export function Note(props: {
  /** The note's first line. */
  title: string;
  /** Its quieter line. */
  children?: string;
  /** The figure itself. */
  figure: JSX.Element;
  /**
   * A button, so a key or a tap reaches the note: for a figure outside any link. Inside one, the
   * link is the stop and its label carries the note.
   */
  focusable?: boolean;
  /** Below the figure: for one whose neighbours above should stay in sight. */
  below?: boolean;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  let figure: HTMLElement | undefined;
  let pop: HTMLElement | undefined;
  let close: (() => void) | undefined;
  /** Set while a close is under way: Escape gives focus back to the figure, which must not reopen it. */
  let closing = false;
  let leaving: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(leaving);
    close?.();
  });

  const place = () => {
    if (!pop || !figure) return;
    const f = figure.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const header = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
    const above = f.top - p.height - GAP;
    const roomAbove = above >= Math.max(EDGE, header + GAP);
    const roomBelow = f.bottom + GAP + p.height <= window.innerHeight - EDGE;
    const up = props.below === true ? !roomBelow && roomAbove : roomAbove;
    // Its right edge on the figure's, as figures here are right-aligned numbers; inside the screen.
    const x = Math.max(EDGE, Math.min(f.right - p.width, width - p.width - EDGE));
    pop.style.setProperty("--x", `${Math.round(x)}px`);
    pop.style.setProperty("--y", `${Math.round(up ? above : f.bottom + GAP)}px`);
  };
  const show = () => {
    if (close || closing) return;
    setOpen(true);
    // Drawn before it is measured, and placed before the browser paints it.
    flush();
    place();
    close = openPop(
      () => {
        close = undefined;
        closing = true;
        queueMicrotask(() => (closing = false));
        setOpen(false);
      },
      () => [figure, pop],
      { scroll: true },
    );
  };
  const hide = () => close?.();
  // A mouse only: a touch is a tap on what the figure sits in, such as a block's link, or, on a
  // button, its focus. The note stays while the mouse is on it, so it can be read up close.
  const stay = () => clearTimeout(leaving);
  const enter = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    stay();
    show();
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    stay();
    leaving = setTimeout(hide, LINGER);
  };

  const inside = () => (
    <>
      {props.figure}
      <span id={id} class="visually-hidden">
        {props.children === undefined ? props.title : `${props.title}. ${props.children}`}
      </span>
      <Show when={open()}>
        <Portal>
          <span
            ref={(el) => (pop = el)}
            class="note"
            aria-hidden="true"
            onPointerEnter={stay}
            onPointerLeave={leave}
          >
            <span class="note__title">{props.title}</span>
            {props.children}
          </span>
        </Portal>
      </Show>
    </>
  );
  return props.focusable === true ? (
    <button
      ref={(el) => (figure = el)}
      type="button"
      class="note-figure"
      aria-describedby={id}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onFocusIn={show}
      onFocusOut={hide}
    >
      {inside()}
    </button>
  ) : (
    <span
      ref={(el) => (figure = el)}
      class="note-figure"
      aria-describedby={id}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onFocusIn={show}
      onFocusOut={hide}
    >
      {inside()}
    </span>
  );
}
