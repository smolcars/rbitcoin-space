// A node's channels as its operator works through them: open and closed, each sorted, filtered and
// paged by the server, the view in the address so it can be linked and the back button steps
// through it. A table on a wide screen, cards on a phone (docs/DESIGN.md "Lightning"). While the
// reader works the list holds still: the old rows stay until the new ones arrive.
import { useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Amount } from "../../components/Amount";
import type { JSX } from "@solidjs/web";
import { formatDay } from "../../components/chart/scale";
import { type Column, DataTable } from "../../components/DataTable";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { Pagination } from "../../components/Pagination";
import { scrollCue } from "../../components/scrollCue";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../components/States";
import { createRequest } from "../../lib/api";
import { groupDigits, MISSING, truncateMiddle } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import {
  ageShort,
  baseShort,
  CLOSE_KINDS,
  type ChannelPage,
  type ClosedChannel,
  cleanFilter,
  count,
  type FeeFilter,
  firstDir,
  inboundOf,
  inboundWord,
  isClosedPage,
  isOpenPage,
  KIND_SHORT,
  KIND_TAG,
  listRequest,
  type ListView,
  type NodeDetail,
  OP_STATES,
  OP_WORDS,
  type OpenChannel,
  type Peer,
  type Policy,
  readList,
  rowName,
  rowState,
  shownDir,
  sortName,
  viewHref,
} from "./lightning";
import {
  Alias,
  ask,
  BlockLink,
  ChannelId,
  ChannelLink,
  InboundFig,
  inboundName,
  MsatFig,
  PpmFig,
  SatsFig,
  Tag,
  usePhone,
} from "./parts";
import { dragScroll } from "../../components/dragScroll";
import { owned } from "../../components/owned";

/** How long typing must pause before the filter asks, as the header's search waits. */
export const FILTER_WAIT_MS = 280;

const days = (seconds: number) => groupDigits(Math.max(0, Math.floor(seconds / 86_400)));

interface ListProps {
  node: NodeDetail;
  network: Network;
  /** The moment ages are counted to: the node's answer, so the list never ticks by itself. */
  now: number;
}

/**
 * A list's view from the address and the page the server sent for it. The page shown is the last
 * answer, kept until the next arrives (`busy` meanwhile); a newer ask aborts the one before it, so
 * a slower earlier answer never replaces a newer one.
 */
function useList<T>(
  props: { node: { id: string }; network: Network },
  closed: boolean,
  check: (v: unknown) => v is ChannelPage<T>,
  first: () => ChannelPage<T> | undefined,
) {
  const [search, setSearch] = useSearchParams();
  const view = createMemo(() => readList(search, closed));
  const path = createMemo(() => listRequest(props.node.id, view(), closed));
  const firstPath = untrack(() => listRequest(props.node.id, readList({}, closed), closed));
  const fromNode = () => (first() !== undefined && path() === firstPath ? first() : undefined);
  const [list, { refetch }] = createRequest(
    () => (fromNode() === undefined ? path() : false),
    async (p, signal) => ({ path: p, page: await ask(props.network, p, check, signal) }),
  );
  const [held, setHeld] = createSignal<{ path: string; page: ChannelPage<T> } | undefined>(
    untrack(() => {
      const f = fromNode();
      return f === undefined ? undefined : { path: firstPath, page: f };
    }),
  );
  createEffect(
    () => {
      const f = fromNode();
      return f === undefined ? list.latest : { path: firstPath, page: f };
    },
    (answer) => {
      if (answer !== undefined) setHeld(answer);
    },
  );
  const failed = () => fromNode() === undefined && list.state === "errored";
  const busy = () => held()?.path !== path();
  /** Applies a change to the address: a new entry, so the back button steps through views. */
  const go = (change: Record<string, string | undefined>, replace = false) =>
    setSearch(change, { replace, scroll: false });
  const base = () => paths.lightningNode(props.node.id);
  const href = (change: Record<string, string | undefined>) =>
    viewHref(base(), { ...search }, { page: undefined, ...change });
  const sortBy = (by: string, dir?: "asc" | "desc") => {
    const own = closed ? "desc" : firstDir(by);
    go({
      sort: by === (closed ? "closed" : "capacity") && (dir ?? own) === own ? undefined : by,
      dir: dir === undefined || dir === own ? undefined : dir,
      page: undefined,
    });
  };
  const sorting = () => ({
    by: view().sort,
    dir: shownDir(view().sort, view().dir),
    onSort: (by: string) =>
      by === view().sort ? sortBy(by, view().dir === "asc" ? "desc" : "asc") : sortBy(by),
  });
  // A new page starts at the top of the list, not where "Next" was.
  let top: HTMLElement | undefined;
  createEffect(
    () => view().page,
    (_, previous) => {
      if (previous !== undefined && top && top.getBoundingClientRect().top < 0)
        top.scrollIntoView({ block: "start" });
    },
  );
  return {
    view,
    held,
    busy,
    failed,
    error: () => list.error,
    retry: refetch,
    go,
    href,
    sorting,
    sortBy,
    mark: (el: HTMLElement) => {
      top = el;
    },
  };
}

