// A node's close record (docs/FRONTEND.md "Lightning pages"): how its channels this server watched
// ended, beside every channel's as last worked out, by week, and with whom. A record, not a
// verdict: kinds keep their icon and word in the muted tone, and a force close is never the node's.
import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { formatDay, formatMoment } from "../../components/chart/scale";
import { type Column, DataTable } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { ErrorState, Loading } from "../../components/States";
import { type ApiRequest, createRequest } from "../../lib/api";
import { groupDigits, MISSING, truncateMiddle } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import {
  CLOSE_WORDS,
  type CloseKind,
  count,
  days,
  isNodeCloses,
  KIND_SHORT,
  KIND_TAG,
  kindsIn,
  type NodeCloses,
  peersInWords,
  peersShown,
  percentOf,
  perClose,
  type RecordPeer,
  RECORD_WORDS,
  recordInWords,
  shareText,
  type WeekRow,
  weekRows,
  weeksInWords,
} from "./lightning";
import { Alias, ask, Tag } from "./parts";

/** Asks for a node's record: its own request, so a page that needs the answer first can hold it. */
export const askRecord = (network: Network, id: () => string): ApiRequest<NodeCloses> =>
  createRequest(id, (key, signal) => ask(network, `/nodes/${key}/closes`, isNodeCloses, signal));

/** The record's section, from a request made once by the page that shows it. */
export function RecordSection(props: { request: ApiRequest<NodeCloses> }) {
  const answer = () => props.request[0];
  return (
    <section aria-labelledby="ln-record-title" class="ln-record">
      <SectionHeader title="Close record" id="ln-record-title">
        <Show when={answer().latest} keyed>
          {(r) => <Span record={r} />}
        </Show>
      </SectionHeader>
      <Show
        when={answer().latest}
        keyed
        fallback={
          <Show
            when={answer().state === "errored"}
            fallback={<Loading label="Loading its close record" />}
          >
            <ErrorState
              title="Could not load its close record"
              error={answer().error}
              retry={() => props.request[1].refetch()}
            />
          </Show>
        }
      >
        {(r) => <Body record={r} />}
      </Show>
    </section>
  );
}

/**
 * A kind as its icon and word, in the muted tone whatever the kind: a tally is not a warning. The
 * one long word is shorter where a narrow screen or large text leaves no room; read in full.
 */
function Kind(props: { kind: CloseKind }) {
  return (
    <Tag icon={KIND_TAG[props.kind].icon} tone="muted">
      <Show when={props.kind === "cooperative"} fallback={KIND_SHORT[props.kind]}>
        <span class="ln-record__long">{KIND_SHORT[props.kind]}</span>
        <span class="ln-record__short" aria-hidden="true">
          Co-op
        </span>
      </Show>
    </Tag>
  );
}

/**
 * A share in words with its bar, this node's or every channel's: two cells of the shares' grid, so
 * the bars of a row start together. The bar repeats the figure beside it, so screen readers skip it.
 */
function Share(props: { share: number; count: number; whose: "node" | "all"; bar?: boolean }) {
  const text = () => shareText(props.share, props.count);
  return (
    <>
      {/* Only the figure is a figure: "all under 0.1%" may part between its words. */}
      <span class={`ln-record__words ln-record__words--${props.whose}`}>
        {props.whose === "all" ? "all " : ""}
        {text().startsWith("under ") ? "under " : ""}
        <span class="num">{text().replace(/^under /, "")}</span>
      </span>
      <Show when={props.bar !== false}>
        <span class={`ln-record__bar ln-record__bar--${props.whose}`} aria-hidden="true">
          <span style={{ "--w": `${Math.min(100, props.share)}%` }} />
        </span>
      </Show>
    </>
  );
}

/**
 * From when the node's record runs and as of when every channel's figures were worked out: the
 * network's come from a pass every ten minutes, the node's from the request, so they differ.
 */
