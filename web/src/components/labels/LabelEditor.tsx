// The label editor, loaded on first use by `LabelControl` and the manager. It writes to this
// browser's store only; the form has no action and nothing it holds goes into a URL.
import { createSignal, createUniqueId, onCleanup, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { shownLabel } from "../../lib/labels";
import { MAX_LABEL } from "../../lib/labels/bip329";
import { failureWords, setLabel } from "../../lib/labels/db";
import { paths } from "../../lib/network";
import { Link } from "../Link";
import { openPop } from "../pop";
import type { EditorProps } from "./Label";

export function LabelEditor(props: EditorProps) {
  const id = createUniqueId();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let field: HTMLInputElement | undefined;
  // The label as it was when the editor opened: a change landing later (another tab, a save that
  // ended late) never overwrites what is being typed.
  const initial = untrack(() => props.current) ?? "";
  onSettled(() => {
    field?.focus();
    field?.select();
  });
  // A save ends on this editor only: once it is closed, its save's end changes nothing, so it
  // can never close an editor opened after it, nor lose what is typed there.
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const write = (text: string | null, said: string) => {
    setBusy(true);
    setError("");
    void setLabel(props.type, props.reference, text, props.record)
      .then(({ shown }) => {
        if (!alive) return;
        // Saved when its write committed; said so even if this page could not read it back yet.
        props.done(shown ? said : `${said}. This page could not show it yet.`);
      })
      .catch((e: unknown) => {
        if (alive) setError(failureWords(e, "The label could not be saved. Try again."));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
  };
  const save = (e: SubmitEvent) => {
    e.preventDefault();
    const text = field?.value ?? "";
    // Unchanged from what the editor opened with: nothing to write, so nothing is written. A
    // label another tab saved meanwhile stays; only a deliberate edit replaces it.
    if (text === initial) {
      props.done();
      return;
    }
    if (text.trim() === "") {
      if (props.current === undefined) props.done();
      else write(null, "Label removed");
      return;
    }
    write(text, "Label saved");
  };
  return (
    <form class="label-editor" onSubmit={save}>
      <label class="label-editor__name" for={`${id}-field`}>
        Your label for {props.what}
      </label>
      <input
        ref={field}
        id={`${id}-field`}
        class="label-editor__field"
        type="text"
        value={initial}
        maxlength={MAX_LABEL}
        autocomplete="off"
        spellcheck="false"
        aria-describedby={`${id}-note`}
        aria-invalid={error() === "" ? "false" : "true"}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.done();
          }
        }}
      />
      <div class="label-editor__actions">
        <button type="submit" class="btn btn--accent" disabled={busy()}>
          Save label
        </button>
        {/* Always there, so the editor lays out the same with a label or without one: whether a
            label exists never moves what follows the page's head. */}
        <button
          type="button"
          class="btn"
          disabled={busy() || props.current === undefined}
          onClick={() => write(null, "Label removed")}
        >
          Remove label
        </button>
        <button type="button" class="btn" onClick={() => props.done()}>
          Cancel
        </button>
      </div>
      <p class="label-editor__note" id={`${id}-note`}>
        Only this browser keeps it; it is never sent to the server.{" "}
        <Link href={paths.labels()}>All your labels</Link>
      </p>
      <Show when={props.elsewhere !== undefined}>
        <p class="label-editor__elsewhere" role="status">
          {props.elsewhere === null || props.elsewhere === undefined
            ? "This label was removed elsewhere since you opened it. Saving puts back what you type."
            : `This label was changed elsewhere since you opened it, to “${shownLabel(props.elsewhere, 80)}”. Saving replaces it with what you type.`}
        </p>
      </Show>
      <Show when={error()}>
        <p class="label-editor__error" role="alert">
          {error()}
        </p>
      </Show>
    </form>
  );
}

/** Room kept between the pop-up and the screen's edges, and between it and its button, in px. */
const EDGE = 8;
const GAP = 6;

/**
 * The editor of a page's head, over the page beside its button (`anchor`), taking no room in it:
 * whatever it shows (its field, its buttons, an error) moves nothing on the page, so nothing that
 * loads by position (the address page's balance chart) can depend on it. Below its button, or
 * above it where the room below is short, always inside the window. A press outside, Escape (focus
 * back to the button) or a scroll that carries the button away closes it (components/pop.ts).
 */
export function EditorPop(props: {
  id: string;
  /** Its name, for the dialog it is: "Your label for this transaction". */
  name: string;
  anchor: HTMLElement;
  /** Closed without a save: Escape, a press outside, a scroll. */
  onClose: () => void;
  children: JSX.Element;
}) {
  let pop: HTMLDivElement | undefined;
  let close: (() => void) | undefined;
  let leaving = false;
  const place = () => {
    if (!pop) return;
    const b = props.anchor.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const site = document.querySelector(".site-header");
    const sticky = site !== null && getComputedStyle(site).position === "sticky";
    const top = Math.max(EDGE, (sticky ? site.getBoundingClientRect().bottom : 0) + GAP);
    const x = Math.max(EDGE, Math.min(b.left, width - pw - EDGE));
    let y = b.bottom + GAP;
    if (y + ph > height - EDGE && b.top - GAP - ph >= top) y = b.top - GAP - ph;
    y = Math.max(top, Math.min(y, height - EDGE - ph));
    pop.style.setProperty("--x", `${Math.round(x)}px`);
    pop.style.setProperty("--y", `${Math.round(y)}px`);
  };
  window.addEventListener("resize", place, { passive: true });
  onCleanup(() => window.removeEventListener("resize", place));
  onSettled(() => {
    place();
    // An error shown after a save makes it taller: it is placed again, still over the page.
    const grows = new ResizeObserver(place);
    if (pop) grows.observe(pop);
    close = openPop(
      () => {
        close = undefined;
        grows.disconnect();
        if (pop?.contains(document.activeElement) === true)
          props.anchor.focus({ preventScroll: true });
        if (!leaving) props.onClose();
      },
      () => [props.anchor, pop],
      { scroll: true, absorb: true, follow: true },
    );
  });
  onCleanup(() => {
    leaving = true;
    close?.();
  });
  return (
    // A dialog that leaves the page usable around it (non-modal), named as its field is.
    <div ref={pop} id={props.id} class="label-pop" role="dialog" aria-label={props.name}>
      {props.children}
    </div>
  );
}
