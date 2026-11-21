import { Match, Show, Switch } from "solid-js";
import type { ApiResource } from "../../lib/api";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { CopyButton } from "../../components/CopyButton";
import { ErrorState } from "../../components/States";
import type { AddressStats } from "../../lib/esplora";
import { groupDigits, plainBtc } from "../../lib/format";
import { refusal } from "./address";
import { Notice, Skeleton, settled, UnconfirmedMark } from "./parts";

const plural = (n: number, one: string, many: string) =>
  `${groupDigits(n)}${n === 1 ? ` ${one}` : ` ${many}`}`;

/** One figure: label, value and a sub-line. Both lines hold a bar until `ready`, so nothing moves. */
export function Stat(props: {
  label: string;
  ready: boolean;
  value: JSX.Element;
  sub: JSX.Element;
  /** A further muted line under the sub-line, when given. */
  more?: JSX.Element;
  class?: string;
}) {
  return (
    <div class={`address-stat ${props.class ?? ""}`}>
      <dt class="address-stat__label">{props.label}</dt>
      <dd class="address-stat__value">
        <Show when={props.ready} fallback={<Skeleton width="9ch" />}>
          {props.value}
        </Show>
      </dd>
      <dd class="address-stat__sub">
        <Show when={props.ready} fallback={<Skeleton width="6ch" />}>
          {props.sub}
        </Show>
      </dd>
      <Show when={props.more}>{(more) => <dd class="address-stat__more">{more()}</dd>}</Show>
    </div>
  );
}

/** A total, exact to the satoshi, with a copy button that copies it as a program reads it. */
function Total(props: { sats: number; what: string }) {
  return (
    <span class="address-total">
      <Amount sats={props.sats} wrap />
      <CopyButton value={plainBtc(props.sats)} label={`Copy the exact ${props.what}, in BTC`} />
    </span>
  );
}

const EMPTY = {
  funded_txo_count: 0,
  funded_txo_sum: 0,
  spent_txo_count: 0,
  spent_txo_sum: 0,
  tx_count: 0,
};

/**
 * Balance, received, sent, transaction count and the unconfirmed change. As of a block (`at`, its
 * height; `stats` then asked with `?asof=`), the confirmed figures only: nothing waits at a past block,
 * and `since` says under the balance how it stands now.
 */
export function Totals(props: {
  stats: ApiResource<AddressStats>;
  retry: () => void;
  at?: number;
  since?: JSX.Element;
}) {
  const s = () => settled(props.stats);
  const chain = () => s()?.chain_stats ?? EMPTY;
  const pool = () => s()?.mempool_stats ?? EMPTY;
  const ready = () => s() !== undefined;
  const failure = () => (props.stats.state === "errored" ? refusal(props.stats.error) : undefined);

  return (
    <section
      class="address-totals panel"
      aria-label="Totals"
      aria-busy={ready() ? "false" : "true"}
    >
      <Switch>
        <Match when={failure() === "too-large"}>
          <Notice title="Totals are not available for this address">
            It has more history than this server's node will add up, which is common for exchange
            and mining pool addresses.
          </Notice>
        </Match>
        <Match when={failure()}>
          <ErrorState
            title="Could not load this address"
            error={props.stats.error}
            retry={props.retry}
          />
        </Match>
        <Match when={true}>
          <dl class={["address-stats", { "address-stats--asof": props.at !== undefined }]}>
            <Stat
              class="address-stat--balance"
              label="Balance"
              ready={ready()}
              value={<Total sats={chain().funded_txo_sum - chain().spent_txo_sum} what="balance" />}
              sub={props.at === undefined ? "Confirmed" : `At block ${groupDigits(props.at)}`}
              more={props.since}
            />
            <Stat
              label="Received"
              ready={ready()}
              value={<Total sats={chain().funded_txo_sum} what="amount received" />}
              sub={plural(chain().funded_txo_count, "output", "outputs")}
            />
            <Stat
              label="Sent"
              ready={ready()}
              value={<Total sats={chain().spent_txo_sum} what="amount sent" />}
              sub={plural(chain().spent_txo_count, "output", "outputs")}
            />
            <Stat
              label="Transactions"
              ready={ready()}
              value={
                <span class="num">
                  {groupDigits(chain().tx_count + (props.at === undefined ? pool().tx_count : 0))}
                </span>
              }
              sub={
                props.at === undefined
                  ? `${groupDigits(chain().tx_count)} confirmed`
                  : "Confirmed by then"
              }
            />
            <Show when={props.at === undefined}>
              <Stat
                label="Unconfirmed"
                ready={ready()}
                value={
                  <Show when={pool().tx_count} fallback={<span class="muted">None</span>}>
                    <Amount sats={pool().funded_txo_sum - pool().spent_txo_sum} signed />
                  </Show>
                }
                sub={
                  <Show when={pool().tx_count} fallback="Nothing waiting">
                    {(n) => <UnconfirmedMark label={plural(n(), "transaction", "transactions")} />}
                  </Show>
                }
              />
            </Show>
          </dl>
        </Match>
      </Switch>
    </section>
  );
}
