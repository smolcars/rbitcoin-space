// The Ark entry (docs/DESIGN.md "Ark"): one box. What is pasted decides the page it opens, so a
// visitor never has to know which implementation they hold.
import { useNavigate } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { Empty } from "../../components/States";
import { createRequest } from "../../lib/api";
import { loadConfig } from "../../lib/config";
import { onNetwork } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { classify, destination, refusal } from "./paste";
import "./Ark.css";

export default function ArkPage() {
  usePageTitle(() => "Ark");
  const network = useNetwork();
  const navigate = useNavigate();
  const [config] = createRequest(() => true, loadConfig);
  const offered = () => (config()?.ark[network()]?.length ?? 0) > 0;
  const [bad, setBad] = createSignal<string | undefined>(undefined);

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const value = new FormData(form).get("paste");
    if (typeof value !== "string" || value.trim() === "") return;
    const pasted = classify(value, network());
    const to = destination(pasted);
    setBad(refusal(pasted));
    if (to !== undefined) navigate(onNetwork(network(), to));
  };

  return (
    <div class="wrap ark-entry">
      <h1>Ark</h1>
      {/* The box is there while the config loads: reading a paste needs only the network. */}
      <Show
        when={config.loading || offered()}
        fallback={<Empty title="No Ark server is set up on this network" />}
      >
        <form class="panel ark-entry__form" onSubmit={submit} novalidate>
          <input
            name="paste"
            class="ark-entry__input mono"
            aria-label="VTXO or Ark address"
            placeholder="VTXO ID, hex or Ark address"
            autocomplete="off"
            spellcheck="false"
            autocapitalize="off"
            aria-invalid={bad() === undefined ? "false" : "true"}
            aria-describedby={bad() === undefined ? undefined : "ark-paste-bad"}
            onInput={() => setBad(undefined)}
          />
          <Show when={bad()}>
            {(text) => (
              <p id="ark-paste-bad" class="ark-entry__bad" role="alert">
                {text()}
              </p>
            )}
          </Show>
          <button class="btn btn--accent ark-entry__open" type="submit">
            Open
          </button>
        </form>
      </Show>
    </div>
  );
}
