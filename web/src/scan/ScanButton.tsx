// The scan button inside the header search. It ships with the shell; the scanner it opens
// (Scanner.tsx, and the decoder that loads with it) is fetched on first press.
import { useBeforeLeave } from "@solidjs/router";
import { createEffect, createSignal, lazy, Loading, onCleanup, Show } from "solid-js";
import { retryFiles } from "../lib/chunks";
import { createLoader } from "../components/qr/load";
import type ScannerView from "./Scanner";

interface ScannerModule {
  default: typeof ScannerView;
}

/** Whether Scanner.css applies: it gives `.scanner-probe` a custom property of its own. */
function styled(): boolean {
  const probe = document.createElement("span");
  probe.className = "scanner-probe";
  document.body.append(probe);
  const on = getComputedStyle(probe).getPropertyValue("--scanner-styled").trim() === "1";
  probe.remove();
  return on;
}

// One load for the page, shared by every press; files that failed before are asked for again
// first, so a stylesheet that failed offline never opens an unstyled scanner (components/qr/load.ts).
const loader = createLoader<ScannerModule>({
  retryFailed: () => retryFiles((href) => /\/Scanner-[^/]*\.(?:css|js)$/.test(href)),
  importCode: async () => import("./Scanner"),
  styled,
});
const Scanner = lazy(async () => loader.loaded() ?? loader.load());

/**
 * Opens the QR scanner. `onScan` gets the text of the code read, which is attacker-controlled:
 * the search reads it as it reads anything typed. Leaving the page closes the scanner, and its
 * camera with it.
 */
export function ScanButton(props: { onScan: (text: string) => void }) {
  const [state, setState] = createSignal<"closed" | "loading" | "open" | "failed">("closed");
  // Each press is a new wish to open; a newer press, a close or leaving the page withdraws it.
  let wish = 0;
  let button: HTMLButtonElement | undefined;
  // Closed: focus comes back here once the dialog is gone, as its own closing hands it to whatever
  // had it before, the page itself after a press (which takes no focus, below).
  let refocus = false;
  createEffect(state, (now) => {
    if (now !== "closed" || !refocus) return;
    refocus = false;
    button?.focus({ preventScroll: true });
  });

  // While the scanner downloads, Escape gives up waiting for it, as it would close it.
  let stopEscape: (() => void) | undefined;
  const close = () => {
    wish += 1;
    stopEscape?.();
    setState("closed");
  };
  useBeforeLeave(close);
  onCleanup(() => {
    wish += 1;
    stopEscape?.();
  });

  const press = () => {
    if (state() === "loading" || state() === "open") {
      close();
      return;
    }
    wish += 1;
    const mine = wish;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", key);
    stopEscape = () => {
      document.removeEventListener("keydown", key);
      stopEscape = undefined;
    };
    setState("loading");
    loader.load().then(
      () => {
        if (mine !== wish) return;
        stopEscape?.();
        setState("open");
      },
      () => {
        if (mine !== wish) return;
        stopEscape?.();
        setState("failed");
      },
    );
  };

  const label = () =>
    state() === "failed"
      ? "The scanner could not be loaded. Try again to scan a QR code"
      : "Scan a QR code";

  return (
    <>
      <button
        ref={button}
        type="button"
        class="search__scan"
        title={label()}
        aria-label={label()}
        aria-haspopup="dialog"
        aria-busy={state() === "loading" ? "true" : "false"}
        data-state={state()}
        // A press keeps focus where it is: on the narrowest phones the button shows only while the
        // search has focus, and Safari, which never focuses a pressed button, would hide it
        // before the press ends.
        onPointerDown={(e) => e.preventDefault()}
        onClick={press}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M2.75 7V4.25a1.5 1.5 0 0 1 1.5-1.5H7M13 2.75h2.75a1.5 1.5 0 0 1 1.5 1.5V7M17.25 13v2.75a1.5 1.5 0 0 1-1.5 1.5H13M7 17.25H4.25a1.5 1.5 0 0 1-1.5-1.5V13" />
          <path class="search__scan-line" d="M5.5 10h9" />
        </svg>
      </button>
      <span class="visually-hidden" aria-live="polite">
        {state() === "failed" ? "The scanner could not be loaded" : ""}
      </span>
      <Show when={state() === "open"}>
        <Loading>
          <Scanner
            onClose={() => {
              refocus = true;
              close();
            }}
            onResult={(text) => {
              // Back on the button, so a code that leads nowhere leaves the reader in the search,
              // its answer next in the Tab order; one that leads to a page takes focus there.
              refocus = true;
              close();
              props.onScan(text);
            }}
          />
        </Loading>
      </Show>
    </>
  );
}
