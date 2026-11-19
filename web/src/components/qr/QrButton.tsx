import { createSignal, createUniqueId, lazy, Loading, Show } from "solid-js";
import "./QrButton.css";

// The pop-up, the encoder and the drawing load on first use: no page's first load carries them.
const QrPop = lazy(() => import("./QrPop"));

/**
 * A button that shows `value` as a QR code in a pop-up beside it, with the value as text under the
 * code. `what` names the value ("address"). `colour`, a node's checked `#rrggbb` (null for none
 * announced), draws the code; leave it out for the site's ink.
 */
export function QrButton(props: { value: string; what: string; colour?: string | null }) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        class="qr-button"
        title={`Show the ${props.what} as a QR code`}
        aria-label={`Show the ${props.what} as a QR code`}
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 15 15" aria-hidden="true">
          <rect x="1" y="1" width="5" height="5" rx="1.5" />
          <rect x="9" y="1" width="5" height="5" rx="1.5" />
          <rect x="1" y="9" width="5" height="5" rx="1.5" />
          <path class="qr-button__dots" d="M9 9h2v2H9zM12 12h2v2h-2zM12 9h2v2h-2zM9 12h2v2H9z" />
        </svg>
      </button>
      <Show when={open() && button}>
        {(anchor) => (
          <Loading>
            <QrPop
              id={id}
              value={props.value}
              what={props.what}
              anchor={anchor()}
              onClose={() => setOpen(false)}
              {...(props.colour === undefined ? {} : { colour: props.colour })}
            />
          </Loading>
        )}
      </Show>
    </>
  );
}
