// The reader's own label beside what it names, and the control that sets it (docs/FRONTEND.md
// "Your labels"). In the shell's group: small, and on most pages that show a hash. The editor it
// opens loads on first use.
import { type Component, createSignal, createUniqueId, Show } from "solid-js";
import { labelOf, type Shown, shownLabel } from "../../lib/labels";
import "../Button.css";
import "./Label.css";

/** Characters of a label shown in a list or on a card; the whole label is in the title. */
export const LABEL_IN_LIST = 40;
/** Characters of a label shown beside a page's subject. */
export const LABEL_IN_HEAD = 120;

/**
 * A label, marked as the reader's own: a tag shape no part of the site's own interface uses, and
 * "Your label" before it for screen readers. Only ever a text node.
 */
export function YourLabel(props: { text: string; max?: number }) {
  return (
    <span
      class="your-label"
      title={`Your label, kept in this browser: ${shownLabel(props.text, 1000)}`}
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

export interface EditorProps {
  type: string;
  reference: string;
  /** The record to change, when it is not the one pages show for the reference. */
  record?: string;
  what: string;
  current: string | undefined;
  /** Closes the editor; `said` is announced, such as "Label saved". */
  done: (said?: string) => void;
}

/**
 * A subject's label and the quiet button that adds, edits or removes it. `what` names the subject
 * in the editor's words: "this transaction", "output 3".
 */
export function LabelControl(props: { type: Shown; reference: string; what: string }) {
  const id = createUniqueId();
  const label = () => labelOf(props.type, props.reference);
  const [editor, setEditor] = createSignal<{ C: Component<EditorProps> } | undefined>();
  const [open, setOpen] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [said, setSaid] = createSignal("");
  let button: HTMLButtonElement | undefined;
  const start = () => {
    setSaid("");
    setFailed(false);
    if (open()) {
      setOpen(false);
      return;
    }
    import("./LabelEditor")
      .then((m) => {
        setEditor({ C: m.LabelEditor });
        setOpen(true);
      })
      .catch(() => setFailed(true));
  };
  const done = (words?: string) => {
    setOpen(false);
    if (words !== undefined) setSaid(words);
    button?.focus();
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
        {label() === undefined ? "Add a label" : "Edit label"}
      </button>
      <span class="visually-hidden" role="status">
        {said()}
      </span>
      <div id={id} class="label-control__editor" hidden={!open() && !failed()}>
        <Show when={failed()}>
          <p class="label-control__failed">The editor could not be loaded. Try again.</p>
        </Show>
        <Show when={open() && editor()}>
          {(e) => {
            const C = e().C;
            return (
              <C
                type={props.type}
                reference={props.reference}
                what={props.what}
                current={label()}
                done={done}
              />
            );
          }}
        </Show>
      </div>
    </div>
  );
}
