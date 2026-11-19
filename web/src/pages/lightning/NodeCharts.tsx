// A node's past (its channels and capacity since this server's record began, stepping at each
// open and close) and how it prices its channels, out and in (docs/DESIGN.md "Lightning").
import {
  createSignal,
  For,
  lazy,
  Loading as Pending,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { type ApiResource, createRequest } from "../../lib/api";
import { Amount } from "../../components/Amount";
import { formatDay, formatMoment } from "../../components/chart/scale";
import "../../components/chart/Chart.css";
import { type Column, DataTable } from "../../components/DataTable";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../components/States";
import { formatBtcShort, groupDigits } from "../../lib/format";
import { Link } from "../../components/Link";
import { type Network, paths } from "../../lib/network";
import { TimeAgo } from "../../components/Time";
import {
  btcAxis,
  changeShown,
  FEE_HISTORY,
  feesMoved,
  count,
  feeRows,
  type FeeFigures as Figures,
  type FeeChange,
  type FeeRow,
  type Fees,
  inboundOf,
  isFeeChanges,
  MOVED_FITS,
  movedText,
  type NodeDetail,
  type NodeHistory as HistoryAnswer,
} from "./lightning";

import { Alias, ask, ChannelId, InboundFig, MsatFig } from "./parts";

const Chart = lazy(() => import("../../components/chart/Chart"));

const DAY = 86_400;

/** Its past, from the page's one request for it (the glance reads its week from it too). */
export function NodeHistory(props: { history: ApiResource<HistoryAnswer>; retry: () => void }) {
  onSettled(() => void Chart.preload());
  const points = () => props.history.latest?.points ?? [];
  // From zero, so a node's size reads at a glance; whole numbers for a node with a few channels.
  const channelAxis = () =>
    Math.max(...points().map((p) => p.channels)) <= 4
      ? { domain: [0, 4] as const, format: groupDigits }
      : { zero: true, format: groupDigits };
  const col = (f: (p: { channels: number; capacity: number }) => number) =>
    points().map((p) => f(p));
  return (
    <section aria-labelledby="ln-node-history-title">
      <SectionHeader title="Over time" id="ln-node-history-title">
        Each change and midnight UTC
      </SectionHeader>
      <Show
        when={props.history.state !== "errored"}
        fallback={
          <ErrorState
            title="Could not load its history"
            error={props.history.error}
            retry={() => props.retry()}
          />
        }
      >
        <Show
          when={props.history.latest}
          fallback={
            <div class="ln-chart ln-chart--node">
              <Loading label="Loading its history" />
            </div>
          }
        >
          {(h) => (
            <Show
              when={h().from !== null && points().length > 1}
              fallback={
                <Empty title="Nothing to draw yet">
                  {h().from === null
                    ? "This server's history starts when its Lightning peer first syncs and stores the network's size. A node's past is drawn from then on, a point each midnight UTC."
                    : `This server's record begins ${formatMoment(h().from ?? 0)}. A node's past is drawn from the first midnight UTC after that.`}
                </Empty>
              }
            >
              {/* Our record of closes starts with the server: before it, a zero would be a guess. */}
              <p class="ln-coverage">Recorded since {formatMoment(h().from ?? 0)}.</p>
              <div class="ln-chart ln-chart--node">
                <Pending>
                  <Chart
                    label="This node's channels and capacity, since this server's record began"
                    x={points().map((p) => p.time)}
                    gap={DAY}
                    height={200}
                    left={channelAxis()}
                    right={{ zero: true, format: btcAxis }}
                    // Steps: a channel opens or closes in a block, at a moment the record has, and
                    // the count holds until the next change. A slope would invent the time between.
                    series={[
                      {
                        name: "Channels",
                        values: col((p) => p.channels),
                        draw: "step-area",
                        format: groupDigits,
                      },
                      {
                        name: "Capacity",
                        values: col((p) => p.capacity),
                        draw: "step",
                        axis: "right",
                        tone: 2,
                        // In magnitude, as the glance and header read it: whole at any size.
                        format: formatBtcShort,
                        unit: "BTC",
                        rawUnit: "sat",
                      },
                    ]}
                    // Midnights are days; a change and the last point (now) are moments.
                    time={(t) => (t % DAY === 0 ? formatDay(t) : formatMoment(t))}
                  />
                </Pending>
              </div>
            </Show>
          )}
        </Show>
      </Show>
    </section>
  );
}

export function NodeFees(props: { node: NodeDetail }) {
  const rows = () => feeRows(props.node.fees);
  const [figures, setFigures] = createSignal(false);
  // One scale for both ways, so a bar out and a bar in compare by length.
  const most = () => Math.max(1, ...rows().flatMap((r) => [r.outgoing.count, r.incoming.count]));
  // One table each way, under the chart's own words: three columns fit a 320 px phone whole, where
  // five scrolled, and the capacities are only here.
  const columns = (way: "outgoing" | "incoming"): Column<FeeRow>[] => [
    { header: "Fee rate, ppm", cell: (r) => r.label },
    { header: "Channels", numeric: true, cell: (r) => groupDigits(r[way].count) },
    {
      header: "Their capacity, BTC",
      short: "Capacity, BTC",
      numeric: true,
      cell: (r) => <Amount sats={r[way].capacity} unit={false} short />,
    },
  ];
  return (
    <section aria-labelledby="ln-node-fees-title">
      <SectionHeader title="Fee rates" id="ln-node-fees-title">
        Channels by rate, ppm
      </SectionHeader>
      <Show
        when={rows().length > 0}
        fallback={<Empty title="No fee to show">It has no open channel this server knows.</Empty>}
      >
        <figure class="ln-fees">
          <div class="ln-fees__plot">
            <span class="ln-fees__unit" aria-hidden="true">
              ppm
            </span>
            {/* The key heads the bars, in their order: stacked on a phone, side by side if wide. */}
            <span class="ln-fees__bars ln-fees__key" aria-hidden="true">
              <span class="ln-fees__way ln-fees__way--out">It charges</span>
              <span class="ln-fees__way ln-fees__way--in">Its peers charge</span>
            </span>
            <For each={rows()}>
              {(r) => (
                <>
                  <span class="ln-fees__label num" aria-hidden="true">
                    {r.label}
                  </span>
                  <span class="ln-fees__bars">
                    <For each={WAYS}>
                      {(w) => (
                        <Show
                          when={r[w.key].count > 0}
                          fallback={<span class={`ln-fees__bar ln-fees__bar--${w.way}`} />}
                        >
                          {/* A bar lists its channels: the Channels view, filtered to it. */}
                          <Link
                            class={`ln-fees__bar ln-fees__bar--${w.way} ln-fees__go`}
                            href={`${paths.lightningNode(props.node.id)}?fee=${w.way}:${r.from ?? "none"}`}
                            aria-label={barName(w.way, r, r[w.key].count)}
                          >
                            <Count n={r[w.key].count} most={most()} />
                          </Link>
                        </Show>
                      )}
                    </For>
                  </span>
                </>
              )}
            </For>
          </div>
          <figcaption class="chart__caption">
            <details class="chart__figures" onToggle={(e) => setFigures(e.currentTarget.open)}>
              <summary>Show the figures</summary>
              <Show when={figures()}>
                <div
                  class="chart__table ln-fees__figures"
                  // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region must take focus to be scrolled by keyboard
                  tabindex="0"
                  role="region"
                  aria-label="Its channels by fee rate, figures"
                >
                  <div class="ln-fees__table ln-fees__table--out">
                    <DataTable
                      caption="It charges"
                      showCaption
                      columns={columns("outgoing")}
                      rows={rows()}
                    />
                  </div>
                  <div class="ln-fees__table ln-fees__table--in">
                    <DataTable
                      caption="Its peers charge"
                      showCaption
                      columns={columns("incoming")}
                      rows={rows()}
                    />
                  </div>
                </div>
              </Show>
            </details>
          </figcaption>
        </figure>
        <More>
          <p>
            A channel has a fee rate each way: what this node charges to forward a payment out over
            it, and what the peer at the other end charges to send one towards it. A rate is in
            parts per million of the amount forwarded: 1 000 ppm is 0.1%. Each bar counts channels;
            the figures give their capacity too. "No policy" counts the ends that have announced no
            fee, or whose announcement is over two weeks old. The fixed fee per payment (base fee)
            is not included.
          </p>
        </More>
      </Show>
    </section>
  );
}

const WAYS = [
  { way: "out", key: "outgoing" },
  { way: "in", key: "incoming" },
] as const;

/** A bar's name as a link: what it counts and which way. */
function barName(way: "out" | "in", r: FeeRow, n: number): string {
  const channels = count(n, "channel");
  if (r.from === null)
    return way === "out"
      ? `${channels} where it has set no fee`
      : `${channels} where its peer has set no fee`;
  return `${channels} where ${way === "out" ? "it charges" : "its peer charges"} ${r.label} ppm`;
}

const RATE_ROWS = [
  { label: "Median", get: (f: Figures) => f.median },
  { label: "Average, by capacity", get: (f: Figures) => f.weighted },
  { label: "Lowest", get: (f: Figures) => f.lowest },
  { label: "Highest", get: (f: Figures) => f.highest },
] as const;

/** Its fee rates in four figures each way, and how what it charges compares with its peers. */
export function FeeFigures(props: { node: NodeDetail }) {
  const out = () => props.node.figures.fee_rates.outgoing;
  const inn = () => props.node.figures.fee_rates.incoming;
  const figure = (f: Figures | null, get: (f: Figures) => number | null) => {
    const v = f === null ? null : get(f);
    return v === null ? "–" : groupDigits(v);
  };
  const ratio = () => {
    const o = out()?.median ?? null;
    const i = inn()?.median ?? null;
    return o === null || i === null || i === 0 ? null : o / i;
  };
  return (
    <section aria-labelledby="ln-node-figures-title">
      <SectionHeader title="In figures" id="ln-node-figures-title">
        ppm
      </SectionHeader>
      <DataTable
        caption="Its fee rates, what it charges and what its peers charge, ppm"
        columns={[
          { header: "Fee rate, ppm", cell: (r) => r.label },
          { header: "It charges", numeric: true, cell: (r) => figure(out(), r.get) },
          { header: "Its peers charge", numeric: true, cell: (r) => figure(inn(), r.get) },
        ]}
        rows={RATE_ROWS}
      />
      <Show when={ratio()}>
        {(x) => (
          <p class="ln-node-ratio">
            Charges <strong class="num">{x() >= 10 ? groupDigits(x()) : x().toFixed(1)}×</strong>{" "}
            its peers, by median
          </p>
        )}
      </Show>
    </section>
  );
}

/** One bar and its count; nothing for none, so a row shows only what it holds. */
function Count(props: { n: number; most: number }) {
  return (
    <Show when={props.n > 0}>
      <span class="ln-fees__fill" style={{ "--w": String(props.n / props.most) }} />
      <span class="ln-fees__n num">{groupDigits(props.n)}</span>
    </Show>
  );
}

/** What a change's row names when the rate held: the fee that moved. */
const MOVED = { rate: "", base: "base fee", inbound: "inbound fee" } as const;

/** Whose fee moved, and which fee when it was not the rate: `this node`, `the peer, base fee`. */
const whose = (c: FeeChange) => {
  const what = MOVED[changeShown(c)];
  const who = c.whose === "own" ? "this node" : "the peer";
  return what === "" ? who : `${who}, ${what}`;
};

/** One side of a change, as the row shows it: the rate bare (the header's ppm), another fee whole. */
function Moved(props: { c: FeeChange; fees: Fees }) {
  return (
    <Switch>
      <Match when={changeShown(props.c) === "base"}>
        <MsatFig msat={props.fees.base_fee_msat} />
      </Match>
      <Match when={changeShown(props.c) === "inbound"}>
        <Show when={inboundOf(props.fees)} fallback="none">
          {(f) => <InboundFig fee={f()} />}
        </Show>
      </Match>
      {/* Its own figure, so a line breaks beside it, never inside it. */}
      <Match when={true}>
        <span class="num">{groupDigits(props.fees.fee_rate)}</span>
      </Match>
    </Switch>
  );
}

const CHANGE_COLUMNS: Column<FeeChange>[] = [
  {
    header: "Channel and peer",
    cell: (c) => (
      <span class="ln-node-row2 ln-recent__who">
        <span class="ln-node-row2__line">
          <Link class="ln-id num" href={`${paths.lightningChannel(c.id)}#${FEE_HISTORY}`}>
            <ChannelId id={c.id} />
          </Link>
          {/* A phone drops the Whose and When columns; both stay in this cell. */}
          <span class="ln-recent__sub ln-recent__phone">{whose(c)}</span>
        </span>
        {/* Where a figure is too long for the From and To columns on a phone, they go here. */}
        <span class="ln-node-row2__line ln-recent__fromto">
          <Moved c={c} fees={c.before} /> → <Moved c={c} fees={c.after} />
        </span>
        <span class="ln-node-row2__line ln-recent__ends">
          {/* Text, not a link: the row opens the channel, which links its peer; two links in one
              row would leave neither a thumb's target. */}
          <span class="ln-recent__sub">
            <Alias alias={c.peer.alias} max={18} />
          </span>
          <span class="ln-recent__sub ln-recent__phone">
            <TimeAgo time={c.time} />
          </span>
        </span>
      </span>
    ),
  },
  {
    header: "Whose",
    optional: true,
    cell: (c) => `${whose(c)[0]?.toUpperCase() ?? ""}${whose(c).slice(1)}`,
  },
  { header: "From", numeric: true, cell: (c) => <Moved c={c} fees={c.before} /> },
  { header: "To", numeric: true, cell: (c) => <Moved c={c} fees={c.after} /> },
  { header: "When", numeric: true, optional: true, cell: (c) => <TimeAgo time={c.time} /> },
];

/** The newest fee changes on its channels, either end's: asked for only when the Fees view opens. */
export function RecentChanges(props: { node: NodeDetail; network: Network }) {
  const [changes, { refetch }] = createRequest(
    () => props.node.id,
    (id, signal) => ask(props.network, `/nodes/${id}/fees`, isFeeChanges, signal),
  );
  // The server keeps an inbound fee going from none to zero as a change: it charges the same.
  const moved = (a: { changes: FeeChange[] }) =>
    a.changes.filter((c) => feesMoved(c.before, c.after));
  return (
    <section aria-labelledby="ln-recent-title" class="ln-recent">
      <SectionHeader title="Recent fee changes" id="ln-recent-title">
        ppm
      </SectionHeader>
      <Switch>
        <Match when={changes.latest}>
          {(a) => (
            <div
              class={[
                "ln-recent__table",
                {
                  "ln-recent--long": moved(a()).some((c) =>
                    [c.before, c.after].some((f) => movedText(c, f).length > MOVED_FITS),
                  ),
                },
              ]}
            >
              <DataTable
                caption="The latest fee changes on its channels, newest first"
                columns={CHANGE_COLUMNS}
                rows={moved(a())}
                rowHref={(c) => `${paths.lightningChannel(c.id)}#${FEE_HISTORY}`}
                empty={<Empty title="No change kept" />}
              />
            </div>
          )}
        </Match>
        <Match when={changes.state === "errored"}>
          <ErrorState
            title="Could not load its fee changes"
            error={changes.error}
            retry={refetch}
          />
        </Match>
        <Match when={true}>
          <Loading label="Loading its fee changes" />
        </Match>
      </Switch>
    </section>
  );
}
