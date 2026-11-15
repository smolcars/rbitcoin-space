// Looking up an Ark VTXO by its id (docs/DESIGN.md "Ark"): one field, and a tab for each
// implementation the network has.
import { useNavigate } from "@solidjs/router";
import { createSignal, For, Show } from "solid-js";
import { Empty } from "../../components/States";
import { createRequest } from "../../lib/api";
import { loadConfig } from "../../lib/config";
import { onNetwork } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { type ArkImplementation, offered } from "./implementations";
import { readVtxoId } from "./bark/vtxo";
import "./Ark.css";

export default function ArkPage() {
  usePageTitle(() => "Ark VTXO");
  const network = useNetwork();
  const navigate = useNavigate();
  const [config] = createRequest(() => true, loadConfig);
  const choices = () => offered(config()?.ark[network()]);
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const current = (): ArkImplementation | undefined =>
    choices().find((i) => i.id === picked()) ?? choices()[0];
  const [bad, setBad] = createSignal(false);

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const impl = current();
    const form = e.currentTarget;
    if (!impl || !(form instanceof HTMLFormElement)) return;
    const value = new FormData(form).get("vtxo");
    const id = typeof value === "string" ? readVtxoId(value) : null;
    setBad(id === null);
    if (id !== null) navigate(onNetwork(network(), impl.vtxo(id)));
  };

  return (
    <div class="wrap ark-entry">
      <h1>Ark VTXO</h1>
      <Show
        when={!config.loading}
        fallback={<div class="ark-entry__panel panel ark-entry__panel--waiting" />}
      >
        <Show when={current()} fallback={<Empty title="No Ark server is set up on this network" />}>
          {(impl) => (
            <div class="ark-entry__panel panel">
              <Show when={choices().length > 1}>
                <div class="ark-entry__tabs" role="group" aria-label="Implementation">
                  <For each={choices()}>
                    {(i) => (
                      <button
                        type="button"
                        class="ark-entry__tab"
                        aria-pressed={i.id === impl().id ? "true" : "false"}
                        onClick={() => setPicked(i.id)}
                      >
                        {i.name}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <form class="ark-entry__form" onSubmit={submit} novalidate>
                <label class="ark-entry__label" for="ark-vtxo">
                  {impl().name} VTXO ID
                </label>
                <input
                  id="ark-vtxo"
                  name="vtxo"
                  class="ark-entry__input mono"
                  placeholder="txid:vout"
                  autocomplete="off"
                  spellcheck="false"
                  autocapitalize="off"
                  aria-invalid={bad() ? "true" : "false"}
                  aria-describedby={bad() ? "ark-vtxo-bad" : undefined}
                  onInput={() => setBad(false)}
                />
                <Show when={bad()}>
                  <p id="ark-vtxo-bad" class="ark-entry__bad" role="alert">
                    Not a VTXO ID
                  </p>
                </Show>
                <button class="btn btn--accent ark-entry__open" type="submit">
                  Open
                </button>
              </form>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
