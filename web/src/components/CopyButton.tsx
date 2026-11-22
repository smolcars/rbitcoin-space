import { createSignal, onCleanup, Show } from "solid-js";
import { copyText } from "../lib/copy";
import "./CopyButton.css";

const CONFIRM_MS = 1400;
const FAILED_MS = 3000;

/** Copies a value. Says "Copied" only when it was, and says so when it could not be. */
export function CopyButton(props: { value: string; label?: string }) {
  const [state, setState] = createSignal<"idle" | "copied" | "failed">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const copy = async () => {
    const copied = await copyText(props.value);
    setState(copied ? "copied" : "failed");
    clearTimeout(timer);
    timer = setTimeout(() => setState("idle"), copied ? CONFIRM_MS : FAILED_MS);
  };

  return (
    <button
      class="copy"
      type="button"
      onClick={() => void copy()}
      data-copied={state() === "copied" ? "" : undefined}
      data-failed={state() === "failed" ? "" : undefined}
      title={props.label ?? "Copy"}
    >
      <Show
        when={state() === "failed"}
        fallback={
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
            <path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" />
          </svg>
        }
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
        <span class="copy__note" aria-hidden="true">
          Not copied
        </span>
      </Show>
      {/* Seen beside the icon for a moment; the live region below says it to a screen reader. */}
      <Show when={state() === "copied"}>
        <span class="copy__note" aria-hidden="true">
          Copied
        </span>
      </Show>
      <span class="visually-hidden" aria-live="polite">
        {state() === "copied"
          ? "Copied"
          : state() === "failed"
            ? "Could not copy"
            : (props.label ?? "Copy")}
      </span>
    </button>
  );
}
