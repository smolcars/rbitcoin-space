// "As it happens": channels opened and closed and fees moved, as the server finds them
// (docs/WS.md "lightning-feed"). Batches land at once on top, at most every 30 s; the list holds
// `KEEP` rows of each kind and shows `KEEP`. Paused by its button, and while the pointer or focus
// is in the list; under reduced motion it starts paused. The counts stay live while it is paused.
import { createEffect, createSignal, For, Match, onSettled, Show, Switch, untrack } from "solid-js";
import { sorted } from "../../components/chart/geometry";
import { Amount } from "../../components/Amount";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../components/States";
import { TimeAgo } from "../../components/Time";
import { groupDigits } from "../../lib/format";
import { useLiveStatus, useTopic } from "../../lib/live";
import type { Network } from "../../lib/network";
import {
  type FeedEvent,
  type FeedFilter,
  feedTopic,
  isFeed,
  KEEP,
  place,
  readFeed,
  type Row,
  Seen,
  shown,
} from "./feed";
import { changeShown, type Fees, inboundOf, KIND_TAG } from "./lightning";
import { ask, ChannelLink, InboundFig, MsatFig, NodeName, PpmFig, Tag } from "./parts";

/** Waits this long for the topic's snapshot before asking over HTTP (an empty feed sends none). */
export const TOPIC_WAIT_MS = 3000;
/** How often to ask while the live channel is down. */
export const POLL_MS = 30_000;

const FILTERS: readonly { id: FeedFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "opened", label: "Opens" },
  { id: "closed", label: "Closes" },
  { id: "fee", label: "Fee changes" },
];

const CLOSE_WORD = {
  cooperative: "Cooperative close",
  force: "Force close",
  penalty: "Penalty",
  other: "Other close",
} as const;

/** The newest `KEEP` of each kind, newest first. */
const newestOfEach = (events: FeedEvent[]): FeedEvent[] => {
  const n = { opened: 0, closed: 0, fee: 0 };
  return sorted(events, (a, b) => b.time - a.time).filter((e) => ++n[e.event] <= KEEP);
};

