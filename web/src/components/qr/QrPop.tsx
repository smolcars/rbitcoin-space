import { onCleanup, onSettled } from "solid-js";
import { openPop } from "../pop";
import { QrCode } from "./QrCode";
import "./Qr.css";

/** Room kept between the pop-up and the screen's edges, and between it and its button, in px. */
const EDGE = 8;
const GAP = 6;

/**
 * The QR code's pop-up, fixed over the page beside its button (`anchor`): below it, or above it,
 * or as high as the header allows, always on screen. One pop-up is open at a time, and a press
 * outside, Escape (which returns focus to the button) or a scroll closes it (components/pop.ts).
 */
export default function QrPop(props: {
  id: string;
  value: string;
  what: string;
  colour?: string | null;
  anchor: HTMLButtonElement;
  onClose: () => void;
}) {
  let pop: HTMLDivElement | undefined;
  let close: (() => void) | undefined;
  let leaving = false;

  /**
   * Measured by its layout size, not its drawn box, which the opening animation scales down, and
   * at its full height: the room it was last given is lifted first.
   */
  const place = () => {
    if (!pop) return;
    const b = props.anchor.getBoundingClientRect();
    pop.style.removeProperty("--room");
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const header = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
    const top = Math.max(EDGE, header + GAP);
    const x = Math.max(EDGE, Math.min(b.right - pw, width - pw - EDGE));
    let y = b.bottom + GAP;
    if (y + ph > height - EDGE) {
      const above = b.top - GAP - ph;
      y = above >= top ? above : top;
    }
    pop.style.setProperty("--x", `${Math.round(x)}px`);
    pop.style.setProperty("--y", `${Math.round(y)}px`);
    pop.style.setProperty("--room", `${Math.round(height - y - EDGE)}px`);
  };
  // A window that changes size (a phone turned, a toolbar shown) moves it back inside.
  window.addEventListener("resize", place, { passive: true });
  onCleanup(() => window.removeEventListener("resize", place));

  onSettled(() => {
    place();
    close = openPop(
      () => {
        close = undefined;
        if (!leaving) props.onClose();
      },
      () => [props.anchor, pop],
      { scroll: true, absorb: true },
    );
    pop?.focus({ preventScroll: true });
  });
  // Closed by its button, or the page went away: only its listeners are left to remove.
  onCleanup(() => {
    leaving = true;
    close?.();
  });

  return (
    <div
      ref={pop}
      id={props.id}
      class="qr-pop"
      role="dialog"
      aria-labelledby={`${props.id}-title`}
      tabindex="-1"
    >
      <div class="qr-pop__head">
        <p class="qr-pop__title" id={`${props.id}-title`}>
          Scan the {props.what}
        </p>
        <button
          type="button"
          class="qr-pop__close"
          aria-label="Close"
          onClick={() => {
            close?.();
            props.anchor.focus();
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
      <div class="qr">
        <QrCode
          text={props.value}
          label={`QR code of the ${props.what} below`}
          {...(props.colour === undefined ? {} : { colour: props.colour })}
        />
      </div>
      <p class="qr-pop__text">{props.value}</p>
    </div>
  );
}