function Span(props: { record: NodeCloses }) {
  const n = () => props.record.network;
  return (
    <>
      <Show when={props.record.from}>{(f) => <>Since {formatDay(f())}</>}</Show>
      <Show when={n()}>
        {(x) => (
          <>
            {props.record.from === null ? "" : "; "}all channels as of {formatMoment(x().time)}
          </>
        )}
      </Show>
    </>
  );
}

const sats = (n: number | null) => (n === null ? MISSING : groupDigits(n));

/**
 * To the closed list under the record: its heading takes the focus, so the keyboard carries on
 * from there. The heading is the shared section header's, so it is made focusable here.
 */
function toList(e: MouseEvent) {
  const heading = document.getElementById("ln-node-closed-title");
  if (heading === null) return;
  e.preventDefault();
  heading.setAttribute("tabindex", "-1");
  heading.focus();
  heading.scrollIntoView({ block: "start" });
}

/** Said once, where a reader meets the first force figure. */
const BOTH_ENDS =
  "A force close is in both nodes' records; the chain does not say which end broadcast it.";

function Body(props: { record: NodeCloses }) {
  const r = () => props.record;
  const rated = () => r().node.shares !== null;
  const forced = () => r().node.force + r().node.penalty > 0;
  const span = () => (r().from === null ? null : days(r().time - (r().from ?? r().time)));
  return (
    <>
      <Show
        when={r().from !== null}
        fallback={
          <p class="ln-record__lead">
            This server has not begun its record: it starts when its Lightning peer first syncs.
          </p>
        }
      >
        <p class="ln-record__lead">
          <Show
            when={r().node.closed > 0}
            fallback={<>None of its channels closed in the {span()} this server has watched.</>}
          >
            {/* The way past the record to the list it sums up, from its first screen. */}
            {/* rel="external" keeps the router out: it would mark this in-page link as the current page. */}
            <a
              class="ln-record__to-list"
              href="#ln-node-closed-title"
              rel="external"
              onClick={toList}
            >
              <strong class="num">{count(r().node.closed, "channel")}</strong>
            </a>{" "}
            closed{" "}
            {r().capped
              ? `in the ${span() ?? ""} up to now: its newest closes, the most this record reads. It has older ones too.`
              : `in the ${span() ?? ""} this server has watched.`}
          </Show>
        </p>
      </Show>
      <Show when={r().node.closed > 0}>
        <Show
          when={rated()}
          fallback={
            <>
              <Few record={r()} />
              <p class="ln-record__note">
                Shares are given from {groupDigits(r().minimum)} closes; with{" "}
                {groupDigits(r().node.closed)}, the counts say more than a share would.
                {forced() ? ` ${BOTH_ENDS}` : ""}
              </p>
              <details class="more ln-record__breakdown">
                <summary class="more__summary">Show the breakdown</summary>
                <Breakdown record={r()} />
              </details>
            </>
          }
        >
          <Breakdown record={r()} />
        </Show>
      </Show>
      <More label="How this record is made">
        <p>
          It counts the announced channels of this node that this server saw close, each once, in
          the kind its closing transaction shows, from{" "}
          {r().from === null ? "when this server's record starts" : formatDay(r().from ?? 0)}.
          Channels that closed before then, private channels, and a channel the server stopped
          watching are not in it. A node with more than {groupDigits(r().cap)} closes has a record
          of its newest {groupDigits(r().cap)}. "All channels" is every close the server had stored
          when it last worked them out, at the time above, from when its history starts: a close or
          a sweep seen since is in this node's figures and not yet in theirs.
        </p>
        <ul>
          <For each={["cooperative", "force", "penalty", "other"] as const}>
            {(k) => (
              <li>
                <strong>{CLOSE_WORDS[k].name}</strong> ({CLOSE_WORDS[k].sure.toLowerCase()}):{" "}
                {CLOSE_WORDS[k].why}
              </li>
            )}
          </For>
        </ul>
        <p>
          A penalty is seen only when its sweep confirms within 2,016 blocks of the force close, so
          a force close may yet have been a revoked state; the record holds the sweep it saw, not
          which end broadcast the commitment. Fees are those of the closing transactions: the chain
          does not say which end paid them, a force close's leaves out what was spent later to speed
          it or sweep its outputs, and an "other" close's covers every input of its transaction.
          What opening the channels cost is not shown: the server does not hold the funding
          transactions' fees, and one funding transaction can open several channels.
        </p>
      </More>
    </>
  );
}