export function LiveFeed(props: { network: Network }) {
  const seen = new Seen();
  // Kept in plain variables the signals mirror: a write is seen only after the flush.
  let list: Row[] = [];
  let batch = 0;
  let pending: FeedEvent[] = [];
  let pendingMore = 0;
  let isLoaded = false;
  const [rows, setRows] = createSignal<Row[]>([]);
  const [newest, setNewest] = createSignal(-1);
  const [loaded, setLoaded] = createSignal(false);
  const [failed, setFailed] = createSignal<unknown>();
  const [waiting, setWaiting] = createSignal(0);
  const [counts, setCounts] = createSignal({ opened: 0, closed: 0, fee: 0, more: 0 });
  const [filter, setFilter] = createSignal<FeedFilter>("all");
  // Rows arriving by themselves are motion: under reduced motion the list waits to be asked.
  const [held, setHeld] = createSignal(
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [hover, setHover] = createSignal(false);
  const [focus, setFocus] = createSignal(false);
  const paused = () => held() || hover() || focus();
  let isPaused = paused();
  const status = useLiveStatus();
  const since = new Date();
  const sinceText = `${String(since.getUTCHours()).padStart(2, "0")}:${String(since.getUTCMinutes()).padStart(2, "0")} UTC`;

  const show = (events: FeedEvent[], more: number) => {
    batch += 1;
    list = place(list, events, more, batch);
    setRows(list);
    setNewest(batch);
  };
  /** What a message or answer adds; the first one is the list as it stands, never news. */
  const take = (events: FeedEvent[], more: number) => {
    const fresh = seen.fresh(events);
    if (isLoaded) {
      const c = { opened: 0, closed: 0, fee: 0 };
      for (const e of fresh) c[e.event] += 1;
      setCounts((n) => ({
        opened: n.opened + c.opened,
        closed: n.closed + c.closed,
        fee: n.fee + c.fee,
        more: n.more + more,
      }));
    }
    if (!isLoaded) {
      isLoaded = true;
      list = place([], fresh, 0, 0);
      setRows(list);
      setLoaded(true);
      return;
    }
    if (fresh.length === 0 && more === 0) return;
    if (isPaused) {
      // Held to what the list could show, however long the pause: the rest is "more".
      const all = [...fresh, ...pending];
      pending = newestOfEach(all);
      pendingMore += more + all.length - pending.length;
      setWaiting((w) => w + fresh.length + more);
      return;
    }
    show(fresh, more);
  };

  createEffect(paused, (p) => {
    isPaused = p;
    if (p || (pending.length === 0 && pendingMore === 0)) return;
    show(pending, pendingMore);
    pending = [];
    pendingMore = 0;
    setWaiting(0);
  });

  useTopic(feedTopic, {
    message: (m) => {
      setFailed(undefined);
      take(m.events, m.type === "events" ? m.more : 0);
    },
    // A reconnect's snapshot follows the new subscription: it holds what was missed.
    resync: () => undefined,
  });

  let controller: AbortController | undefined;
  const load = async () => {
    controller?.abort();
    const c = new AbortController();
    controller = c;
    try {
      const v = await ask(props.network, "/feed", isFeed, c.signal);
      setFailed(undefined);
      take(readFeed(v), 0);
    } catch (error) {
      if (!c.signal.aborted) setFailed(error);
    }
  };
  onSettled(() => {
    const first = setTimeout(() => {
      if (!isLoaded) void load();
    }, TOPIC_WAIT_MS);
    const poll = setInterval(() => {
      if (status() !== "live") void load();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      controller?.abort();
    };
  });

  const view = () => shown(rows(), filter());
  return (
    <section aria-labelledby="ln-feed-title" aria-busy={loaded() ? "false" : "true"}>
      <SectionHeader title="As it happens" id="ln-feed-title">
        <span class="ln-live">
          <span
            class={["ln-live__dot", { "ln-live__dot--off": paused() || status() !== "live" }]}
            aria-hidden="true"
          />
          {status() === "connecting"
            ? "Connecting"
            : status() === "live"
              ? paused()
                ? waiting() > 0
                  ? `Paused, ${groupDigits(waiting())} waiting`
                  : "Paused"
                : "Live"
              : status() === "reconnecting"
                ? "Reconnecting"
                : "Offline"}
        </span>
        <button
          class="btn ln-feed__pause"
          type="button"
          aria-pressed={held() ? "true" : "false"}
          onClick={() => setHeld((h) => !h)}
        >
          {held() ? "Resume" : "Pause"}
        </button>
      </SectionHeader>
      <div class="ln-feed__bar">
        <div class="ln-picker" role="group" aria-label="Show">
          <ul>
            <For each={FILTERS}>
              {(f) => (
                <li>
                  <button
                    type="button"
                    class="ln-picker__item"
                    aria-pressed={filter() === f.id ? "true" : "false"}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
        <p class="ln-feed__counts">
          Since {sinceText}: <span class="num">{groupDigits(counts().opened)}</span> opened,{" "}
          <span class="num">{groupDigits(counts().closed)}</span> closed,{" "}
          <span class="num">{groupDigits(counts().fee)}</span> fees moved
          <Show when={counts().more > 0}>
            , <span class="num">{groupDigits(counts().more)}</span> more not listed
          </Show>
        </p>
      </div>
      {/* One height whatever it holds, so its arrival moves nothing below it. */}
      <div class="ln-feed__box">
        <Switch>
          <Match when={!loaded() && failed() !== undefined}>
            <ErrorState
              title="Could not load the live feed"
              error={failed()}
              retry={() => void load()}
            />
          </Match>
          <Match when={!loaded()}>
            <Loading label="Waiting for the live feed" />
          </Match>
          <Match when={view().length === 0}>
            <Empty title={rows().length === 0 ? "Nothing yet" : "None of these yet"}>
              Changes appear here as this server finds them, after it has caught up with the chain.
            </Empty>
          </Match>
        </Switch>
        <Show when={loaded() && view().length > 0}>
          <ol
            class="ln-feed"
            aria-label="Newest first"
            onPointerEnter={(e) => setHover(e.pointerType === "mouse")}
            onPointerLeave={() => setHover(false)}
            onFocusIn={() => setFocus(true)}
            onFocusOut={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
            }}
          >
            <For each={view()}>
              {(row) => (
                <li class={["ln-feed__row", { "ln-feed__row--new": row.batch === newest() }]}>
                  <Show
                    when={row.ev}
                    fallback={
                      <span class="ln-feed__more">
                        and <span class="num">{groupDigits(row.more ?? 0)}</span> more in this
                        batch, not listed
                      </span>
                    }
                  >
                    {(ev) => <FeedRow ev={ev()} />}
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
    </section>
  );
}

/** One event: what happened, to which channel, how much it moved or holds, between whom, when. */
function FeedRow(props: { ev: FeedEvent }) {
  // A row is one event for its life (the list is keyed by it), so it is read once.
  const ev = untrack(() => props.ev);
  return (
    <>
      {/* What happened and when: on a narrow row the time drops below when the two do not fit. */}
      <span class="ln-feed__head">
        <span class="ln-feed__kind">
          <Switch>
            <Match when={ev.event === "opened"}>
              <Tag icon="plus" tone="positive">
                Opened
              </Tag>
            </Match>
            <Match when={ev.event === "closed" && ev}>
              {(c) => (
                <Tag icon={KIND_TAG[c().kind].icon} tone={KIND_TAG[c().kind].tone}>
                  {CLOSE_WORD[c().kind]}
                </Tag>
              )}
            </Match>
            <Match when={ev.event === "fee"}>
              <Tag icon="fee" tone="muted">
                Fee change
              </Tag>
            </Match>
          </Switch>
        </span>
        <span class="ln-feed__time">
          <TimeAgo time={ev.time} />
        </span>
      </span>
      <span class="ln-feed__what">
        <ChannelLink id={ev.id} />
      </span>
      <span class="ln-feed__fig">
        <Show when={ev.event === "fee" && ev} fallback={<Amount sats={ev.capacity} short />}>
          {(f) => <Moved before={f().before} after={f().after} />}
        </Show>
      </span>
      <span class="ln-feed__ends">
        <Show
          when={ev.event === "fee" && ev}
          fallback={
            <>
              <NodeName node={ev.node_one} />
              <span class="ln-feed__join" aria-hidden="true">
                ↔
              </span>
              <span class="visually-hidden">and</span>
              <NodeName node={ev.node_two} />
            </>
          }
        >
          {(f) => (
            <>
              <NodeName node={f().by === "node_one" ? ev.node_one : ev.node_two} />
              <span class="ln-feed__join" aria-hidden="true">
                →
              </span>
              <span class="visually-hidden">charges towards</span>
              <NodeName node={f().by === "node_one" ? ev.node_two : ev.node_one} />
            </>
          )}
        </Show>
      </span>
    </>
  );
}

/** A fee change's from and to: the rate if it moved, else the base fee, else the inbound fee. */
function Moved(props: { before: Fees; after: Fees }) {
  const which = () => changeShown(props);
  const side = (f: Fees) => (
    <Switch>
      <Match when={which() === "rate"}>
        <PpmFig rate={f.fee_rate} />
      </Match>
      <Match when={which() === "base"}>
        <MsatFig msat={f.base_fee_msat} />
      </Match>
      <Match when={inboundOf(f)}>{(i) => <InboundFig fee={i()} />}</Match>
      <Match when={true}>none</Match>
    </Switch>
  );
  return (
    <span class="ln-feed__moved">
      <Show when={which() === "inbound"}>
        <span class="ln-feed__what-moved">Inbound</span>
      </Show>
      <span>{side(props.before)}</span>
      <span aria-hidden="true">→</span>
      <span class="visually-hidden">to</span>
      <span>{side(props.after)}</span>
    </span>
  );
}
