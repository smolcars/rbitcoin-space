// A node's close record (docs/FRONTEND.md "Lightning pages"): how its channels this server watched
// ended, beside every channel's as last worked out, by week, and with whom. A record, not a
// verdict: kinds keep their icon and word in the muted tone, and a force close is never the node's.
import { createSignal, For, Show } from "solid-js";
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
  perClose,
  type RecordPeer,
  RECORD_WORDS,
  recordInWords,
  shareText,
  type WeekRow,
  weekRows,
} from "./lightning";
import { Alias, ask, Tag } from "./parts";

/** Asks for a node's record: its own request, so a page that needs the answer first can hold it. */
export const askRecord = (network: Network, id: () => string): ApiRequest<NodeCloses> =>
  createRequest(id, (key, signal) => ask(network, `/nodes/${key}/closes`, isNodeCloses, signal));

/** The record of a node the graph holds, from its own request. */
export function CloseRecord(props: { network: Network; id: string }) {
  // Made once, here: a JSX prop is a getter, so a request made inside it is made on every read.
  const request = askRecord(props.network, () => props.id);
  return <RecordSection request={request} gone={false} />;
}

/**
 * The record's section. `gone`: for a node the graph no longer holds, whose page shows it only once
 * its record answers with a close; there its peers lead to their own pages.
 */
export function RecordSection(props: { request: ApiRequest<NodeCloses>; gone: boolean }) {
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
        {(r) => <Body record={r} gone={props.gone} />}
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

/** Said once, where a reader meets the first force figure. */
const BOTH_ENDS =
  "A force close is in the record of both of its channel's nodes: the chain does not say which end broadcast it.";

function Body(props: { record: NodeCloses; gone: boolean }) {
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
            <strong class="num">{count(r().node.closed, "channel")}</strong> closed{" "}
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
                <Breakdown record={r()} gone={props.gone} />
              </details>
            </>
          }
        >
          <Breakdown record={r()} gone={props.gone} />
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

/** The tables: how it ended across the panel, fees and weeks side by side, then with whom. */
function Breakdown(props: { record: NodeCloses; gone: boolean }) {
  return (
    <div class="ln-record__grid">
      <Ended record={props.record} />
      <Fees record={props.record} />
      <Weeks record={props.record} />
      <Peers record={props.record} gone={props.gone} />
    </div>
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
      header: rated() ? "Share" : "All channels",
      // Under every channel's minimum too, their column holds counts, and says so.
      sub: rated() ? "this node, then all" : net()?.shares === null ? "closes" : "share",
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
              <span class="ln-record__all">{groupDigits(n[k])}</span>
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
    <div class="ln-record__part ln-record__part--wide">
      <DataTable
        caption="How its channels ended, beside every channel's as of the time above"
        columns={columns()}
        rows={kinds()}
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
            All channels: <span class="num">{all(k)}</span> sats a close
          </span>
        </span>
      ),
    },
    {
      // In all, and a close's mean under it: one column, so the table fits a phone.
      header: "In all",
      sub: "sats",
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
      cell: all,
    },
  ];
  const unknown = () => kinds().reduce((a, k) => a + r().node[k] - r().node.fees[k].known, 0);
  return (
    <div class={`ln-record__part${dropped() > 0 ? " ln-record__part--dropped" : ""}`}>
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
    return shareText((n.forced * 100) / n.closed, n.forced);
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
          <span class="ln-record__second">
            all <span class="num">{all(w)}</span> force or penalty
          </span>
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
    <div class={`ln-record__part${dropped() > 0 ? " ln-record__part--dropped" : ""}`}>
      <h3 class="ln-record__h">Week by week</h3>
      <DataTable
        caption="Its closes each week, newest first, beside every channel's"
        columns={columns()}
        rows={rows()}
        onDropped={setDropped}
      />
      <p class="ln-record__note">
        Each week runs from Monday, 00:00 UTC.
        <Show when={rows().some((w) => w.network === null)}>
          {props.record.network === null
            ? " No figure for every channel yet: the server works them out every ten minutes, the first a moment after it starts."
            : " A dash: every channel's figures, worked out every ten minutes, do not reach that week yet."}
        </Show>
      </p>
    </div>
  );
}

function Peers(props: { record: NodeCloses; gone: boolean }) {
  const [dropped, setDropped] = createSignal(0);
  const base = () => paths.lightningNode(props.record.id);
  const [all, setAll] = createSignal(false);
  const shown = () => peersShown(props.record.peers.list, all());
  const anyPenalty = () => props.record.peers.list.some((p) => p.penalty > 0);
  const share = (p: RecordPeer) => (p.shares === null ? null : shareText(p.shares.force, p.force));
  const columns = (): Column<RecordPeer>[] => [
    {
      header: "Peer",
      cell: (p) => (
        <span class="ln-node-row2">
          {/* A node the graph no longer holds has no closed list to filter: its peers lead to
              their own pages, or are text where they have left too. */}
          <Show
            when={!props.gone}
            fallback={
              <Show when={p.held} fallback={<Alias alias={p.alias} max={24} />}>
                <Link class="ln-node-peer" href={paths.lightningNode(p.id)}>
                  <Alias alias={p.alias} max={24} />
                </Link>
              </Show>
            }
          >
            <Link
              class="ln-node-peer"
              href={`${base()}?view=closed&peer=${p.id}`}
              noscroll
              title="Show only closes with this peer"
            >
              <Alias alias={p.alias} max={24} />
            </Link>
          </Show>
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
          <Show when={share(p)}>{(s) => <span class="ln-record__all">{s()} force</span>}</Show>
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
    <div
      class={`ln-record__part ln-record__part--wide${dropped() > 0 ? " ln-record__part--dropped" : ""}`}
    >
      <h3 class="ln-record__h">With whom</h3>
      <p class="ln-record__lead">
        {peersInWords(props.record)}
        {props.record.capped
          ? " These count the closes in this record, its newest; a peer may have older ones with it too."
          : ""}
      </p>
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
          And {count(props.record.peers.more, "more peer")} with a force close or a penalty.
          {props.gone ? "" : " Filter its closed channels below by peer to see them."}
        </p>
      </Show>
    </div>
  );
}
