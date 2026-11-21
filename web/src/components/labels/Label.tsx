// The reader's own label beside what it names, and the control that sets it (docs/FRONTEND.md
// "Your labels"). In the shell's group: small, and on most pages that show a hash. The editor it
// opens loads on first use.
import { type Component, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { labelOf, type Opened, type Shown, shownLabel, shownRecord } from "../../lib/labels";
import "../Button.css";
import "./Label.css";

/** Characters of a label shown in a list or on a card; the whole label is in the title. */
export const LABEL_IN_LIST = 40;
/** Characters of a label shown beside a page's subject; its row cuts it shorter where it must. */
export const LABEL_IN_HEAD = 120;
/** Characters of a label in its tooltip: the editor's limit, so a label typed here shows whole. */
export const LABEL_IN_TITLE = 255;

/**
 * A label, marked as the reader's own: a tag shape no part of the site's own interface uses, and
 * "Your label" before it for screen readers. Only ever a text node.
 */
export function YourLabel(props: { text: string; max?: number }) {
  return (
    <span
      class="your-label"
      title={`Your label, kept in this browser: ${shownLabel(props.text, LABEL_IN_TITLE)}`}
    >
      <span class="visually-hidden">Your label: </span>
      <span class="your-label__text" dir="auto">
        {shownLabel(props.text, props.max ?? LABEL_IN_LIST)}
      </span>
    </span>
  );
}

/** The first of these references that the reader labelled, as `YourLabel`; nothing otherwise. */
export function LabelOf(props: {
  refs: readonly (readonly [Shown, string | undefined])[];
  max?: number;
  class?: string;
}) {
  const found = () => {
    for (const [type, ref] of props.refs) {
      const l = ref === undefined ? undefined : labelOf(type, ref);
      if (l !== undefined) return l;
    }
    return undefined;
  };
  return (
    <Show when={found()}>
      {(l) => (
        <span class={props.class}>
          <YourLabel text={l()} {...(props.max === undefined ? {} : { max: props.max })} />
        </span>
      )}
    </Show>
  );
}

/** What another tab did to a label while it was being edited: changed its text, or took it off. */
export type Elsewhere = { changed: string } | { removed: true };

export interface EditorProps {
  type: string;
  reference: string;
  /** The record to change, when it is not the one pages show for the reference. */
  record?: string;
  what: string;
  current: string | undefined;
  /** The record the editor opens on, by key and place, or `null` for none: a save applies only to it. */
  opened: Opened | null;
  /** What another tab did to this label while it was being edited. */
  elsewhere?: Elsewhere;
  /** Told what the field holds, as it opens and as it is typed in (the manager keeps the draft). */
  draft?: (text: string) => void;
  /**
   * Called with the draft, instead of an error, when the save is refused because the record
   * `record` names is gone: the manager closes the editor and gives the reader their words back.
   */
  gone?: (text: string) => void;
  /** Closes the editor; `said` is announced, such as "Label saved". */
  done: (said?: string) => void;
}

interface EditorModule {
  LabelEditor: Component<EditorProps>;
  EditorPop: Component<{
    id: string;
    name: string;
    anchor: HTMLElement;
    onClose: () => void;
    children: JSX.Element;
  }>;
}

/**
 * A subject's label and the quiet button that adds, edits or removes it, on one line. The editor
 * opens over the page (`EditorPop`), so this line is the only room the control ever takes: no
 * label, editor or error can move what follows it. `what` names the subject in the editor's
 * words: "this transaction", "output 3".
 */
export function LabelControl(props: { type: Shown; reference: string; what: string }) {
  const id = createUniqueId();
  const label = () => labelOf(props.type, props.reference);
  const [editor, setEditor] = createSignal<EditorModule | undefined>();
  const [open, setOpen] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [said, setSaid] = createSignal("");
  let button: HTMLButtonElement | undefined;
  // Each opening is a session: a save that ends after its editor was closed, or after another
  // was opened, acts on nothing.
  let session = 0;
  // While the editor's code downloads: what gives the wait up. Escape, a press anywhere else,
  // focus moving elsewhere, or the button pressed again: the editor then never opens.
  let giveUp: (() => void) | undefined;
  onCleanup(() => giveUp?.());
  const start = () => {
    setSaid("");
    setFailed(false);
    session++;
    if (giveUp) {
      giveUp();
      return;
    }
    if (open()) {
      setOpen(false);
      return;
    }
    let cancelled = false;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    const pointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node && button?.contains(e.target))) stop();
    };
    const focus = (e: FocusEvent) => {
      if (e.target !== button) stop();
    };
    const stop = () => {
      cancelled = true;
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus);
      if (giveUp === stop) giveUp = undefined;
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus);
    giveUp = stop;
    import("./LabelEditor")
      .then((m) => {
        if (cancelled) return;
        stop();
        setEditor({ LabelEditor: m.LabelEditor, EditorPop: m.EditorPop });
        setOpen(true);
      })
      .catch(() => {
        if (cancelled) return;
        stop();
        setFailed(true);
      });
  };
  const finish = () => {
    session++;
    setOpen(false);
  };
  return (
    <div class="label-control">
      <Show when={label()}>{(l) => <YourLabel text={l()} max={LABEL_IN_HEAD} />}</Show>
      <button
        ref={button}
        type="button"
        class="label-control__open"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id}
        onClick={start}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6z" />
          <circle cx="5.3" cy="5.3" r="0.9" />
        </svg>
        {/* A failed download says so in the button itself, on its one line. */}
        {failed()
          ? "Editor not loaded, try again"
          : label() === undefined
            ? "Add a label"
            : "Edit label"}
      </button>
      <span class="visually-hidden" role="status">
        {said()}
      </span>
      <Show when={open() && button !== undefined && editor()}>
        {(m) => {
          const mine = session;
          const { LabelEditor, EditorPop } = m();
          const done = (words?: string) => {
            if (mine !== session) return;
            finish();
            if (words !== undefined) setSaid(words);
            button?.focus();
          };
          return (
            <EditorPop
              id={id}
              name={`Your label for ${props.what}`}
              anchor={button as HTMLElement}
              onClose={finish}
            >
              <LabelEditor
                type={props.type}
                reference={props.reference}
                what={props.what}
                current={label()}
                opened={shownRecord(props.type, props.reference) ?? null}
                done={done}
              />
            </EditorPop>
          );
        }}
      </Show>
    </div>
  );
}
