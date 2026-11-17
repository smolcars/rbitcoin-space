// The transaction page's live parts: the block strip, who it is mined with, what replaced it, and
// whether the page is live. The state behind them is in state.ts.
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { TimeUtc } from "../../components/Time";
import { groupDigits } from "../../lib/format";
import { type Topic, useLiveStatus, useTopic } from "../../lib/live";
import { paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import {
  type ReplacementLink,
  type TxMessage,
  type TxState,
  txTopic,
} from "../../lib/track-topics";
import { type Liveness, place, type Relatives, group, ratesDiffer, type StripPlace } from "./state";

/** Follows a topic while mounted. `again` gets the function that subscribes afresh. */
export function Follow<M>(props: {
  topic: Topic<M>;
  message: (m: M) => void;
  resync: () => void;
  again?: (restart: () => void) => void;
}) {
  // The topic is chosen once, when it mounts.
  const restart = useTopic(
    untrack(() => props.topic),
    {
      message: (m) => props.message(m),
      resync: () => props.resync(),
    },
  );
  untrack(() => props.again)?.(restart);
  return null;
}

/** How often the page checks over HTTP when it is not live (docs/FRONTEND.md "Live data"). */
export const POLL_MS = 10_000;

const LIVE_LABELS: Record<Liveness, string> = {
  live: "Live",
  connecting: "Connecting",
  silent: "Not live",
  stale: "Node not answering",
  off: "Not live",
  refused: "Not live",
  down: "Not live",
};

/** The live channel's state, as an icon and a word, and what the page does instead when not live. */
export function LiveState(props: { liveness: Liveness; network: string }) {
  const every = `Checking every ${POLL_MS / 1000} s instead.`;
  const detail = () =>
    ({
      live: "",
      connecting: "",
      silent: `The server has not caught up with the mempool yet. ${every}`,
      stale: `The server has lost touch with its node. ${every}`,
      off: `This server does not follow the ${props.network} mempool. ${every}`,
      refused: `The server is following as many transactions as it can. ${every}`,
      down: `The live connection dropped. ${every}`,
    })[props.liveness];
  return (
    <p class={`tx-live tx-live--${props.liveness}`}>
      <svg class="tx-live__icon" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4" />
      </svg>
      <span class="tx-live__label">{LIVE_LABELS[props.liveness]}</span>
      <Show when={detail()}>
        <span class="tx-live__detail">{detail()}</span>
      </Show>
    </p>
  );
}

/**
 * The block strip in small, beside where the transaction is: projected blocks dashed up to the
 * "now" line, mined blocks solid past it, and the transaction one square in its fee colour. Waiting,
 * the square travels only when its block changes; once mined it has crossed the line, and it
 * lands once when that happens while the page is open. Words beside it say the same for a screen
 * reader, so the drawing is hidden from one.
 */
export function Strip(props: { place: StripPlace; color: string; landed: boolean }) {
  const cells = (n: number) => Array.from({ length: n }, (_, i) => i);
  return (
    <span
      class="tx-strip"
      aria-hidden="true"
      style={{
        "--c": props.color,
        "--p": String(props.place.projected),
        "--m": String(props.place.mined),
      }}
    >
      <span class="tx-strip__track">
        <For each={cells(props.place.projected)}>{() => <span class="tx-strip__slot" />}</For>
        <Show when={props.place.here < props.place.projected}>
          <span class="tx-strip__marker" style={{ "--i": String(props.place.here) }} />
        </Show>
      </span>
      <span class="tx-strip__now" />
      {/* Its own block first, drawn farthest right: a later block adds a cell nearer the line,
          and the cell that landed stays the same element, so the landing never plays again. */}
      <span class="tx-strip__mined">
        <For each={cells(props.place.mined)}>
          {(i) => (
            <span
              class={[
                "tx-strip__slot tx-strip__slot--mined",
                {
                  "is-here": props.place.projected + props.place.mined - 1 - i === props.place.here,
                  "is-landed": props.landed && i === 0,
                },
              ]}
            />
          )}
        </For>
      </span>
    </span>
  );
}

const RELATION: Record<string, string> = {
  this: "This transaction",
  parent: "Its parent",
  child: "Its child",
  related: "Related",
};

/**
 * Rows a group's list shows before "Show all": a long list beside the fee would leave the details
 * column beside it empty for a screen or more.
 */
export const GROUP_ROWS = 8;

/** The button that lists the rest. */
function ShowAll(props: { count: number; shown: number; onShow: () => void }) {
  return (
    <Show when={props.count > props.shown}>
      <button class="btn tx-group__more" type="button" onClick={() => props.onShow()}>
        Show all {groupDigits(props.count)}
      </button>
    </Show>
  );
}

/** Who it is mined with, when that is not itself alone: the group and why (CPFP, in words). */
export function Group(props: { relatives: Relatives; txid: string; rate: number | null }) {
  const g = () => group(props.relatives, props.txid);
  const [all, setAll] = createSignal(false);
  // The transaction itself always stays in the list, wherever it falls in the order.
  const together = () =>
    all() ? g().together : g().together.filter((m, i) => i < GROUP_ROWS || m.relation === "this");
  const others = () => g().together.filter((m) => m.relation !== "this");
  const who = () => {
    const o = others();
    const only = o[0];
    if (o.length === 1 && only) {
      return only.relation === "child"
        ? "its child"
        : only.relation === "parent"
          ? "its parent"
          : "one related transaction";
    }
    return `${groupDigits(o.length)} related transactions`;
  };
  const sentence = (): JSX.Element => {
    const eff = g().rate;
    const own = props.rate;
    if (eff === undefined || own === null || !ratesDiffer(eff, own)) {
      return <>A miner takes it together with {who()}, at one rate for the group.</>;
    }
    // Each sentence ends in words, so a rate's swatch never strands the full stop on a line.
    const pays = others().length === 1 ? "pays" : "pay";
    return eff > own ? (
      <>
        On its own it pays <FeeRate rate={own} />, but {who()} {pays} enough to lift the group to{" "}
        <FeeRate rate={eff} /> as a whole.
      </>
    ) : (
      <>
        On its own it pays <FeeRate rate={own} />, but it can only be mined with the unconfirmed
        transactions whose coins it spends, which pay less: the group is mined at{" "}
        <FeeRate rate={eff} /> as a whole.
      </>
    );
  };
  return (
    <Show when={others().length > 0 || g().before.length > 0 || g().after.length > 0}>
      <section class="tx-group" aria-labelledby="tx-group-title">
        <h3 class="tx-group__title" id="tx-group-title">
          Mined with
        </h3>
        <Show when={others().length > 0}>
          <p class="tx-group__text">{sentence()}</p>
          <More label="Why">
            <p>
              A transaction can only be mined with or after the ones whose coins it spends, so
              miners weigh such a group by its total fee over its total size. When a child raises
              the rate this way it is called child pays for parent.
            </p>
          </More>
          <ul class="tx-group__list" aria-label="Mined together, in mining order">
            <For each={together()}>
              {(m) => (
                <li class="tx-group__member">
                  <span class="tx-group__who">{RELATION[m.relation]}</span>
                  <Hash
                    value={m.txid}
                    {...(m.relation === "this" ? {} : { href: paths.tx(m.txid) })}
                    copy={false}
                  />
                  <span class="tx-group__rate">
                    <Show when={m.rate !== undefined} fallback="–">
                      <FeeRate rate={m.rate ?? 0} />
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
          <ShowAll
            count={g().together.length}
            shown={together().length}
            onShow={() => setAll(true)}
          />
        </Show>
        <Show when={g().before.length > 0}>
          <p class="tx-group__text">
            It spends coins from unconfirmed transactions that will be mined before it:
          </p>
          <TxList txids={g().before} label="Unconfirmed parents mined before it" />
        </Show>
        <Show when={g().after.length > 0}>
          <p class="tx-group__text">Unconfirmed transactions that spend its coins wait for it:</p>
          <TxList txids={g().after} label="Unconfirmed children that wait for it" />
        </Show>
      </section>
    </Show>
  );
}

function TxList(props: { txids: string[]; label: string }) {
  const [all, setAll] = createSignal(false);
  const txids = () => (all() ? props.txids : props.txids.slice(0, GROUP_ROWS));
  return (
    <>
      <ul class="tx-group__list" aria-label={props.label}>
        <For each={txids()}>
          {(id) => (
            <li class="tx-group__member">
              <Hash value={id} href={paths.tx(id)} copy={false} />
            </li>
          )}
        </For>
      </ul>
      <ShowAll count={props.txids.length} shown={txids().length} onShow={() => setAll(true)} />
    </>
  );
}

/**
 * What replaced it, link by link to the newest replacement, whose own state is followed live (one
 * topic, however long the chain).
 */
export function Chain(props: { chain: ReplacementLink[]; truncated: boolean }) {
  const last = () => props.chain.at(-1);
  return (
    <div class="tx-chain">
      <Show when={props.chain.length > 1}>
        <p class="tx-chain__lead">
          It was replaced {groupDigits(props.chain.length)} times
          {props.truncated ? " or more" : ""}. Each version spends the same coins, so only the last
          can still confirm.
        </p>
      </Show>
      <ol class="tx-chain__list" aria-label="Replacements, oldest first">
        <For each={props.chain}>
          {(l, i) => (
            <li class="tx-chain__link">
              <span class="tx-chain__step num" aria-hidden="true">
                {i() + 1}
              </span>
              <span class="tx-chain__body">
                <span class="tx-chain__line">
                  {i() === 0 ? (
                    "This version"
                  ) : (
                    <Hash value={l.txid} href={paths.tx(l.txid)} copy={false} />
                  )}
                  <Show when={l.rate !== undefined}>
                    <span class="tx-chain__rate">
                      {" "}
                      at <FeeRate rate={l.rate ?? 0} />
                    </span>
                  </Show>
                </span>
                <span class="tx-chain__line">
                  replaced by <Hash value={l.by} href={paths.tx(l.by)} copy={false} />
                  <Show when={l.byRate !== undefined}>
                    <span class="tx-chain__rate">
                      {" "}
                      at <FeeRate rate={l.byRate ?? 0} />
                    </span>
                  </Show>
                </span>
                <Show when={l.seen}>
                  {(t) => (
                    <span class="tx-chain__when">
                      <TimeUtc time={t()} />
                    </span>
                  )}
                </Show>
              </span>
            </li>
          )}
        </For>
      </ol>
      <Show when={last()?.by} keyed>
        {(id) => <Newest txid={id} />}
      </Show>
    </div>
  );
}

/** The newest replacement's own state, from its topic: where it is, or that it confirmed. */
function Newest(props: { txid: string }) {
  const network = useNetwork();
  const socket = useLiveStatus();
  const [heardState, setSaid] = createSignal<TxState>();
  // Only what the topic says now: nothing once the live channel has dropped.
  const said = () => (socket() === "live" ? heardState() : undefined);
  const message = (m: TxMessage) => setSaid(m.type === "tx" && !m.stale ? m : undefined);
  return (
    <p class="tx-chain__newest">
      <span>
        Follow <Hash value={props.txid} href={paths.tx(props.txid)} copy={false} />, the newest
        version.
      </span>{" "}
      <Switch>
        <Match when={said()?.state === "confirmed" && (said() as TxState & { state: "confirmed" })}>
          {(c) => (
            <span>
              It confirmed in{" "}
              <Link href={paths.block(c().hash)}>block {groupDigits(c().height)}</Link>.
            </span>
          )}
        </Match>
        <Match when={said()?.state === "mempool" && (said() as TxState & { state: "mempool" })}>
          {(m) => (
            <span>
              It waits in the mempool
              <Show when={m().position}>
                {(p) => (
                  <>
                    :{" "}
                    <Link href={paths.projected(place(p(), network()).page)}>
                      {place(p(), network()).where.toLowerCase()}
                    </Link>
                    , projected
                  </>
                )}
              </Show>
              .
            </span>
          )}
        </Match>
        <Match when={said()?.state === "evicted"}>
          <span>It left the mempool without being mined.</span>
        </Match>
      </Switch>
      <Follow topic={txTopic(props.txid)} message={message} resync={() => setSaid(undefined)} />
    </p>
  );
}