/** The text filter: asks once typing pauses; the address keeps what was asked. */
function FilterField(props: { value: string; onChange: (q: string | undefined) => void }) {
  const [text, setText] = createSignal(untrack(() => props.value));
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The address changed by other means (Clear, the back button): the field follows it, and
  // typing still waiting to be asked is dropped, so it cannot undo that change.
  createEffect(
    () => props.value,
    (v) => {
      if (cleanFilter(untrack(text)) === v) return;
      clearTimeout(timer);
      setText(v);
    },
  );
  onCleanup(() => clearTimeout(timer));
  return (
    <label class="ln-node-filter">
      <span class="visually-hidden">Filter by a peer's name or key, or a channel id</span>
      <input
        type="search"
        class="ln-node-input"
        placeholder="Peer or channel id"
        maxlength="66"
        value={text()}
        spellcheck="false"
        autocomplete="off"
        onInput={(e) => {
          const v = e.currentTarget.value;
          setText(v);
          clearTimeout(timer);
          timer = setTimeout(() => {
            const q = cleanFilter(v);
            props.onChange(q === "" ? undefined : q);
          }, FILTER_WAIT_MS);
        }}
      />
    </label>
  );
}

/** A filter in force, said in words, with a way to drop it. */
function Active(props: { children: JSX.Element; clear: string }) {
  return (
    <span class="ln-node-active">
      {props.children}
      <Link class="ln-node-active__clear tap" href={props.clear} noscroll>
        Clear
      </Link>
    </span>
  );
}

/** The fee filter in words: `It charges 10–49 ppm`. */
function feeWords(f: FeeFilter): string {
  if (f.from === null) return f.way === "out" ? "It has set no fee" : "Its peer has set no fee";
  return `${f.way === "out" ? "It charges" : "Its peer charges"} ${rowName(f.from)} ppm`;
}

/** The peer a list is narrowed to: who it is and its size, its page, and the way back. */
function PeerBar(props: {
  peer: string;
  known: Peer | undefined;
  together: number | undefined;
  clear: string;
}) {
  return (
    <p class="ln-node-peerbar">
      <span>
        <Show when={props.together}>
          {(n) => (
            <strong>
              <span class="num">{count(n(), "channel")}</span> with{" "}
            </strong>
          )}
        </Show>
        <Show when={props.known} fallback={<span>One peer</span>}>
          {(p) => (
            <strong>
              <Alias alias={p().alias} />
            </strong>
          )}
        </Show>{" "}
        <span class="ln-key" title={props.peer}>
          {truncateMiddle(props.peer, 8, 6)}
        </span>
        <Show when={props.known?.channels}>
          {(n) => (
            <span class="muted">
              {" "}
              (<span class="num">{count(n(), "channel")}</span>,{" "}
              <Amount sats={props.known?.capacity ?? 0} wrap />)
            </span>
          )}
        </Show>
      </span>
      <Link class="tap" href={paths.lightningNode(props.peer)}>
        Its page
      </Link>
      <Link class="tap" href={props.clear} noscroll>
        All peers
      </Link>
    </p>
  );
}

/** A policy's rate in a column, its base fee in a slot of its own after it, and its inbound fee
 *  on a small line under them when it has one. */
function Fee(props: { p: Policy | null }) {
  return (
    <Show when={props.p} fallback={<span title="No policy">{MISSING}</span>}>
      {(p) => (
        <span class="ln-node-fee">
          <span>{groupDigits(p().fee_rate)}</span>
          <span class="ln-node-fee__base">+{baseShort(p().base_fee_msat)}</span>
          <Show when={inboundOf(p())}>
            {(f) => (
              <span class="ln-node-fee__in" title={inboundName(f())}>
                <span class="visually-hidden">Inbound </span>
                {inboundWord(f()) === "fee" ? "inbound" : inboundWord(f())} <InboundFig fee={f()} />
              </span>
            )}
          </Show>
        </span>
      )}
    </Show>
  );
}

