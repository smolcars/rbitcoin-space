// The way into the command palette that ships with the shell: the ⌘K / Ctrl K shortcut and the
// header's controls. The palette itself (Palette.tsx) and its logic load on first open. Whether it
// is shown is opener.ts's state machine: this file only feeds it events and draws its state.
import { useBeforeLeave } from "@solidjs/router";
import { dynamic } from "@solidjs/web";
import { type Component, createSignal, For, onSettled } from "solid-js";
import { retryFiles } from "../lib/chunks";
import { createLoader, createOpener } from "./loader";
import { IDLE, type Opener } from "./opener";
import type { PaletteProps } from "./Palette";
import "./PaletteKey.css";

/** Apple's keyboards take ⌘K; every other takes Ctrl K, as the browser's own shortcuts do. */
const apple = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Whether a key press is the palette's shortcut on this platform. */
export function isPaletteKey(e: KeyboardEvent, onApple: boolean): boolean {
  // A key an input method is composing with belongs to it ("Process" where the flag is unset).
  if (e.altKey || e.shiftKey || e.isComposing || e.key === "Process" || e.key === undefined) {
    return false;
  }
  const k = e.key.toLowerCase() === "k" || e.code === "KeyK";
  return k && (onApple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
}

/** Whether Palette.css is applied: it gives `.palette-probe` a custom property of its own. */
function styled(): boolean {
  const probe = document.createElement("span");
  probe.className = "palette-probe";
  document.body.append(probe);
  const on = getComputedStyle(probe).getPropertyValue("--palette-styled").trim() === "1";
  probe.remove();
  return on;
}

/**
 * The palette's code, loaded once and shared by a hover's warm-up and every press (loader.ts):
 * files that failed before are asked for again first, so a stylesheet that failed offline does
 * not leave the palette unstyled for the life of the page.
 */
const load = createLoader<Component<PaletteProps>>({
  // Its own files only (the chunk is named for Palette.tsx): a page's failed files stay on the
  // list for the shell, which is waiting to ask for them and needs to hear what they proved.
  retry: () => retryFiles((href) => /\/Palette-[^/]*\.(?:css|js)$/.test(href)),
  load: async () => (await import("./Palette")).default,
  styled,
});
const warm = () => void load().catch(() => undefined);

/** One time the palette is shown: a new one is a fresh palette. */
interface Session {
  C: Component<PaletteProps>;
  initial: string;
}

export function PaletteKey(props: {
  /** The header search's text when it has focus: the shortcut's palette starts from it. */
  typed: () => string;
  /** The header search's text, focused or not: "Go to" hands it on. */
  query: () => string;
}) {
  const onApple = apple();
  const [state, setState] = createSignal<Opener>(IDLE);
  const [session, setSession] = createSignal<Session>();
  const Shown = dynamic(() => session()?.C);
  // What the next palette starts with: the text at the last press.
  let initial = "";
  let was: Opener["kind"] = "idle";
  const { send } = createOpener(load, (after, code) => {
    setState(after);
    if (after.kind === "open" && was !== "open" && code) setSession({ C: code, initial });
    if (after.kind === "idle") setSession(undefined);
    was = after.kind;
  });
  const press = (text: string) => {
    initial = text;
    send("press");
  };

  // Any navigation, Back included: nothing pending may open on the next page.
  useBeforeLeave(() => send("navigation"));

  // "Go to" hangs from the header's edge (PaletteKey.css): it is placed under the search field,
  // measured whenever the search takes focus, the window changes size or the field does.
  let go: HTMLButtonElement | undefined;
  onSettled(() => {
    const el = go;
    const header = el?.closest("header");
    const cell = el?.parentElement;
    if (!el || !header || !cell) return undefined;
    const place = () => {
      const field = cell.querySelector(".search__field")?.getBoundingClientRect();
      if (!field) return;
      const left = field.left - header.getBoundingClientRect().left;
      el.style.setProperty("--go-left", `${Math.round(left)}px`);
      el.style.setProperty("--go-width", `${Math.round(field.width)}px`);
    };
    cell.addEventListener("focusin", place);
    window.addEventListener("resize", place, { passive: true });
    // The field also changes size with the window still: sections arriving beside it narrow it.
    const field = cell.querySelector(".search__field");
    const sized = typeof ResizeObserver === "function" ? new ResizeObserver(place) : undefined;
    if (field) sized?.observe(field);
    return () => {
      cell.removeEventListener("focusin", place);
      window.removeEventListener("resize", place);
      sized?.disconnect();
    };
  });

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        send("escape");
        return;
      }
      if (!isPaletteKey(e, onApple)) return;
      e.preventDefault();
      // A held key repeats: only its first press counts.
      if (!e.repeat) press(props.typed());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const hint = onApple ? ["⌘", "K"] : ["Ctrl", "K"];
  return (
    <>
      <button
        type="button"
        class="palette-hint"
        aria-label="Go to"
        aria-keyshortcuts={onApple ? "Meta+K" : "Control+K"}
        title={`Go to a page, pool, date or ID (${hint.join(onApple ? "" : " ")})`}
        onPointerEnter={warm}
        onFocus={warm}
        onClick={() => press("")}
      >
        {hint.map((k) => (
          <kbd>{k}</kbd>
        ))}
      </button>
      {/* Where there is no room for the hint: hangs under the search while it, or this, has
          focus, over the page, moving nothing; next after the search in the Tab order. */}
      <button
        ref={go}
        type="button"
        class="palette-go"
        onPointerDown={(e) => {
          // A press keeps focus in the search, so the control stays under the finger.
          e.preventDefault();
          warm();
        }}
        onFocus={warm}
        onClick={() => press(props.query())}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h9" />
        </svg>
        Go to a page, pool or date
      </button>
      {/* Keyed by the session, so a palette opened again is a fresh one. */}
      <For each={session() ? [session()] : []}>
        {() => (
          <Shown
            initial={session()?.initial ?? ""}
            closing={state().kind === "closing"}
            onDismiss={() => send("escape")}
            onClosed={() => send("closed")}
          />
        )}
      </For>
    </>
  );
}
