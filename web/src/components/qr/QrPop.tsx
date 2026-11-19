import { createSignal, onCleanup, onSettled } from "solid-js";
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
  // The card's width as laid out, which decides how the code is drawn (draw.ts); 0, a plain code,
  // until it is measured.
  const [cardPx, setCardPx] = createSignal(0);

  /**
   * Measured by its layout size, not its drawn box, which the opening animation scales down, and
   * at its full height: the room it was last given is lifted first.
   */
  const place = () => {
    if (!pop) return;
    const b = props.anchor.getBoundingClientRect();
    pop.style.removeProperty("--room");
    pop.style.removeProperty("--qr-card");
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    // Clear of the header only while it stays on screen: on a short screen it scrolls with the
    // page (Header.css), and the code needs the room more.
    const site = document.querySelector(".site-header");
    const sticky = site !== null && getComputedStyle(site).position === "sticky";
    const header = sticky ? site.getBoundingClientRect().bottom : 0;
    const top = Math.max(EDGE, header + GAP);
    const x = Math.max(EDGE, Math.min(b.right - pw, width - pw - EDGE));
    // Never above the window: a button the page's new layout carried off the top (a phone turned)
    // would take the pop-up with it.
    let y = Math.max(top, b.bottom + GAP);
    if (y + ph > height - EDGE) {
      const above = b.top - GAP - ph;
      y = above >= top ? above : top;
    }
    // Nor below the window: a button carried under its foot takes the pop-up no further than that.
    y = Math.max(top, Math.min(y, height - EDGE - ph));
    pop.style.setProperty("--x", `${Math.round(x)}px`);
    pop.style.setProperty("--y", `${Math.round(y)}px`);
    const room = Math.round(height - y - EDGE);
    pop.style.setProperty("--room", `${room}px`);
    // The card no taller than the room left under the title, so the whole symbol is in view
    // without scrolling; the text under it may scroll.
    const card = pop.querySelector<HTMLElement>(".qr__card");
    if (card) {
      const side = Math.min(pop.clientWidth, room - pop.clientTop * 2 - card.offsetTop);
      if (side < pop.clientWidth) pop.style.setProperty("--qr-card", `${Math.max(side, 120)}px`);
      setCardPx(card.offsetWidth);
    }
  };
  // A window that changes size (a phone turned, a toolbar shown) moves it back inside.
  window.addEventListener("resize", place, { passive: true });
  onCleanup(() => window.removeEventListener("resize", place));

  onSettled(() => {
    place();
    close = openPop(
      () => {
        close = undefined;
        // Closed while it held focus (a scroll, a press outside): focus goes back to its button
        // rather than to the page. A press outside moves it on to what was pressed, if anything.
        if (pop?.contains(document.activeElement) === true)
          props.anchor.focus({ preventScroll: true });
        if (!leaving) props.onClose();
      },
      () => [props.anchor, pop],
      // Turned or resized, it stays open and is placed and drawn again (place, above).
      { scroll: true, absorb: true, follow: true },
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
          px={cardPx()}
          text={props.value}
          label={`QR code of the ${props.what} below`}
          {...(props.colour === undefined ? {} : { colour: props.colour })}
        />
      </div>
      <p class="qr-pop__text">{props.value}</p>
    </div>
  );
}
