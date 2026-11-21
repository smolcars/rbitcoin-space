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
import { createRequest } from "../../lib/api";
import { groupDigits, MISSING, truncateMiddle } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import {
  type ByKind,
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
  perClose,
  type RecordPeer,
  RECORD_WORDS,
  shareText,
  type WeekRow,
  weekRows,
} from "./lightning";
import { Alias, ask, Tag } from "./parts";

/**
 * The record's section. `gone`: for a node the graph no longer holds, whose page has nothing else
 * to show; the section appears only once its record answers with a close, and never says it failed.
 */
export function CloseRecord(props: { network: Network; id: string; gone?: boolean }) {
  const [answer, { refetch }] = createRequest(
    () => props.id,
    (id, signal) => ask(props.network, `/nodes/${id}/closes`, isNodeCloses, signal),
  );
  const shown = () => !props.gone || (answer.latest?.node.closed ?? 0) > 0;
  return (
    <Show when={shown()}>
      <section aria-labelledby="ln-record-title" class="ln-record">
        <SectionHeader title="Close record" id="ln-record-title">
          <Show when={answer.latest} keyed>
            {(r) => <Span record={r} />}
          </Show>
        </SectionHeader>
        <Show
          when={answer.latest}
          keyed
          fallback={
            <Show
              when={answer.state === "errored"}
              fallback={<Loading label="Loading its close record" />}
            >
              <ErrorState
                title="Could not load its close record"
                error={answer.error}
                retry={() => refetch()}
              />
            </Show>
          }
        >
          {(r) => <Body record={r} gone={props.gone === true} />}
        </Show>
      </section>
    </Show>
  );
}

/** A kind as its icon and word, in the muted tone whatever the kind: a tally is not a warning. */
function Kind(props: { kind: CloseKind }) {
  return (
    <Tag icon={KIND_TAG[props.kind].icon} tone="muted">
      {KIND_SHORT[props.kind]}
    </Tag>
  );
}

