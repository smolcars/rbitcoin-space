// The way into the command palette that ships with the shell: the ⌘K / Ctrl K shortcut and the
// header's controls. The palette itself (Palette.tsx) and its logic load on first open.
import { dynamic } from "@solidjs/web";
import { type Component, createSignal, onSettled, Show } from "solid-js";
import type { PaletteProps } from "./Palette";
import "./PaletteKey.css";

/** Apple's keyboards take ⌘K; every other takes Ctrl K, as the browser's own shortcuts do. */
const apple = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Whether a key press is the palette's shortcut on this platform. */
export function isPaletteKey(e: KeyboardEvent, onApple: boolean): boolean {
  if (e.altKey || e.shiftKey || e.key === undefined) return false;
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

export function PaletteKey(props: {
  /** The header search's text, when it has focus: the palette starts from it. */
  typed: () => string;
}) {
  const onApple = apple();
  const [view, setView] = createSignal<{ C: Component<PaletteProps>; initial: string }>();
  const Shown = dynamic(() => view()?.C);
  let closeOpen: (() => void) | undefined;
  let opening = false;

  const open = async (initial: string) => {
    if (view() !== undefined || opening) return;
    opening = true;
    try {
      const C = await load();
      setView({ C, initial });
    } catch {
      // Offline or a deploy replaced the file: the next press asks again.
    } finally {
      opening = false;
    }
  };
  const toggle = () => {
    if (closeOpen) closeOpen();
    else void open(props.typed());
  };

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteKey(e, onApple)) return;
      e.preventDefault();
      toggle();
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
        onClick={() => void open("")}
      >
        {hint.map((k) => (
          <kbd>{k}</kbd>
        ))}
      </button>
      {/* A phone has no shortcut: while its search is open, this takes what is typed there on. */}
      <button
        type="button"
        class="palette-phone btn"
        title="Go to a page, pool, date or ID"
        onPointerDown={(e) => {
          // The search keeps focus, so the row does not fold away under the finger.
          e.preventDefault();
          warm();
        }}
        onClick={() => void open(props.typed())}
      >
        Go to
      </button>
      <Show when={view()}>
        {(v) => (
          <Shown
            initial={v().initial}
            control={(close) => (closeOpen = close)}
            onClosed={() => {
              closeOpen = undefined;
              setView(undefined);
            }}
          />
        )}
      </Show>
    </>
  );
}