function StateTag(props: { c: OpenChannel; short?: boolean }) {
  const s = () => rowState(props.c);
  return (
    <Tag icon={s().icon} tone={s().tone} class="ln-node-state">
      {props.short ? s().short : s().word}
    </Tag>
  );
}

/** The sort a phone picks from a list: each figure, each way, its own way first. */
function SortPicker(props: {
  sorts: readonly string[];
  closed: boolean;
  view: ListView;
  onPick: (by: string, dir: "asc" | "desc") => void;
}) {
  const ways = (id: string) => {
    const first = props.closed ? "desc" : firstDir(id);
    return [first, first === "desc" ? "asc" : "desc"] as const;
  };
  return (
    <label class="ln-node-sortpick">
      <span>Sort</span>
      <select
        class="ln-node-input"
        value={`${props.view.sort}:${props.view.dir}`}
        onChange={(e) => {
          const [by = "", dir] = e.currentTarget.value.split(":");
          props.onPick(by, dir === "asc" ? "asc" : "desc");
        }}
      >
        <For each={props.sorts}>
          {(id) => (
            <For each={ways(id)}>
              {(dir) => <option value={`${id}:${dir}`}>{sortName(id, dir)}</option>}
            </For>
          )}
        </For>
      </select>
    </label>
  );
}

const OPEN_SORTS = ["capacity", "age", "out", "in", "cltv", "htlc", "update", "peer"] as const;

