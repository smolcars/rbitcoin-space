import { createSignal, createUniqueId, lazy, Loading, onCleanup, Show } from "solid-js";
import { noteFailedStyle, retryFiles } from "../../lib/chunks";
import { createLoader, wish } from "./load";
import type QrPopView from "./QrPop";
import "./QrButton.css";

// The pop-up, the encoder and the drawing load on first use: no page's first load carries them.
// The button loads them itself, so a failed download is its own to report and the page is left as
// it is. One load at a time for the whole page, which every press joins (load.ts); `lazy` is
// handed only a module whose load has succeeded, stylesheet included.
interface PopModule {
  default: typeof QrPopView;
}
const loader = createLoader<PopModule>({
  retryFailed: retryFiles,
  importCode: async () => import("./QrPop"),
  styled: stylesheetApplied,
});
const QrPop = lazy(async () => loader.loaded() ?? loader.load());

/**
 * Whether the pop-up's stylesheet applies: a hidden probe with its class is fixed in place. When it
 * is not, its link is noted as failed, so the next load asks for it again.
 */
function stylesheetApplied(): boolean {
  const box = document.createElement("div");
  box.hidden = true;
  const probe = document.createElement("div");
  probe.className = "qr-pop";
  box.append(probe);
  document.body.append(box);
  const applied = getComputedStyle(probe).position === "fixed";
  box.remove();
  if (!applied)
    for (const link of document.querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"][href*="/QrPop-"]',
    ))
      noteFailedStyle(link);
  return applied;
}

/**
 * A button that shows `value` as a QR code in a pop-up beside it, with the value as text under the
 * code. `what` names the value ("address"). `colour`, a node's checked `#rrggbb` (null for none
 * announced), draws the code; leave it out for the site's ink.
 *
 * While the pop-up's code loads, pressing the button again, Escape, a press anywhere else or focus
 * moving elsewhere gives up waiting, and the pop-up then never opens. A download that fails leaves
 * the page as it is: the button says so and tries again when pressed.
 */
export function QrButton(props: { value: string; what: string; colour?: string | null }) {
  const id = createUniqueId();
  const [state, setState] = createSignal<"closed" | "loading" | "open" | "failed">("closed");
  let button: HTMLButtonElement | undefined;
  // Ends the wait under way and removes its listeners: a cancel, its end, or leaving the page.
  let stopWaiting: (() => void) | undefined;
  onCleanup(() => stopWaiting?.());

  const start = () => {
    stopWaiting?.();
    // This press's wish to open; the load it waits for is the page's, and goes on without it.
    const want = wish(loader);
    const giveUp = () => {
      stop();
      setState("closed");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") giveUp();
    };
    // Not focus alone: Safari does not focus a button it clicks, and a press on blank space leaves
    // focus on the page itself.
    const pointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node && button?.contains(e.target))) giveUp();
    };
    const focus = (e: FocusEvent) => {
      if (e.target !== button) giveUp();
    };
    const stop = () => {
      want.cancel();
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus);
      if (stopWaiting === stop) stopWaiting = undefined;
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus);
    stopWaiting = stop;
    setState("loading");
    void want.settled.then((outcome) => {
      if (outcome === "cancelled" || stopWaiting !== stop) return;
      stop();
      setState(outcome);
    });
  };

  const press = () => {
    const now = state();
    if (now === "open") setState("closed");
    else if (now === "loading") {
      stopWaiting?.();
      setState("closed");
    } else start();
  };

  const label = () =>
    state() === "failed"
      ? `The QR code could not be loaded. Try again to show the ${props.what} as a QR code`
      : `Show the ${props.what} as a QR code`;

  return (
    <>
      <button
        ref={button}
        type="button"
        class="qr-button"
        title={label()}
        aria-label={label()}
        aria-expanded={state() === "open" ? "true" : "false"}
        aria-controls={state() === "open" ? id : undefined}
        aria-busy={state() === "loading" ? "true" : "false"}
        data-state={state()}
        onClick={press}
      >
        <Show
          when={state() === "failed"}
          fallback={
            <svg viewBox="0 0 15 15" aria-hidden="true">
              <rect x="1" y="1" width="5" height="5" rx="1.5" />
              <rect x="9" y="1" width="5" height="5" rx="1.5" />
              <rect x="1" y="9" width="5" height="5" rx="1.5" />
              <path
                class="qr-button__dots"
                d="M9 9h2v2H9zM12 12h2v2h-2zM12 9h2v2h-2zM9 12h2v2H9z"
              />
            </svg>
          }
        >
          <svg viewBox="0 0 15 15" aria-hidden="true">
            <path d="M4 4l7 7M11 4l-7 7" />
          </svg>
          <span class="qr-button__note" aria-hidden="true">
            Not loaded
          </span>
        </Show>
        <span class="visually-hidden" aria-live="polite">
          {state() === "failed" ? "The QR code could not be loaded" : ""}
        </span>
      </button>
      <Show when={state() === "open" && button}>
        {(anchor) => (
          <Loading>
            <QrPop
              id={id}
              value={props.value}
              what={props.what}
              anchor={anchor()}
              onClose={() => setState("closed")}
              {...(props.colour === undefined ? {} : { colour: props.colour })}
            />
          </Loading>
        )}
      </Show>
    </>
  );
}
