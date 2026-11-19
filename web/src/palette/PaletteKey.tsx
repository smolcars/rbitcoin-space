// The way into the command palette that ships with the shell: the ⌘K / Ctrl K shortcut and the
// header's controls. The palette itself (Palette.tsx) and its logic load on first open. Whether it
// is shown is opener.ts's state machine: this file only feeds it events and draws its state.
import { useBeforeLeave } from "@solidjs/router";
import { dynamic } from "@solidjs/web";
import { type Component, createSignal, For, onSettled } from "solid-js";
import { IDLE, type Opener, type OpenerEvent, step } from "./opener";
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

let loading: Promise<Component<PaletteProps>> | undefined;
const load = () => {
  loading ??= (async () => {
    try {
      return (await import("./Palette")).default;
    } catch (error) {
      loading = undefined;
      throw error;
    }
  })();
  return loading;
};
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
  // The machine's state, kept in a plain variable too: a write is seen only after the flush.
  let now: Opener = IDLE;
  const [state, setState] = createSignal<Opener>(IDLE);
  const [session, setSession] = createSignal<Session>();
  const Shown = dynamic(() => session()?.C);
  let code: Component<PaletteProps> | undefined;
  // What the next palette starts with: the text at the last press.
  let initial = "";

  const send = (event: OpenerEvent) => {
    const before = now;
    const after = step(before, event);
    if (after === before) return;
    now = after;
    setState(after);
    if (before.kind === "idle" && after.kind === "loading") {
      load().then(
        (C) => {
          code = C;
          send("arrived");
        },
        () => send("failed"),
      );
    }
    if (after.kind === "open" && before.kind !== "open" && code) {
      setSession({ C: code, initial });
    }
    if (after.kind === "idle") setSession(undefined);
  };
  const press = (text: string) => {
    initial = text;
    send("press");
  };

  // Any navigation, Back included: nothing pending may open on the next page.
  useBeforeLeave(() => send("navigation"));

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