/**
 * Too few closes for a share: the whole record in a line, by kind with its closing fees, beside
 * every channel's, and the tables a press away.
 */
function Few(props: { record: NodeCloses }) {
  const words = () => recordInWords(props.record);
  return (
    <div class="ln-record__few">
      <ul class="ln-record__kinds" aria-label="Its closes by kind">
        <For each={words().node}>
          {(w) => (
            <li>
              <Tag icon={KIND_TAG[w.kind].icon} tone="muted">
                <span class="num">{groupDigits(w.count)}</span> {KIND_SHORT[w.kind].toLowerCase()}
              </Tag>
              <span class="ln-record__all">{w.fees}</span>
            </li>
          )}
        </For>
      </ul>
      <p class="ln-record__network">{words().network}</p>
    </div>
  );
}

/**
 * The tables: how it ended across the panel, then on a wide screen the fees on the left beside the
 * weeks over with whom; on a phone the weeks and with whom are folded to their sentences.
 */
function Breakdown(props: { record: NodeCloses }) {
  return (
    <div class="ln-record__grid">
      <Ended record={props.record} />
      <Fees record={props.record} />
      <Weeks record={props.record} />
      <Peers record={props.record} />
    </div>
  );
}

/**
 * A part folded to its sentence on a phone and open on a wider screen, as the page first opened;
 * the reader's own toggle is kept after that. The sentence stays in sight when `always`.
 */
function Fold(props: {
  title: string;
  line: JSX.Element;
  /** Beside the heading while the part is open: a note that would otherwise take a line. */
  aside?: JSX.Element;
  always?: boolean;
  class?: string | undefined;
  children: JSX.Element;
}) {
  return (
    <details
      class={props.class === undefined ? "ln-record__fold" : `ln-record__fold ${props.class}`}
      // Set once, as the page opens: an attribute here would be set again with the class (when a
      // column drops), folding the part under the reader on a phone.
      ref={(el) => {
        el.open = !window.matchMedia("(max-width: 40em)").matches;
      }}
    >
      <summary class="ln-record__summary">
        <h3 class="ln-record__h">{props.title}</h3>
        <Show when={props.aside}>
          <span class="ln-record__aside">{props.aside}</span>
        </Show>
        <span
          class={
            props.always === true ? "ln-record__line" : "ln-record__line ln-record__line--closed"
          }
        >
          {props.line}
        </span>
      </summary>
      <div class="ln-record__part">{props.children}</div>
    </details>
  );
}

