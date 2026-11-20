// A node's close record (docs/FRONTEND.md "Lightning pages"): how its channels this server watched
// ended, beside every channel's over the same span, by week, and with whom. A record, not a
// verdict: kinds keep their icon and word in the muted tone, and a force close is never the node's.
import { createSignal, For, Show } from "solid-js";
import { formatDay } from "../../components/chart/scale";
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
          <Show when={answer.latest?.from}>{(f) => <>Since {formatDay(f())}</>}</Show>
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
          {(r) => <Body record={r} network={props.network} />}
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
      <span class="num">
        {props.whose === "all" ? "all " : ""}
        {shareText(props.share, props.count)}
      </span>
      <span class={`ln-record__bar ln-record__bar--${props.whose}`} aria-hidden="true">
        <span style={{ "--w": `${Math.min(100, props.share)}%` }} />
      </span>
    </span>
  );
}

/** Peers listed before the reader asks for the rest. */
const PEERS_SHOWN = 10;

const sats = (n: number | null) => (n === null ? MISSING : groupDigits(n));

function Body(props: { record: NodeCloses; network: Network }) {
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
            <strong class="num">{count(r().node.closed, "channel")}</strong> closed in the {span()}{" "}
            this server has watched. Each close is in the record of both nodes of its channel.
          </Show>
        </p>
      </Show>
      <Show when={r().node.closed > 0}>
        <DataTable
          caption="How its channels ended, beside every channel's over the same span"
          columns={columns()}
          rows={kinds()}
        />
        <p class="ln-record__note">
          {rated()
            ? "A force close counts for both of its channel's nodes: the chain shows that one end broadcast its commitment, not which end or why."
            : `Shares are given from ${groupDigits(r().minimum)} closes; with ${groupDigits(r().node.closed)}, the counts say more than a share would. A force close counts for both of its channel's nodes: the chain does not say which end broadcast it.`}
        </p>
        <Fees record={r()} />
        <Weeks record={r()} />
        <Peers record={r()} network={props.network} />
      </Show>
      <More label="How this record is made">
        <p>
          It counts the announced channels of this node that this server saw close, each once, in
          the kind its closing transaction shows, from{" "}
          {r().from === null ? "when this server's record starts" : formatDay(r().from ?? 0)}.
          Channels that closed before then, private channels, and a channel the server stopped
          watching are not in it. "All channels" is every close the server saw in the same span.
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
          A penalty is seen only when its sweep confirms within 2,016 blocks of the force close; the
          record holds the sweep, not which end broadcast the revoked state. Fees are those of the
          closing transactions: the chain does not say which end paid them, a force close's leaves
          out what was spent later to speed it or sweep its outputs, and an "other" close's covers
          every input of its transaction. What opening the channels cost is not shown: the server
          does not hold the funding transactions' fees, and one funding transaction can open several
          channels.
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
      header: "In all",
      sub: "sats",
      numeric: true,
      cell: (k) => (r().node.fees[k].known === 0 ? MISSING : groupDigits(r().node.fees[k].sum)),
    },
    {
      header: "A close",
      sub: "sats, mean",
      numeric: true,
      cell: (k) => sats(perClose(r().node.fees[k])),
    },
    {
      header: "All channels",
      sub: "sats, mean",
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
  const rows = () => weekRows(props.record.node.weeks, props.record.network?.weeks ?? null);
  const kinds = () => kindsIn(props.record.node);
  const columns = (): Column<WeekRow>[] => [
    {
      header: "Week of",
      sub: "Monday, UTC",
      cell: (w) => (w.time === null ? "Earlier" : formatDay(w.time)),
    },
    ...kinds().map((k): Column<WeekRow> => ({
      header: KIND_SHORT[k],
      numeric: true,
      cell: (w) => (w[k] === 0 ? <span class="muted">0</span> : groupDigits(w[k])),
    })),
    {
      header: "All channels",
      sub: "force or penalty",
      numeric: true,
      drop: 1,
      cell: (w) => {
        const n = w.network;
        if (n === null) return MISSING;
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
      />
    </div>
  );
}

function Peers(props: { record: NodeCloses; network: Network }) {
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
          <Link
            class="ln-node-peer"
            href={`${base()}?view=closed&peer=${p.id}`}
            noscroll
            title="Show only closes with this peer"
          >
            <Alias alias={p.alias} max={24} />
          </Link>
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
      header: "All closes",
      sub: "with this peer",
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
      drop: 1,
      cell: (p) => groupDigits(p.open),
    },
  ];
  return (
    <div class="ln-record__part">
      <h3 class="ln-record__h">With whom</h3>
      <p class="ln-record__lead">{peersInWords(props.record)}</p>
      <Show when={props.record.peers.list.length > 0}>
        <DataTable
          caption="The peers its force closes and penalties were with, most first"
          columns={columns()}
          rows={shown()}
        />
        <Show when={hidden() > 0}>
          <div>
            <button class="btn" type="button" onClick={() => setAll(true)}>
              Show the other {count(hidden(), "peer")}
            </button>
          </div>
        </Show>
        <Show when={props.record.peers.more > 0}>
          <p class="ln-record__note">
            And {count(props.record.peers.more, "more peer")} with fewer: filter its closed channels
            below by peer to see them.
          </p>
        </Show>
      </Show>
    </div>
  );
}
