import { createSignal, createUniqueId, lazy, Loading, onCleanup, Show } from "solid-js";
import { retryFiles } from "../../lib/chunks";
import type QrPopView from "./QrPop";
import "./QrButton.css";

// The pop-up, the encoder and the drawing load on first use: no page's first load carries them.
// The button loads them itself, so a failed download is its own to report and the page is left as
// it is; `lazy` is handed only a module that has already arrived.
interface PopModule {
  default: typeof QrPopView;
}
let pending: Promise<PopModule> | undefined;
let loaded: PopModule | undefined;
const QrPop = lazy(async () => loaded ?? (await loadPop()));

/**
 * Loads the pop-up's module, once for the page. After a failure, asks again for every file that
 * failed first (a failed stylesheet is never asked for again by itself, docs/FRONTEND.md, "When a
 * page's files fail to load"), then for the module.
 */
async function loadPop(): Promise<PopModule> {
  if (loaded) return loaded;
  pending ??= import("./QrPop");
  try {
    loaded = await pending;
    return loaded;
  } catch (e) {
    pending = undefined;
    throw e;
  }
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

  const start = async () => {
    stopWaiting?.();
    let waiting = true;
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
      waiting = false;
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
    try {
      // Every press that has not loaded the pop-up asks again for whatever failed, however the
      // last attempt ended: a cancelled one can leave a failed stylesheet that Vite never retries.
      if (!loaded) await retryFiles();
      await loadPop();
      if (!waiting) return;
      stop();
      setState("open");
    } catch {
      if (!waiting) return;
      stop();
      setState("failed");
    }
  };

  const press = () => {
    const now = state();
    if (now === "open") setState("closed");
    else if (now === "loading") {
      stopWaiting?.();
      setState("closed");
    } else void start();
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