function Ended(props: { record: NodeCloses }) {
  const r = () => props.record;
  const net = () => r().network;
  const rated = () => r().node.shares !== null;
  const kinds = () => kindsIn(r().node, net());
  const columns = (): Column<CloseKind>[] => [
    {
      header: "How it ended",
      cell: (k) => (
        <span class="ln-record__kind">
          <Kind kind={k} />
          {/* A kind with no close is one line: its words are in "How this record is made". */}
          <Show when={r().node[k] > 0}>
            <span class="ln-record__gloss">{RECORD_WORDS[k]}</span>
          </Show>
        </span>
      ),
    },
    { header: "Closes", numeric: true, cell: (k) => groupDigits(r().node[k]) },
    {
      header: rated() ? "Share, this node then all" : "All channels",
      // A phone has room for the word: "all" before every channel's figure says whose each is.
      ...(rated() ? { short: "Share" } : {}),
      // Under every channel's minimum too, their column holds counts, and says so.
      ...(rated() ? {} : { sub: net()?.shares === null ? "closes" : "share" }),
      cell: (k) => {
        const n = net();
        const sh = r().node.shares;
        // A kind this node never closed by has no bar of its own: every channel's figure alone.
        const own = sh !== null && r().node[k] > 0;
        return (
          <span class={own ? "ln-record__shares" : "ln-record__shares ln-record__shares--one"}>
            <Show when={own && sh}>
              {(s) => <Share share={s()[k]} count={r().node[k]} whose="node" />}
            </Show>
            {n === null ? (
              <span class="ln-record__all">{MISSING}</span>
            ) : n.shares === null ? (
              // Too few for a share too: a count, said as one beside this node's shares.
              <span class="ln-record__all">
                {sh === null ? groupDigits(n[k]) : `all ${count(n[k], "close")}`}
              </span>
            ) : (
              // Beside a node's counts the network's bar would read as the node's: words only.
              <Share share={n.shares[k]} count={n[k]} whose="all" bar={own} />
            )}
          </span>
        );
      },
    },
  ];
  return (
    <div class="ln-record__part ln-record__part--wide ln-record__part--ended">
      <DataTable
        caption="How its channels ended, beside every channel's as of the time above"
        columns={columns()}
        rows={kinds()}
        rowClass={(k) => (r().node[k] === 0 ? "ln-record__row--none" : undefined)}
      />
      <Show when={rated() && r().node.force + r().node.penalty > 0}>
        <p class="ln-record__note">{BOTH_ENDS}</p>
      </Show>
    </div>
  );
}

function Fees(props: { record: NodeCloses }) {
  const [dropped, setDropped] = createSignal(0);
  const r = () => props.record;
  const kinds = () => kindsIn(r().node);
  const all = (k: CloseKind) => {
    const n = r().network;
    return n === null ? MISSING : sats(perClose(n.fees[k]));
  };
  const columns = (): Column<CloseKind>[] => [
    {
      header: "Closing transactions",
      short: "Closes",
      cell: (k) => (
        <span class="ln-record__cell">
          <Kind kind={k} />
          {/* Where the last column has no room, its figure is this row's second line. */}
          <span class="ln-record__second ln-record__second--fit">
            All channels: <span class="num">{all(k)}</span>
            {all(k) === MISSING ? "" : " sats a close"}
          </span>
        </span>
      ),
    },
    {
      // In all, and a close's mean under it: one column, so the table fits a phone. The unit in
      // the heading itself, which is what labels the figure where the table is cards.
      header: "In all, sats",
      numeric: true,
      cell: (k) => {
        const f = () => r().node.fees[k];
        return (
          <Show when={f().known > 0} fallback={MISSING}>
            <span class="ln-record__fee">
              {/* Two figures, spoken apart: read as one they make one large number. */}
              <span class="visually-hidden">
                {`${groupDigits(f().sum)} sats in all. ${sats(perClose(f()))} sats a close.`}
              </span>
              <span aria-hidden="true">{groupDigits(f().sum)}</span>
              <span class="ln-record__all" aria-hidden="true">
                <span class="num">{sats(perClose(f()))}</span> a{" "}close
              </span>
            </span>
          </Show>
        );
      },
    },
    {
      header: "All channels",
      sub: "a close, sats",
      numeric: true,
      // Kept on a phone, where it fits at the usual text size; dropped only where it does not.
      drop: 1,
      cell: (k) => (
        <>
          {/* Where the table is cards, the heading's unit is not over the figure: said in full. */}
          <span class="ln-record__card">All channels: </span>
          {all(k)}
          <Show when={all(k) !== MISSING}>
            <span class="ln-record__card"> sats a close</span>
          </Show>
        </>
      ),
    },
  ];
  const unknown = () => kinds().reduce((a, k) => a + r().node[k] - r().node.fees[k].known, 0);
  return (
    <div
      class={`ln-record__part ln-record__part--fees${dropped() > 0 ? " ln-record__part--dropped" : ""}`}
    >
      <h3 class="ln-record__h">Closing fees</h3>
      <DataTable
        caption="The fees of its channels' closing transactions, beside every channel's"
        columns={columns()}
        rows={kinds()}
        onDropped={setDropped}
      />
      <p class="ln-record__note">
        The fee each closing transaction paid: the chain does not say which end paid it.
        {unknown() > 0 ? ` The fee of ${count(unknown(), "close")} is not known and left out.` : ""}
      </p>
    </div>
  );
}

