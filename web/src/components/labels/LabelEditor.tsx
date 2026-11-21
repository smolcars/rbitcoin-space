// The label editor, loaded on first use by `LabelControl` and the manager. It writes to this
// browser's store only; the form has no action and nothing it holds goes into a URL.
import { createSignal, createUniqueId, onSettled, Show } from "solid-js";
import { MAX_LABEL } from "../../lib/labels/bip329";
import { failureWords, setLabel } from "../../lib/labels/db";
import { paths } from "../../lib/network";
import { Link } from "../Link";
import type { EditorProps } from "./Label";

export function LabelEditor(props: EditorProps) {
  const id = createUniqueId();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let field: HTMLInputElement | undefined;
  onSettled(() => {
    field?.focus();
    field?.select();
  });
  const write = (text: string | null, said: string) => {
    setBusy(true);
    setError("");
    void setLabel(props.type, props.reference, text, props.record)
      .then(() => props.done(said))
      .catch((e: unknown) => {
        setError(failureWords(e, "The label could not be saved. Try again."));
      })
      .finally(() => setBusy(false));
  };
  const save = (e: SubmitEvent) => {
    e.preventDefault();
    const text = field?.value ?? "";
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
        value={props.current ?? ""}
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
      <Show when={error()}>
        <p class="label-editor__error" role="alert">
          {error()}
        </p>
      </Show>
    </form>
  );
}