/** A table's caption: what it lists and how it is sorted, in the picker's words. */
const sortedBy = (what: string, v: ListView) => {
  const name = sortName(v.sort, v.dir);
  return `${what}, sorted by ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
};

/** A card's figure for a sort it does not already show: its name, then the figure whole. */
function sortedFigure(by: string, c: OpenChannel): JSX.Element | null {
  const named = (name: string, figure: JSX.Element) => (
    <strong>
      <span class="ln-node-card__k">{name}</span> {figure}
    </strong>
  );
  const own = c.own_policy;
  if (by === "cltv")
    return named(
      "CLTV delta",
      <span class="num">{own ? groupDigits(own.cltv_delta) : MISSING}</span>,
    );
  if (by === "htlc") return named("Max HTLC", own ? <MsatFig msat={own.max_htlc_msat} /> : MISSING);
  if (by === "peer")
    return named(
      "Peer",
      c.peer.capacity === null ? MISSING : <Amount sats={c.peer.capacity} wrap />,
    );
  return null;
}

export function OpenList(props: ListProps) {
  const phone = usePhone();
  const l = useList(props, false, isOpenPage, () => props.node.open_channels);
  const page = () => l.held()?.page;
  const shown = () => page()?.channels ?? [];
  const peerHref = (c: OpenChannel) => l.href({ peer: c.peer.id });
  const columns = (): Column<OpenChannel>[] => [
    {
      header: "Peer",
      sub: "by its total capacity",
      sort: "peer",
      cell: (c) => (
        <span class="ln-node-row2">
          <span class="ln-node-row2__line">
            <Link
              class="ln-node-peer"
              href={peerHref(c)}
              noscroll
              title="Show only this peer's channels"
            >
              <Alias alias={c.peer.alias} max={24} />
            </Link>
            <span class="ln-key" title={c.peer.id}>
              {truncateMiddle(c.peer.id, 6, 4)}
            </span>
            <Show when={c.with_peer > 1}>
              <span class="ln-node-together">×{c.with_peer}</span>
            </Show>
          </span>
          <ChannelLink id={c.id} />
        </span>
      ),
    },
    {
      header: "Capacity",
      sub: "sats",
      numeric: true,
      sort: "capacity",
      cell: (c) => groupDigits(c.capacity),
    },
    {
      header: "Age",
      sub: "days",
      numeric: true,
      sort: "age",
      cell: (c) => (c.funded === null ? MISSING : days(props.now - c.funded)),
    },
    {
      header: "Fee out",
      sub: "this node, ppm +sats",
      numeric: true,
      sort: "out",
      cell: (c) => <Fee p={c.own_policy} />,
    },
    {
      header: "Fee in",
      sub: "the peer, ppm +sats",
      numeric: true,
      sort: "in",
      cell: (c) => <Fee p={c.peer_policy} />,
    },
    {
      header: "CLTV Δ",
      sub: "this node",
      numeric: true,
      sort: "cltv",
      cell: (c) => (c.own_policy ? groupDigits(c.own_policy.cltv_delta) : MISSING),
    },
    {
      header: "Max HTLC",
      sub: "this node, sats",
      numeric: true,
      sort: "htlc",
      cell: (c) =>
        c.own_policy ? groupDigits(Math.floor(c.own_policy.max_htlc_msat / 1000)) : MISSING,
    },
    { header: "State", sub: "policies", cell: (c) => <StateTag c={c} /> },
    {
      header: "Updated",
      sub: "newer policy, ago",
      numeric: true,
      sort: "update",
      cell: (c) => (c.last_update === null ? MISSING : ageShort(props.now - c.last_update)),
    },
  ];
  const states = () => page()?.states;
  const filtered = () => {
    const v = l.view();
    return v.q !== "" || v.peer !== null || v.state !== null || v.fee !== null;
  };
  return (
    <section aria-labelledby="ln-node-open-title" class="ln-node-list">
      <h2 id="ln-node-open-title" class="visually-hidden">
        Open channels
      </h2>
      <p class="ln-aside ln-node-lead">Advertised policies; balances unknown.</p>
      <div class="ln-node-filters">
        <FilterField value={l.view().q} onChange={(q) => l.go({ q, page: undefined }, true)} />
        <div
          class="ln-node-chips"
          role="group"
          aria-label="Channel state"
          ref={owned((el) => {
            scrollCue(el);
            dragScroll(el);
          })}
        >
          <Link
            class="btn ln-node-chip"
            href={l.href({ state: undefined })}
            aria-current={l.view().state === null ? "true" : "false"}
            noscroll
          >
            All
            <Show when={states()}>
              {(s) => (
                <span class="num muted">
                  {groupDigits(OP_STATES.reduce((n, k) => n + s()[k], 0))}
                </span>
              )}
            </Show>
          </Link>
          <For each={OP_STATES}>
            {(k) => (
              <Show when={(states()?.[k] ?? 0) > 0 || l.view().state === k}>
                <Link
                  class="btn ln-node-chip"
                  href={l.href({ state: l.view().state === k ? undefined : k })}
                  aria-current={l.view().state === k ? "true" : "false"}
                  noscroll
                >
                  <Tag icon={OP_WORDS[k].icon} tone={OP_WORDS[k].tone}>
                    {OP_WORDS[k].word}
                  </Tag>
                  <span class="num muted">{groupDigits(states()?.[k] ?? 0)}</span>
                </Link>
              </Show>
            )}
          </For>
        </div>
        <SortPicker sorts={OPEN_SORTS} closed={false} view={l.view()} onPick={l.sortBy} />
      </div>
      <Show when={l.view().peer}>
        {(p) => (
          <PeerBar
            peer={p()}
            known={shown()[0]?.peer}
            together={shown()[0]?.with_peer}
            clear={l.href({ peer: undefined })}
          />
        )}
      </Show>
      <p class="ln-node-total" aria-live="polite" ref={l.mark}>
        <Show when={page()}>
          {(p) => (
            <Show
              when={filtered()}
              fallback={<>{count(props.node.channels.open, "open channel")}</>}
            >
              <span>
                <strong class="num">{groupDigits(p().total)}</strong> of{" "}
                {count(props.node.channels.open, "open channel")} match
              </span>
            </Show>
          )}
        </Show>
        <Show when={l.view().fee}>
          {(f) => <Active clear={l.href({ fee: undefined })}>{feeWords(f())}</Active>}
        </Show>
        <Show when={l.view().q}>
          {(q) => (
            <Active clear={l.href({ q: undefined })}>
              Matching “<bdi>{q()}</bdi>”
            </Active>
          )}
        </Show>
      </p>
      <Switch>
        <Match when={l.failed()}>
          <ErrorState title="Could not load these channels" error={l.error()} retry={l.retry} />
        </Match>
        <Match when={page()}>
          <div class="ln-busy" aria-busy={l.busy() ? "true" : "false"}>
            <Show
              when={shown().length > 0}
              fallback={<Empty title="No channel matches these filters" />}
            >
              <Show
                when={!phone()}
                fallback={
                  <ol class="ln-node-cards">
                    <For each={shown()}>
                      {(c) => (
                        <OpenCard
                          c={c}
                          now={props.now}
                          peerHref={peerHref(c)}
                          extra={sortedFigure(l.view().sort, c)}
                        />
                      )}
                    </For>
                  </ol>
                }
              >
                <DataTable
                  caption={sortedBy("Its open channels", l.view())}
                  columns={columns()}
                  rows={shown()}
                  rowHref={(c) => paths.lightningChannel(c.id)}
                  sort={l.sorting()}
                />
              </Show>
            </Show>
          </div>
        </Match>
        <Match when={true}>
          <Loading label="Loading its channels" />
        </Match>
      </Switch>
      <Pages page={page()} view={l.view()} go={l.go} label="Channel pages" />
      <More label="About policies">
        <p>
          Fee out is what this node charges to forward over the channel; fee in is what the peer
          charges to forward towards it. A discount or surcharge under a fee is that end's inbound
          fee (lnd's), on payments that reach it over the channel. "Updated" is the newer of the two
          policies. Enabled means both ends advertise forwarding: what they say, not proof the
          channel can route a payment. A policy goes missing when none has come for two weeks.
        </p>
      </More>
    </section>
  );
}

function Pages<T>(props: {
  page: ChannelPage<T> | undefined;
  view: ListView;
  go: (change: Record<string, string | undefined>) => void;
  label: string;
}) {
  const pages = () => {
    const p = props.page;
    return p === undefined ? 1 : Math.max(1, Math.ceil(p.total / p.per_page));
  };
  return (
    <Show when={pages() > 1}>
      <Pagination
        page={props.view.page + 1}
        pageCount={pages()}
        onPage={(n) => props.go({ page: n === 1 ? undefined : String(n) })}
        label={props.label}
      />
    </Show>
  );
}

/** The chevron that opens a card's details, a thumb high on a touch screen. */
function Toggle(props: { open: boolean; id: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      class="ln-node-card__toggle tap"
      aria-expanded={props.open ? "true" : "false"}
      aria-label={`More about ${props.id}`}
      onClick={() => props.onToggle()}
    >
      <span aria-hidden="true">{props.open ? "▴" : "▾"}</span>
    </button>
  );
}

/** A phone's open channel in three short lines: who and which; the fee each way; its size,
 * state, age and freshness. The rest is under the chevron. */
function OpenCard(props: {
  c: OpenChannel;
  now: number;
  peerHref: string;
  extra: JSX.Element | null;
}) {
  const c = () => props.c;
  const [open, setOpen] = createSignal(false);
  // Each figure whole; the line breaks between the rate and the base fee where it must.
  const fee = (p: Policy | null) => (
    <Show when={p} fallback={MISSING}>
      {(q) => (
        <>
          <PpmFig rate={q().fee_rate} /> <MsatFig msat={q().base_fee_msat} sign="+" />
        </>
      )}
    </Show>
  );
  const policyAge = (who: string, p: Policy | null) => (
    <>
      {who}{" "}
      <Show when={p} fallback="missing">
        {(q) => <span class="num">{ageShort(props.now - q().last_update)} ago</span>}
      </Show>
    </>
  );
  return (
    <li class="ln-node-card">
      <p class="ln-node-card__id">
        <Link
          class="ln-node-peer"
          href={props.peerHref}
          noscroll
          title="Show only this peer's channels"
        >
          <Alias alias={c().peer.alias} max={22} />
        </Link>
        <Show when={c().with_peer > 1}>
          <span class="ln-node-together">×{c().with_peer}</span>
        </Show>
        <span class="ln-node-card__chan">
          <Link class="ln-id num" href={paths.lightningChannel(c().id)}>
            <ChannelId id={c().id} />
          </Link>
        </span>
      </p>
      <p class="ln-node-card__fees">
        <span>
          <span class="ln-node-card__k">out</span> {fee(c().own_policy)}
        </span>
        <span>
          <span class="ln-node-card__k">in</span> {fee(c().peer_policy)}
        </span>
      </p>
      <p class="ln-node-card__state">
        <SatsFig sats={c().capacity} />
        <StateTag c={c()} short />
        <span class="num">
          <Show when={c().funded} fallback={MISSING}>
            {(f) => <>{days(props.now - f())} d</>}
          </Show>
        </span>
        <Show when={c().last_update}>
          {(t) => <span class="num muted ln-node-card__upd">upd {ageShort(props.now - t())}</span>}
        </Show>
        {props.extra}
        <Toggle open={open()} id={c().id} onToggle={() => setOpen((o) => !o)} />
      </p>
      <Show when={open()}>
        <dl class="ln-node-card__list">
          <div>
            <dt>CLTV delta</dt>
            <dd>
              this node{" "}
              <span class="num">
                {c().own_policy ? groupDigits(c().own_policy?.cltv_delta ?? 0) : MISSING}
              </span>
              , the peer{" "}
              <span class="num">
                {c().peer_policy ? groupDigits(c().peer_policy?.cltv_delta ?? 0) : MISSING}
              </span>
            </dd>
          </div>
          <div>
            <dt>HTLC, this node</dt>
            <dd>
              <Show when={c().own_policy} fallback={MISSING}>
                {(p) => (
                  <>
                    <MsatFig msat={p().min_htlc_msat} /> to <MsatFig msat={p().max_htlc_msat} />
                  </>
                )}
              </Show>
            </dd>
          </div>
          <For each={[c().own_policy, c().peer_policy]}>
            {(p, k) => (
              <Show when={inboundOf(p)}>
                {(f) => (
                  <div>
                    <dt>
                      {inboundName(f())}, {k() === 0 ? "this node" : "the peer"}
                    </dt>
                    <dd>
                      <InboundFig fee={f()} />
                    </dd>
                  </div>
                )}
              </Show>
            )}
          </For>
          <div>
            <dt>Policies updated</dt>
            <dd>
              {policyAge("this node", c().own_policy)}; {policyAge("the peer", c().peer_policy)}
            </dd>
          </div>
          <div>
            <dt>Open</dt>
            <dd class="ln-node-card__go">
              <Link class="tap" href={paths.lightningChannel(c().id)}>
                The channel
              </Link>
              <Link class="tap" href={props.peerHref} noscroll>
                Only this peer
              </Link>
            </dd>
          </div>
          <div>
            <dt>The peer</dt>
            <dd>
              <span class="ln-key">{truncateMiddle(c().peer.id, 8, 6)}</span>
              <Show when={c().peer.channels}>
                {(n) => (
                  <>
                    , <span class="num">{count(n(), "channel")}</span>,{" "}
                    <Amount sats={c().peer.capacity ?? 0} wrap />
                  </>
                )}
              </Show>
            </dd>
          </div>
        </dl>
      </Show>
    </li>
  );
}

const CLOSED_SORTS = ["closed", "capacity", "fee", "lived"] as const;

/** How long a closed channel lived, in whole days; unknown while its funding time is not stored. */
const lived = (c: ClosedChannel) =>
  c.funded === null ? null : Math.max(0, Math.floor((c.closed.block.time - c.funded) / 86_400));

/**
 * What the closed list needs of its node: its key and its closes by kind. A node the graph no
 * longer holds has these from its close record, so its page lists its closes too.
 */
export interface ClosedOf {
  id: string;
  /** False where the counts are a lower bound (a record of the newest closes only). */
  exact?: boolean;
  channels: Pick<NodeDetail["channels"], "closed" | "cooperative" | "force" | "penalty" | "other">;
}

export function ClosedList(props: { node: ClosedOf; network: Network; now: number }) {
  const phone = usePhone();
  const l = useList(props, true, isClosedPage, () => undefined);
  const page = () => l.held()?.page;
  const shown = () => page()?.channels ?? [];
  const peerHref = (c: ClosedChannel) => l.href({ peer: c.peer.id });
  const columns = (): Column<ClosedChannel>[] => [
    {
      header: "Peer and channel",
      cell: (c) => (
        <span class="ln-node-row2">
          <span class="ln-node-row2__line">
            <Link
              class="ln-node-peer"
              href={peerHref(c)}
              noscroll
              title="Show only closes with this peer"
            >
              <Alias alias={c.peer.alias} max={24} />
            </Link>
            <span class="ln-key" title={c.peer.id}>
              {truncateMiddle(c.peer.id, 6, 4)}
            </span>
          </span>
          <ChannelLink id={c.id} />
        </span>
      ),
    },
    {
      header: "What happened",
      cell: (c) => (
        <span class="ln-node-row2">
          <Tag icon={KIND_TAG[c.closed.kind].icon} tone={KIND_TAG[c.closed.kind].tone}>
            {KIND_SHORT[c.closed.kind]}
          </Tag>
          <Continued id={c.continued_as} />
        </span>
      ),
    },
    {
      header: "Capacity",
      sub: "sats",
      numeric: true,
      sort: "capacity",
      cell: (c) => groupDigits(c.capacity),
    },
    {
      header: "Closing fee",
      sub: "sats",
      numeric: true,
      sort: "fee",
      cell: (c) => (c.closed.fee === null ? MISSING : groupDigits(c.closed.fee)),
    },
    {
      header: "Lived",
      sub: "days",
      numeric: true,
      sort: "lived",
      cell: (c) => {
        const d = lived(c);
        return d === null ? MISSING : groupDigits(d);
      },
    },
    {
      header: "Closing transaction",
      cell: (c) => (
        <Hash
          value={c.closed.txid}
          href={paths.tx(c.closed.txid)}
          copyLabel="Copy closing transaction ID"
        />
      ),
    },
    {
      header: "Closed",
      numeric: true,
      sort: "closed",
      cell: (c) => (
        <span class="ln-node-row2 ln-node-row2--end">
          <span>{formatDay(c.closed.block.time)}</span>
          <span class="ln-row-when">
            Block <BlockLink block={c.closed.block} />
          </span>
        </span>
      ),
    },
  ];
  const filtered = () => {
    const v = l.view();
    return v.q !== "" || v.peer !== null || v.kind !== null;
  };
  // The whole list's count from its own unfiltered answer once it has one: the node's figure can
  // be older than the list, or a lower bound.
  const [whole, setWhole] = createSignal<number | undefined>(undefined);
  createEffect(
    () => (l.busy() || filtered() ? undefined : page()?.total),
    (n) => {
      if (n !== undefined) setWhole(n);
    },
  );
  // Counts that are a lower bound name every kind, with no count: a kind may be among the rest.
  const exact = () => props.node.exact !== false;
  // The whole list's count: its own, or the node's where that is exact; otherwise not known, and
  // then never given (a lower bound is not a total) and the list never said to be empty.
  const total = () => whole() ?? (exact() ? props.node.channels.closed : undefined);
  return (
    <section aria-labelledby="ln-node-closed-title" class="ln-node-list">
      <SectionHeader title="Closed channels" id="ln-node-closed-title">
        Seen by this server
      </SectionHeader>
      <Show
        when={(total() ?? 1) > 0}
        fallback={
          <Empty title="No close seen">
            None of its channels closed while this server watched.
          </Empty>
        }
      >
        <div class="ln-node-filters">
          <FilterField value={l.view().q} onChange={(q) => l.go({ q, page: undefined }, true)} />
          <div
            class="ln-node-chips"
            role="group"
            aria-label="Kind of close"
            ref={owned((el) => {
              scrollCue(el);
              dragScroll(el);
            })}
          >
            <Link
              class="btn ln-node-chip"
              href={l.href({ kind: undefined })}
              aria-current={l.view().kind === null ? "true" : "false"}
              noscroll
            >
              All
              <Show when={total()}>
                {(n) => (
                  <>
                    {" "}
                    <span class="num muted">{groupDigits(n())}</span>
                  </>
                )}
              </Show>
            </Link>
            <For each={CLOSE_KINDS}>
              {(k) => (
                <Show when={!exact() || props.node.channels[k] > 0}>
                  <Link
                    class="btn ln-node-chip"
                    href={l.href({ kind: l.view().kind === k ? undefined : k })}
                    aria-current={l.view().kind === k ? "true" : "false"}
                    noscroll
                  >
                    <Tag icon={KIND_TAG[k].icon} tone={KIND_TAG[k].tone}>
                      {KIND_SHORT[k]}
                    </Tag>
                    <Show when={exact()}>
                      <span class="num muted">{groupDigits(props.node.channels[k])}</span>
                    </Show>
                  </Link>
                </Show>
              )}
            </For>
          </div>
          <SortPicker sorts={CLOSED_SORTS} closed view={l.view()} onPick={l.sortBy} />
        </div>
        <Show when={l.view().peer}>
          {(p) => (
            <PeerBar
              peer={p()}
              known={shown()[0]?.peer}
              together={undefined}
              clear={l.href({ peer: undefined })}
            />
          )}
        </Show>
        <p class="ln-node-total" aria-live="polite" ref={l.mark}>
          <Show when={page()}>
            {(p) => (
              <Show
                when={filtered()}
                // Unfiltered, the count is the whole list's once known; until then (its answer on
                // its way, after a filter is cleared) the held page's count is not it.
                fallback={<Show when={total()}>{(n) => <>{count(n(), "close")}</>}</Show>}
              >
                <Show
                  when={total()}
                  fallback={
                    <span>
                      <strong class="num">{groupDigits(p().total)}</strong>{" "}
                      {p().total === 1 ? "close matches" : "closes match"}
                    </span>
                  }
                >
                  {(n) => (
                    <span>
                      <strong class="num">{groupDigits(p().total)}</strong> of {count(n(), "close")}{" "}
                      match
                    </span>
                  )}
                </Show>
              </Show>
            )}
          </Show>
          <Show when={l.view().q}>
            {(q) => (
              <Active clear={l.href({ q: undefined })}>
                Matching “<bdi>{q()}</bdi>”
              </Active>
            )}
          </Show>
        </p>
        <Switch>
          <Match when={l.failed()}>
            <ErrorState title="Could not load these closes" error={l.error()} retry={l.retry} />
          </Match>
          <Match when={page()}>
            <div class="ln-busy" aria-busy={l.busy() ? "true" : "false"}>
              <Show
                when={shown().length > 0}
                fallback={<Empty title="No close matches these filters" />}
              >
                <Show
                  when={!phone()}
                  fallback={
                    <ol class="ln-node-cards">
                      <For each={shown()}>{(c) => <ClosedCard c={c} peerHref={peerHref(c)} />}</For>
                    </ol>
                  }
                >
                  <DataTable
                    caption={sortedBy("Its closed channels", l.view())}
                    columns={columns()}
                    rows={shown()}
                    rowHref={(c) => paths.lightningChannel(c.id)}
                    sort={l.sorting()}
                  />
                </Show>
              </Show>
            </div>
          </Match>
          <Match when={true}>
            <Loading label="Loading its closes" />
          </Match>
        </Switch>
        <Pages page={page()} view={l.view()} go={l.go} label="Close pages" />
      </Show>
      <More label="How closes are told apart">
        <p>
          A force close is a commitment one end broadcast alone; a penalty, one whose revoked state
          was swept. A cooperative close spends the channel alone. "Continued as" is inferred: the
          closing transaction also funds a new channel between the same two nodes. "Other" spends
          more than the channel.
        </p>
      </More>
    </section>
  );
}

/** The channel a close funded between the same two nodes: inferred from the chain, so said so. */
function Continued(props: { id: string | null }) {
  return (
    <Show when={props.id}>
      {(n) => (
        <span class="ln-node-continued">
          Continued as <ChannelLink id={n()} />
        </span>
      )}
    </Show>
  );
}

/** A closed channel on a phone: the open card's shape, the rest under the same chevron. */
function ClosedCard(props: { c: ClosedChannel; peerHref: string }) {
  const c = () => props.c;
  const [open, setOpen] = createSignal(false);
  return (
    <li class="ln-node-card">
      <p class="ln-node-card__id">
        <Link class="ln-node-peer" href={props.peerHref} noscroll>
          <Alias alias={c().peer.alias} max={22} />
        </Link>
        <span class="ln-node-card__chan">
          <Link class="ln-id num" href={paths.lightningChannel(c().id)}>
            <ChannelId id={c().id} />
          </Link>
        </span>
      </p>
      <p class="ln-node-card__fees">
        <SatsFig sats={c().capacity} />
        <span>
          <span class="ln-node-card__k">lived</span>{" "}
          <span class="num">{lived(c()) === null ? MISSING : count(lived(c()) ?? 0, "day")}</span>
        </span>
      </p>
      <p class="ln-node-card__state">
        <Tag icon={KIND_TAG[c().closed.kind].icon} tone={KIND_TAG[c().closed.kind].tone}>
          {KIND_SHORT[c().closed.kind]}
        </Tag>
        <span class="num">{formatDay(c().closed.block.time)}</span>
        <Toggle open={open()} id={c().id} onToggle={() => setOpen((o) => !o)} />
      </p>
      <Show when={c().continued_as}>
        <p class="ln-node-card__state">
          <Continued id={c().continued_as} />
        </p>
      </Show>
      <Show when={open()}>
        <dl class="ln-node-card__list">
          <div>
            <dt>Open</dt>
            <dd class="ln-node-card__go">
              <Link class="tap" href={paths.lightningChannel(c().id)}>
                The channel
              </Link>
              <Link class="tap" href={props.peerHref} noscroll>
                Only this peer
              </Link>
            </dd>
          </div>
          <div>
            <dt>The peer</dt>
            <dd>
              <span class="ln-key">{truncateMiddle(c().peer.id, 8, 6)}</span>
            </dd>
          </div>
          <div>
            <dt>Block</dt>
            <dd class="num">
              <BlockLink block={c().closed.block} />
            </dd>
          </div>
          <div>
            <dt>Closing fee</dt>
            {/* A fee of 0 is a fee: only an unknown one is missing. */}
            <dd>{c().closed.fee === null ? MISSING : <SatsFig sats={c().closed.fee ?? 0} />}</dd>
          </div>
          <div>
            <dt>Closing transaction</dt>
            <dd>
              <Hash
                value={c().closed.txid}
                href={paths.tx(c().closed.txid)}
                copyLabel="Copy closing transaction ID"
              />
            </dd>
          </div>
        </dl>
      </Show>
    </li>
  );
}