function Weeks(props: { record: NodeCloses }) {
  const [dropped, setDropped] = createSignal(0);
  const rows = () => weekRows(props.record.node.weeks, props.record.network?.weeks ?? null);
  const kinds = () => kindsIn(props.record.node);
  /** Every channel's figure for a week: a share, a count under the minimum, or none yet. */
  const all = (w: WeekRow) => {
    const n = w.network;
    if (n === null)
      return (
        <span>
          <span aria-hidden="true">{MISSING}</span>
          <span class="visually-hidden">
            {/* The "Earlier" row sums several weeks: one of them missing withholds its figure. */}
            {w.time === null
              ? "No figure for all of these weeks yet"
              : "No figure for this week yet"}
          </span>
        </span>
      );
    if (n.closed < props.record.minimum)
      return `${groupDigits(n.forced)} of ${groupDigits(n.closed)}`;
    return shareText(percentOf(n.forced, n.closed), n.forced);
  };
  /**
   * The week's every-channel figure as the row's second line, one sentence in sight and to a
   * screen reader alike; "under" is a word outside the figure, as in the shares.
   */
  const weekLine = (w: WeekRow) => {
    const n = w.network;
    if (n === null) return "No figure for all channels yet";
    if (n.closed < props.record.minimum)
      return (
        <>
          all <span class="num">{groupDigits(n.forced)}</span> of{" "}
          <span class="num">{groupDigits(n.closed)}</span> force or penalty
        </>
      );
    const text = shareText(percentOf(n.forced, n.closed), n.forced);
    return (
      <>
        all {text.startsWith("under ") ? "under " : ""}
        <span class="num">{text.replace(/^under /, "")}</span> force or penalty
      </>
    );
  };
  const columns = (): Column<WeekRow>[] => [
    {
      header: "Week of",
      // "Monday, UTC" would hold the column wider than a phone allows; the note under says it.
      sub: "UTC",
      cell: (w) => (
        <span class="ln-record__cell">
          <span>{w.time === null ? "Earlier" : formatDay(w.time)}</span>
          {/* Where the last column has no room, its figure is this row's second line. */}
          <span class="ln-record__second">{weekLine(w)}</span>
        </span>
      ),
    },
    ...kinds().map((k): Column<WeekRow> => {
      const column: Column<WeekRow> = {
        header: KIND_SHORT[k],
        numeric: true,
        cell: (w) => (w[k] === 0 ? <span class="muted">0</span> : groupDigits(w[k])),
      };
      // The one long kind's word, shorter where a phone has no room for it.
      if (k === "cooperative") column.short = "Co-op";
      return column;
    }),
    {
      header: "All channels",
      sub: "force or penalty",
      numeric: true,
      // On a phone, or where it does not fit, the figure is the row's second line instead.
      optional: true,
      cell: all,
    },
  ];
  return (
    <Fold
      title="Week by week"
      line={weeksInWords(props.record.node.weeks)}
      aside="Each from Monday, 00:00 UTC"
      class={`ln-record__weeks${dropped() > 0 ? " ln-record__part--dropped" : ""}`}
    >
      <DataTable
        caption="Its closes each week, newest first, beside every channel's"
        columns={columns()}
        rows={rows()}
        onDropped={setDropped}
      />
      <Show when={rows().some((w) => w.network === null)}>
        <p class="ln-record__note">
          {props.record.network === null
            ? "No figure for every channel yet: the server works them out every ten minutes, the first a moment after it starts."
            : "A dash: every channel's figures, worked out every ten minutes, do not reach that week yet."}
        </p>
      </Show>
    </Fold>
  );
}