/** A share in words with its bar, this node's or every channel's. */
function Share(props: { share: number; count: number; whose: "node" | "all" }) {
  return (
    <span class={`ln-record__share ln-record__share--${props.whose}`}>
      {/* Only the figure is a figure: "all under 0.1%" may part between its words. */}
      <span class="ln-record__words">
        {props.whose === "all" ? "all " : ""}
        {shareText(props.share, props.count).startsWith("under ") ? "under " : ""}
        <span class="num">{shareText(props.share, props.count).replace(/^under /, "")}</span>
      </span>
      <span class={`ln-record__bar ln-record__bar--${props.whose}`} aria-hidden="true">
        <span style={{ "--w": `${Math.min(100, props.share)}%` }} />
      </span>
    </span>
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

/** Peers listed before the reader asks for the rest. */
const PEERS_SHOWN = 10;

const sats = (n: number | null) => (n === null ? MISSING : groupDigits(n));

function Body(props: { record: NodeCloses; gone: boolean }) {
  const r = () => props.record;
  const net = () => r().network;
  const rated = () => r().node.shares !== null;
  const kinds = () => kindsIn(r().node, net());
  const span = () => (r().from === null ? null : days(r().time - (r().from ?? r().time)));
  const columns = (): Column<CloseKind>[] => [
    {
      header: "How it ended",
      cell: (k) => (
        <span class="ln-record__kind">
          <Kind kind={k} />
          <span class="ln-record__gloss">{RECORD_WORDS[k]}</span>
        </span>
      ),
    },
    { header: "Closes", numeric: true, cell: (k) => groupDigits(r().node[k]) },
    {
      header: rated() ? "Share" : "All channels",
      sub: rated() ? "this node, then all" : "share",
      cell: (k) => {
        const n = net();
        return (
          <span class="ln-record__shares">
            <Show when={r().node.shares}>
              {(sh) => <Share share={sh()[k]} count={r().node[k]} whose="node" />}
            </Show>
            {n === null ? (
              <span class="ln-record__all">{MISSING}</span>
            ) : n.shares === null ? (
              // Every channel's closes are too few for a share too: their count instead.
              <span class="ln-record__all">all {groupDigits(n[k])}</span>
            ) : (
              <Share share={n.shares[k]} count={n[k]} whose="all" />
            )}
          </span>
        );
      },
    },
  ];
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
              : `in the ${span() ?? ""} this server has watched.`}{" "}
            Each close is in the record of both nodes of its channel.
          </Show>
        </p>
      </Show>
      <Show when={r().node.closed > 0}>
        <DataTable
          caption="How its channels ended, beside every channel's as of the time above"
          columns={columns()}
          rows={kinds()}
        />
        <p class="ln-record__note">
          {rated()
            ? "A force close counts for both of its channel's nodes: the chain shows that one end broadcast a commitment transaction, not which end or why."
            : `Shares are given from ${groupDigits(r().minimum)} closes; with ${groupDigits(r().node.closed)}, the counts say more than a share would. A force close counts for both of its channel's nodes: the chain does not say which end broadcast its commitment transaction.`}
        </p>
        <Fees record={r()} />
        <Weeks record={r()} />
        <Peers record={r()} gone={props.gone} />
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

function Fees(props: { record: NodeCloses }) {
  const r = () => props.record;
  const kinds = () => kindsIn(r().node);
  const columns = (): Column<CloseKind>[] => [
    { header: "Closing transactions", cell: (k) => <Kind kind={k} /> },
    {
      // In all, and a close's mean under it: one column, so the table fits a phone.
      header: "In all",
      sub: "sats",
      numeric: true,
      cell: (k) => (
        <span class="ln-record__fee">
          {/* Two figures, spoken apart: read as one they make one large number. */}
          <span class="visually-hidden">
            {r().node.fees[k].known === 0
              ? "No fee known."
              : `${groupDigits(r().node.fees[k].sum)} sats in all. ${sats(perClose(r().node.fees[k]))} sats a close.`}
          </span>
          <span aria-hidden="true">
            {r().node.fees[k].known === 0 ? MISSING : groupDigits(r().node.fees[k].sum)}
          </span>
          <span class="ln-record__all" aria-hidden="true">
            <span class="num">{sats(perClose(r().node.fees[k]))}</span> a{"\u00A0"}close
          </span>
        </span>
      ),
    },
    {
      header: "All channels",
      sub: "a close, sats",
      numeric: true,
      cell: (k) => {
        const n = r().network;
        return n === null ? MISSING : sats(perClose(n.fees[k]));
      },
    },
  ];
  const unknown = () => kinds().reduce((a, k) => a + r().node[k] - r().node.fees[k].known, 0);
  return (
    <div class="ln-record__part">
      <h3 class="ln-record__h">Closing fees</h3>
      <DataTable
        caption="The fees of its channels' closing transactions, beside every channel's"
        columns={columns()}
        rows={kinds()}
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
  const columns = (): Column<WeekRow>[] => [
    {
      header: "Week of",
      // "Monday, UTC" would hold the column wider than a phone allows; the note under says it.
      sub: "UTC",
      cell: (w) => (w.time === null ? "Earlier" : formatDay(w.time)),
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
      // Left out on a phone, which says so under the table.
      optional: true,
      cell: (w) => {
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
      },
    },
  ];
  return (
    <div class="ln-record__part">
      <h3 class="ln-record__h">Week by week</h3>
      <DataTable
        caption="Its closes each week, newest first, beside every channel's"
        columns={columns()}
        rows={rows()}
        onDropped={setDropped}
      />
      <p class="ln-record__note">Each week runs from Monday, 00:00 UTC.</p>
      {/* Shown where the column is hidden: by a phone's breakpoint, or dropped to fit. */}
      <p
        class={`ln-record__note ln-record__phone${dropped() > 0 ? " ln-record__phone--dropped" : ""}`}
      >
        To fit the screen this table leaves out every channel's figure each week; a wider screen
        shows it.
      </p>
      <Show when={rows().some((w) => w.network === null)}>
        <p class="ln-record__note">
          {props.record.network === null
            ? "No figure for every channel yet: the server works them out every ten minutes, the first a moment after it starts."
            : "A dash: every channel's figures, worked out every ten minutes, do not reach that week yet."}
        </p>
      </Show>
    </div>
  );
}

function Peers(props: { record: NodeCloses; gone: boolean }) {
  const [dropped, setDropped] = createSignal(0);
  const base = () => paths.lightningNode(props.record.id);
  const [all, setAll] = createSignal(false);
  const shown = () =>
    all() ? props.record.peers.list : props.record.peers.list.slice(0, PEERS_SHOWN);
  const hidden = () => props.record.peers.list.length - shown().length;
  const anyPenalty = () => props.record.peers.list.some((p) => p.penalty > 0);
  const share = (p: RecordPeer, k: keyof ByKind) =>
    p.shares === null ? null : shareText(p.shares[k], p[k]);
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
        </span>
      ),
    },
    { header: "Force", numeric: true, cell: (p) => groupDigits(p.force) },
    ...(anyPenalty()
      ? [{ header: "Penalty", numeric: true, cell: (p: RecordPeer) => groupDigits(p.penalty) }]
      : []),
    {
      // Over the closes this record read: on a capped record a peer may have older ones too.
      header: props.record.capped ? "Closes" : "All closes",
      sub: props.record.capped ? "with it, in this record" : "with this peer",
      numeric: true,
      cell: (p) => (
        <span class="ln-record__fee">
          <span>{groupDigits(p.closed)}</span>
          <Show when={share(p, "force")}>
            {(s) => <span class="ln-record__all">{s()} force</span>}
          </Show>
        </span>
      ),
    },
    {
      header: "Open now",
      sub: "channels",
      numeric: true,
      // Left out on a phone, which says so under the table.
      optional: true,
      cell: (p) => groupDigits(p.open),
    },
  ];
  return (
    <div class="ln-record__part">
      <h3 class="ln-record__h">With whom</h3>
      <p class="ln-record__lead">
        {peersInWords(props.record)}
        {props.record.capped
          ? " These count the closes in this record, its newest; a peer may have older ones with it too."
          : ""}
      </p>
      <Show when={props.record.peers.list.length > 0}>
        <DataTable
          caption="The other ends of its channels that ended in a force close or a penalty, most first"
          columns={columns()}
          rows={shown()}
          onDropped={setDropped}
        />
        {/* Shown where the column is hidden: by a phone's breakpoint, or dropped to fit. */}
        <p
          class={`ln-record__note ln-record__phone${dropped() > 0 ? " ln-record__phone--dropped" : ""}`}
        >
          To fit the screen this table leaves out how many channels with each peer are open now; a
          wider screen shows it.
        </p>
        <Show when={hidden() > 0}>
          <div>
            <button class="btn" type="button" onClick={() => setAll(true)}>
              Show the other {count(hidden(), "peer")}
            </button>
          </div>
        </Show>
        <Show when={props.record.peers.more > 0}>
          <p class="ln-record__note">
            And {count(props.record.peers.more, "more peer")} with a force close or a penalty.
            {props.gone ? "" : " Filter its closed channels below by peer to see them."}
          </p>
        </Show>
      </Show>
    </div>
  );
}
