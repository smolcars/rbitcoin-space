// What the transaction page says about the Lightning channels a transaction funded or closed.
import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { SectionHeader } from "../../components/SectionHeader";
import { closeWords, isTxChannels, type ListedChannel } from "./lightning";
import { ChannelLink, Ends } from "./parts";

export default function TxChannels(props: { found: unknown }) {
  const found = () => (isTxChannels(props.found) ? props.found : undefined);
  return (
    <Show when={found()}>
      {(f) => (
        <section class="ln-tx" aria-labelledby="ln-tx-title">
          <SectionHeader title="Lightning" id="ln-tx-title" />
          <For each={f().opened}>
            {(c) => (
              <Item channel={c} lead="This transaction opened Lightning channel">
                <p>
                  A channel of <Amount sats={c.capacity} /> between:
                </p>
              </Item>
            )}
          </For>
          <For each={f().closed}>
            {(c) => (
              <Item channel={c} lead="This transaction closed Lightning channel">
                <Show when={c.closed}>
                  {(x) => {
                    // A sweep recorded for this close makes it a penalty, as the channel page says.
                    const words = () => closeWords({ closed: x(), penalty: c.penalty });
                    return (
                      <p>
                        <strong>{words().name}</strong>
                        {` (${words().sure.toLowerCase()}). `}
                        {words().why}
                      </p>
                    );
                  }}
                </Show>
              </Item>
            )}
          </For>
        </section>
      )}
    </Show>
  );
}

function Item(props: { channel: ListedChannel; lead: string; children: JSX.Element }) {
  return (
    <div class="ln-close">
      <p class="ln-close__title">
        {props.lead} <ChannelLink id={props.channel.id} />
      </p>
      {props.children}
      <Ends one={props.channel.node_one} two={props.channel.node_two} />
    </div>
  );
}
