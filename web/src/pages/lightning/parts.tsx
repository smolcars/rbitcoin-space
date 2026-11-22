// Pieces every Lightning page shares: the gate that says whether there is anything to show,
// names from gossip, links and figures.
import { useLocation } from "@solidjs/router";
import {
  type Accessor,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import type { Column } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { Empty, ErrorState, Loading } from "../../components/States";
import { ApiError, createRequest, fetchApp } from "../../lib/api";
import { formatBtcShort, formatPowerOfTen, groupDigits, truncateMiddle } from "../../lib/format";
import { hasLightning, NETWORK_NAMES, type Network, paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import {
  type BlockRef,
  cleanAlias,
  type CloseKind,
  count,
  cut,
  type IconName,
  type InboundFee,
  inboundWord,
  isStatus,
  KIND_SHORT,
  KIND_TAG,
  msat,
  LONG_FIGURE,
  LONGER_FIGURE,
  msatAsBtc,
  msatAsSats,
  NAME_IN_LIST,
  type NodeRef,
  plus,
  ppm,
  type RankedNode,
  type Status,
  type Tone,
} from "./lightning";
import "./Lightning.css";

/** How often the gate asks again while the peer starts or syncs. */
export const STATUS_POLL_MS = 5000;

/** A reply that is not the shape the page reads: a newer server, or a broken one. */
export const unreadable = () =>
  new ApiError(200, "The server sent a reply that could not be read.");

/** Asks one `/app/lightning` path on a network and checks its shape. */
export async function ask<T>(
  network: Network,
  path: string,
  check: (v: unknown) => v is T,
  signal: AbortSignal,
): Promise<T> {
  const v = await fetchApp<unknown>(network, `/lightning${path}`, { signal, cached: true });
  if (!check(v)) throw unreadable();
  return v;
}

/**
 * Says whether this network has Lightning to show before a page asks for anything else: switched
 * off, starting, still syncing (and how far), failed, or ready. Asks the status route, which
 * always answers, so a network without Lightning costs one small request and no refusal.
 */
export function Gate(props: { children: JSX.Element }) {
  const network = useNetwork();
  const [status, { refetch }] = createRequest(
    () => network(),
    (n, signal) => ask(n, "/status", isStatus, signal),
  );
  const state = () => status.latest?.state;
  // A synced graph that could not be indexed yet: the server tries again by itself.
  const unindexed = () => state() === "failed" && status.latest?.synced === true;
  onSettled(() => {
    const timer = setInterval(() => {
      const s = state();
      if ((s === "starting" || s === "syncing" || unindexed()) && !status.loading) refetch();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  });
  return (
    <Switch>
      <Match when={state() === "synced"}>{props.children}</Match>
      <Match when={status.state === "errored" && status.latest === undefined}>
        <ErrorState
          title="Could not reach this server's Lightning peer"
          error={status.error}
          retry={refetch}
        />
      </Match>
      <Match when={state() === "off" && !hasLightning(network())}>
        <Empty title={`There is no Lightning on ${NETWORK_NAMES[network()]} here`}>
          The Lightning software this server runs does not know {NETWORK_NAMES[network()]} yet, so
          it has no Lightning peer on it. Blocks and transactions are on the{" "}
          <Link href={paths.home()}>home page</Link>.
        </Empty>
      </Match>
      <Match when={state() === "off"}>
        <Empty title={`Lightning is switched off on ${NETWORK_NAMES[network()]}`}>
          This server does not follow the Lightning network here: its operator runs the Lightning
          peer only on the networks they choose, and this is not one of them. Blocks and
          transactions are on the <Link href={paths.home()}>home page</Link>.
        </Empty>
      </Match>
      <Match when={unindexed()}>
        <Empty title="This server cannot show its Lightning graph yet">
          Its Lightning peer has the channel graph, but the server could not prepare it for these
          pages. It tries again by itself, and the pages appear here once it can.
        </Empty>
      </Match>
      <Match when={state() === "failed" || state() === "stopped"}>
        <Empty title="This server's Lightning peer is not running">
          It {state() === "failed" ? "could not start or stopped working" : "has been stopped"}, so
          there is no channel graph to show. Its operator has to restart the server.
        </Empty>
      </Match>
      <Match when={status.latest}>{(s) => <Syncing status={s()} />}</Match>
      <Match when={true}>
        <Loading label="Asking the Lightning peer" />
      </Match>
    </Switch>
  );
}

/** The peer is starting or syncing: what it has done so far, refreshed until it is done. */
export function Syncing(props: { status: Status }) {
  const v = () => props.status.validation;
  return (
    <div class="ln-syncing" role="status">
      <p class="ln-syncing__title">
        {props.status.state === "starting"
          ? "Starting the Lightning peer"
          : "Syncing the Lightning network"}
      </p>
      <p class="ln-syncing__text">
        This server's Lightning peer is receiving the channel graph from other nodes and checking
        each channel against the chain. These pages appear by themselves when it is done: a first
        start takes about four minutes, a restart about one.
      </p>
      <Show when={v()}>
        {(val) => (
          <dl class="ln-stats ln-stats--small">
            <Stat label="Channels checked">{groupDigits(val().verified)}</Stat>
            <Stat label="Waiting to be checked">
              {groupDigits(val().pending + val().unchecked + val().early)}
            </Stat>
            <Stat label="Nodes">{groupDigits(props.status.nodes ?? Number.NaN)}</Stat>
            <Stat label="Peers connected">
              {groupDigits(props.status.peers_connected ?? 0)}
              <span class="ln-stat__of"> of {groupDigits(props.status.peers_configured ?? 0)}</span>
            </Stat>
          </dl>
        )}
      </Show>
    </div>
  );
}

/** A label over a large figure, with a muted line under it. */
export function Stat(props: { label: string; children: JSX.Element; sub?: JSX.Element }) {
  return (
    <div class="ln-stat">
      <dt class="ln-stat__label">{props.label}</dt>
      <dd class="ln-stat__value">
        {props.children}
        <Show when={props.sub}>
          <span class="ln-stat__sub">{props.sub}</span>
        </Show>
      </dd>
    </div>
  );
}

/**
 * A node's announced name as text: cleaned (lightning.ts `cleanAlias`), cut to `max` characters
 * with the cleaned whole in the title, and isolated so its direction cannot spill into the text
 * around it. A node that announced none reads "No name".
 */
export function Alias(props: { alias: string | null; max?: number }) {
  const clean = () => cleanAlias(props.alias);
  return (
    <Show when={clean()} fallback={<span class="ln-alias ln-alias--none">No name</span>}>
      {(name) => {
        const shown = () => cut(name(), props.max ?? NAME_IN_LIST);
        return (
          // Always titled: a narrow column can cut a name its length did not.
          <bdi class="ln-alias" title={cut(name(), 512).text}>
            {shown().text}
          </bdi>
        );
      }}
    </Show>
  );
}

/**
 * A node in a list: its name linked to its page, and its public key, the identity, under it.
 * `link={false}` for a node the graph no longer holds, whose page would say so and nothing more.
 */
export function NodeName(props: { node: NodeRef; link?: boolean }) {
  return (
    <span class="ln-node">
      <Show
        when={props.link !== false}
        fallback={
          <span class="ln-node__name">
            <Alias alias={props.node.alias} />
          </span>
        }
      >
        <Link class="ln-node__name" href={paths.lightningNode(props.node.id)}>
          <Alias alias={props.node.alias} />
        </Link>
      </Show>
      <span class="ln-key" title={props.node.id}>
        {truncateMiddle(props.node.id, 8, 6)}
      </span>
    </span>
  );
}

/** A channel id that wraps after an "x", never inside one of its numbers. */
export function ChannelId(props: { id: string }) {
  const parts = () => props.id.split("x");
  return (
    <For each={parts()}>
      {(p, i) => (
        <>
          {p}
          <Show when={i() < parts().length - 1}>
            x<wbr />
          </Show>
        </>
      )}
    </For>
  );
}

export function ChannelLink(props: { id: string }) {
  return (
    <Link class="ln-id num" href={paths.lightningChannel(props.id)}>
      <ChannelId id={props.id} />
    </Link>
  );
}

/** A drawn icon the size of its text, in its tag's tone; always beside a word that says the same. */
export function Icon(props: { name: IconName }) {
  return (
    <svg class="ln-icon" viewBox="0 0 16 16" aria-hidden="true">
      {ICONS[props.name]()}
    </svg>
  );
}

// Functions, not elements: one element can sit in one place only.
const ICONS: Record<IconName, () => JSX.Element> = {
  check: () => (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.2l2 2 4-4.4" />
    </>
  ),
  pause: () => (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M6.5 5.5v5M9.5 5.5v5" />
    </>
  ),
  // The peer's end paused: the same pause, its ring dashed, so the two read apart without colour.
  pauseDashed: () => (
    <>
      <circle cx="8" cy="8" r="6.5" stroke-dasharray="2.6 1.8" />
      <path d="M6.5 5.5v5M9.5 5.5v5" />
    </>
  ),
  off: () => (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M3.5 12.5l9-9" />
    </>
  ),
  swap: () => <path d="M2.5 5.5h10l-2.5-2.5M13.5 10.5h-10l2.5 2.5" />,
  warn: () => (
    <>
      <path d="M8 1.8l6.6 12H1.4z" />
      <path d="M8 6.5v3.2M8 11.6v.2" />
    </>
  ),
  cross: () => (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </>
  ),
  branch: () => <path d="M3 3v4.5c0 2 1.5 3 3.5 3H13M10.5 8l2.5 2.5-2.5 2.5M3 13v-1" />,
  // A closed channel: a filled square, never the pause of a disabled direction.
  stop: () => (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <rect x="5.5" y="5.5" width="5" height="5" fill="currentColor" stroke="none" />
    </>
  ),
  plus: () => (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 5v6M5 8h6" />
    </>
  ),
  // A fee moved: a line that steps up.
  fee: () => <path d="M1.5 11.5h4l2-4h3l2-3h2" />,
};

/** A state as its icon, in the tone's colour, and its word. */
export function Tag(props: {
  icon: IconName;
  tone: Tone;
  children: JSX.Element;
  class?: string | undefined;
}) {
  return (
    <span class={["ln-tag", `ln-tag--${props.tone}`, props.class]}>
      <Icon name={props.icon} />
      <span>{props.children}</span>
    </span>
  );
}

/** A close's kind as a tag: `Force`, or `Force close` when `long`. */
export function KindTag(props: { kind: CloseKind; long?: boolean }) {
  const k = () => KIND_TAG[props.kind];
  return (
    <Tag icon={k().icon} tone={k().tone}>
      {KIND_SHORT[props.kind]}
      {props.long ? " close" : ""}
    </Tag>
  );
}

export function BlockLink(props: { block: BlockRef }) {
  return (
    <Link class="num tap" href={paths.block(props.block.hash)}>
      {groupDigits(props.block.height)}
    </Link>
  );
}

/** The two ends of a channel, one over the other. */
export function Ends(props: { one: NodeRef; two: NodeRef }) {
  return (
    <span class="ln-ends">
      <NodeName node={props.one} />
      <NodeName node={props.two} />
    </span>
  );
}

/**
 * A node table's columns: the node, then its capacity and channels. The one a list is not
 * ranked by is dropped on phones, so the table fits their width.
 */
export function nodeColumns(by: "capacity" | "channels" | "age"): Column<RankedNode>[] {
  return [
    { header: "Node", cell: (n) => <NodeName node={n} /> },
    {
      header: "Capacity, BTC",
      numeric: true,
      optional: by === "channels",
      drop: by === "capacity" ? undefined : 4,
      cell: (n) => <Amount sats={n.capacity} unit={false} short />,
    },
    {
      header: "Channels",
      numeric: true,
      optional: by !== "channels",
      drop: by === "channels" ? undefined : 4,
      cell: (n) => groupDigits(n.channels),
    },
  ];
}

/** One line under a section's figures, saying what makes them ours. */
export const VERIFIED_NOTE =
  "Only channels whose funding output this server found on the chain, unspent and paying the two announced keys. Sites that list whatever gossip claims show more.";

/** A count of closes by kind, in words: `3 force, 1 cooperative`; "none" when there are none. */
export function closesInWords(c: {
  cooperative: number;
  force: number;
  penalty: number;
  other: number;
}): string {
  const parts = [
    c.cooperative > 0 ? `${groupDigits(c.cooperative)} cooperative` : "",
    c.force > 0 ? `${groupDigits(c.force)} force` : "",
    c.penalty > 0 ? count(c.penalty, "penalty", "penalties") : "",
    c.other > 0 ? `${groupDigits(c.other)} other` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** The last Lightning list the reader looked at, so a node or channel can lead back to it. */
let lastList: { href: string; label: string } | undefined;

/** Remembers a list page as where the reader came from; call it when one is shown. */
export function rememberList(href: string, label: string): void {
  lastList = { href, label };
}

/**
 * Lightning's own way around: its overview, its rankings and the overview's history chart, as a short
 * row of links, and on a node
 * or channel a way back to the list the reader came from. One line, never a tall band.
 */
export function LightningNav(props: {
  here: "overview" | "rankings" | "search" | "penalties" | "detail";
}) {
  const back = () => (props.here === "detail" ? lastList : undefined);
  // One current destination: the overview at its top, its chart once the address says so.
  const location = useLocation();
  const atChart = () => props.here === "overview" && location.hash === "#history";
  return (
    <nav class="ln-nav" aria-label="Lightning">
      <Show when={back()}>
        {(b) => (
          <Link class="ln-nav__back" href={b().href}>
            ← {b().label}
          </Link>
        )}
      </Show>
      <Link
        class="ln-nav__item"
        href={paths.lightning()}
        aria-current={props.here === "overview" && !atChart() ? "page" : "false"}
      >
        Overview
      </Link>
      <Link
        class="ln-nav__item"
        href={paths.lightningRankings()}
        aria-current={props.here === "rankings" ? "page" : "false"}
      >
        Rankings
      </Link>
      {/* The overview's chart, from wherever the reader is: an anchor, not another page. */}
      <Link
        class="ln-nav__item"
        href={`${paths.lightning()}#history`}
        aria-current={atChart() ? "location" : "false"}
      >
        History
      </Link>
    </nav>
  );
}

/**
 * An msat figure (`msatAsSats`), exact to the msat with its unit, the msat in its title. One
 * longer than `LONG_FIGURE` carries its magnitude too (`msatAsBtc`), for an overview's narrowest
 * room (the live feed, a node's cards); where the figure is the answer (a channel's terms) the room
 * breaks it before its unit instead. `sign` goes before either (a difference).
 */
export function MsatFig(props: { msat: number | bigint; sign?: string }) {
  const sign = () => props.sign ?? "";
  return (
    <Fig
      exact={`${sign()}${msatAsSats(props.msat)}`}
      short={`${sign()}${msatAsBtc(props.msat)}`}
      title={typeof props.msat === "number" ? msat(props.msat) : undefined}
    />
  );
}

/**
 * A figure in two forms: `exact`, and where that is long, `short` for a list's narrowest room.
 * One past `LONGER_FIGURE` is marked too, for rooms that act on only those. A room whose figure is
 * the answer never shows `short`: it lets `exact` break before its unit (`Lightning.css`).
 */
export function Fig(props: {
  exact: string;
  short: string;
  unit?: string;
  title?: string | undefined;
}) {
  // With `unit`, the exact form is the figure and its unit in a span of its own, for a room that
  // sets the unit smaller (a node's card); one piece all the same.
  const length = () => props.exact.length + (props.unit === undefined ? 0 : props.unit.length + 1);
  const long = () => length() > LONG_FIGURE;
  return (
    <span
      class={["num", { "ln-fig--long": long(), "ln-fig--longer": length() > LONGER_FIGURE }]}
      title={props.title}
    >
      <span class="ln-fig__exact">
        {props.exact}
        <Show when={props.unit}>
          {(u) => (
            <>
              {" "}
              <span class="ln-fig__unit">{u()}</span>
            </>
          )}
        </Show>
      </span>
      <Show when={long()}>
        <span class="ln-fig__short">{props.short}</span>
      </Show>
    </span>
  );
}

/** A fee rate whole with its unit, as a power of ten where the room is too narrow for it; a
 *  positive one carries its plus with `signed`. */
export const PpmFig = (props: { rate: number; signed?: boolean }) => {
  const sign = () => (props.signed ? plus(props.rate) : "");
  return (
    <Fig
      exact={`${sign()}${ppm(props.rate)}`}
      short={`${sign()}${formatPowerOfTen(props.rate)} ppm`}
    />
  );
};

/** An inbound fee's figures, each signed: `−200 ppm`, `+1 sat`, `−100 ppm −1 sat`. */
export function InboundFig(props: { fee: InboundFee }) {
  return (
    <>
      <Show when={props.fee.fee_rate !== 0}>
        <PpmFig rate={props.fee.fee_rate} signed />
      </Show>
      <Show when={props.fee.fee_rate !== 0 && props.fee.base_fee_msat !== 0}> </Show>
      <Show when={props.fee.base_fee_msat !== 0}>
        <MsatFig msat={props.fee.base_fee_msat} sign={plus(props.fee.base_fee_msat)} />
      </Show>
    </>
  );
}

/** "Inbound discount", "Inbound surcharge" or "Inbound fee", by the fee's sign. */
export const inboundName = (f: InboundFee): string =>
  inboundWord(f) === "fee" ? "Inbound fee" : `Inbound ${inboundWord(f)}`;

/** Sats whole with their unit, in magnitude where the room is too narrow for them (`Fig`). */
export const SatsFig = (props: { sats: number }) => (
  <Fig
    exact={groupDigits(props.sats)}
    unit={props.sats === 1 ? "sat" : "sats"}
    short={`${formatBtcShort(props.sats)} BTC`}
  />
);

/** Whether the viewport is a phone's (the 40em breakpoint), kept current. */
export function usePhone(): Accessor<boolean> {
  const media = window.matchMedia("(max-width: 40em)");
  const [phone, setPhone] = createSignal(media.matches);
  const change = () => setPhone(media.matches);
  media.addEventListener("change", change);
  onCleanup(() => media.removeEventListener("change", change));
  return phone;
}
