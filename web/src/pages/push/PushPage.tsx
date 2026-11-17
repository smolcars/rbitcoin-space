// Broadcast a transaction (docs/FRONTEND.md "Broadcast"). The pasted hex stays in this page: in no
// URL, sent in a POST body to be checked, and broadcast only when the reader presses the button.
// The decoder may hand it over in the history entry's state (`{ hex }`), never in the URL.
import { useLocation } from "@solidjs/router";
import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { ErrorState, Loading } from "../../components/States";
import { ApiError, createRequest, postApp } from "../../lib/api";
import { loadConfig } from "../../lib/config";
import { useNetwork, usePageTitle } from "../../lib/page";
import { CheckedTx } from "./CheckedTx";
import { readChecked, readPasted } from "./push";

/** Typing waits for a pause before the check; a paste is checked at once. */
const TYPING_MS = 400;

export default function PushPage() {
  usePageTitle(() => "Broadcast");
  const network = useNetwork();
  const given = useLocation<{ hex?: unknown }>().state?.hex;
  const handed = typeof given === "string" ? given : "";
  const [text, setText] = createSignal(handed);
  const [asked, setAsked] = createSignal(handed);
  let pasting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const pasted = () => readPasted(asked());
  const bad = () => {
    const p = pasted();
    return p.kind === "bad" ? p.why : undefined;
  };
  const current = () => {
    const p = readPasted(text());
    return p.kind === "hex" ? p.hex : undefined;
  };

  const [enabled, setEnabled] = createSignal<boolean | undefined>(undefined);
  void loadConfig().then((c) => setEnabled(c?.broadcast ?? false));

  const [checked, { refetch }] = createRequest(
    () => {
      const p = pasted();
      return p.kind === "hex" ? `${network()}:${p.hex}` : false;
    },
    async (key, signal) => {
      const hex = key.slice(key.indexOf(":") + 1);
      const v = await postApp<unknown>(network(), "/tx/check", hex, { signal });
      const c = readChecked(v);
      if (c === null) throw new ApiError(0, "The answer could not be read.");
      return { hex, ...c };
    },
  );

  const onInput = (value: string) => {
    setText(value);
    clearTimeout(timer);
    timer = setTimeout(() => setAsked(value), pasting ? 0 : TYPING_MS);
    pasting = false;
  };

  return (
    <div class="wrap push">
      <h1>Broadcast a transaction</h1>
      <textarea
        class="push__input mono"
        name="hex"
        rows="4"
        aria-label="Signed transaction in hex"
        placeholder="Paste a signed transaction in hex"
        autocomplete="off"
        spellcheck={false}
        autocapitalize="off"
        value={text()}
        onPaste={() => {
          pasting = true;
        }}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      <Show when={enabled() === false}>
        <p class="push__line">This server does not broadcast. It can still read a transaction.</p>
      </Show>
      <Switch>
        <Match when={bad()}>{(why) => <p class="push__line">{why()}</p>}</Match>
        <Match when={pasted().kind === "empty"}>{null}</Match>
        <Match when={checked.state === "errored"}>
          <ErrorState title="Could not read it" error={checked.error} retry={refetch} />
        </Match>
        {/* Never the last answer beside a box that holds another transaction. */}
        <Match when={checked.loading || checked.latest?.hex !== current()}>
          <Loading label="Reading" />
        </Match>
        <Match when={checked.latest}>
          {(c) => <CheckedTx c={c()} hex={c().hex} enabled={enabled() === true} />}
        </Match>
      </Switch>
    </div>
  );
}