function Peers(props: { record: NodeCloses }) {
  const [dropped, setDropped] = createSignal(0);
  const base = () => paths.lightningNode(props.record.id);
  const [all, setAll] = createSignal(false);
  const shown = () => peersShown(props.record.peers.list, all());
  const anyPenalty = () => props.record.peers.list.some((p) => p.penalty > 0);
  // A breach moves a close from force to penalty: the two together are the closes not mutual,
  // worked out from the counts (two rounded shares added can be a tenth off). Given where the
  // server gives the peer's shares, from the minimum of closes.
  const share = (p: RecordPeer) =>
    p.shares === null || p.closed === 0
      ? null
      : shareText(percentOf(p.force + p.penalty, p.closed), p.force + p.penalty);
  const columns = (): Column<RecordPeer>[] => [
    {
      header: "Peer",
      cell: (p) => (
        <span class="ln-node-row2">
          {/* To the closed list below, filtered to this peer: a node that left the graph has one too. */}
          <Link
            class="ln-node-peer"
            href={`${base()}?${new URLSearchParams({ view: "closed", peer: p.id }).toString()}`}
            noscroll
            title="Show only closes with this peer"
          >
            <Alias alias={p.alias} max={24} />
          </Link>
          <span class="ln-key" title={p.id}>
            {truncateMiddle(p.id, 6, 4)}
          </span>
          {/* Where the last column has no room, its figure is this row's third line. */}
          <span class="ln-record__second">
            <span class="num">{groupDigits(p.open)}</span> open now
          </span>
        </span>
      ),
    },
    { header: "Force", numeric: true, cell: (p) => groupDigits(p.force) },
    ...(anyPenalty()
      ? [
          {
            header: "Penalty",
            short: "Pen.",
            numeric: true,
            cell: (p: RecordPeer) => groupDigits(p.penalty),
          },
        ]
      : []),
    {
      // Over the closes this record read: on a capped record a peer may have older ones too.
      header: props.record.capped ? "Closes" : "All closes",
      short: "Closes",
      sub: props.record.capped ? "in this record" : "with it",
      numeric: true,
      cell: (p) => (
        <span class="ln-record__fee">
          <span>{groupDigits(p.closed)}</span>
          <Show when={share(p)}>
            {(s) => <span class="ln-record__all">{s()} force or penalty</span>}
          </Show>
        </span>
      ),
    },
    {
      header: "Open now",
      sub: "channels",
      numeric: true,
      // On a phone, or where it does not fit, the figure is under the peer instead.
      optional: true,
      cell: (p) => groupDigits(p.open),
    },
  ];
  return (
    <Fold
      title="With whom"
      always
      line={`${peersInWords(props.record)}${
        props.record.capped
          ? " These count the closes in this record, its newest; a peer may have older ones with it too."
          : ""
      }`}
      // All shown on a wide screen, the peers take the panel's width as cards (CSS, :has).
      class={`ln-record__peers${all() && shown().button !== null ? " ln-record__peers--all" : ""}${dropped() > 0 ? " ln-record__part--dropped" : ""}`}
    >
      <Show when={shown().rows.length > 0}>
        <DataTable
          caption="The other ends of its channels that ended in a force close or a penalty, most first"
          columns={columns()}
          rows={shown().rows}
          onDropped={setDropped}
        />
      </Show>
      <Show when={shown().button}>
        {(label) => (
          <div>
            <button
              class="btn"
              type="button"
              aria-expanded={all() ? "true" : "false"}
              onClick={() => setAll((a) => !a)}
            >
              {label()}
            </button>
          </div>
        )}
      </Show>
      <Show when={props.record.peers.more > 0}>
        <p class="ln-record__note">
          And {count(props.record.peers.more, "more peer")} with a force close or a penalty. Filter
          its closed channels below by peer to see them.
        </p>
      </Show>
    </Fold>
  );
}
