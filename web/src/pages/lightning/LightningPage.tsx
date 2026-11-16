// The Lightning network for its operators: the totals and their change over a period, what happens
// as it happens, the period's movers, closes by kind, the network over time and its largest nodes
// (docs/DESIGN.md "Lightning", docs/FRONTEND.md "Lightning pages").
import { useLocation, useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  Loading as Pending,
  onSettled,
  Show,
} from "solid-js";
import { Amount } from "../../components/Amount";
import { sorted } from "../../components/chart/geometry";
import { formatDay, formatMoment } from "../../components/chart/scale";
import { type Column, DataTable } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { Periods } from "../../components/Periods";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../components/States";
import { type ApiRequest, createRequest } from "../../lib/api";
import { formatBtcShort, formatUtc, groupDigits } from "../../lib/format";
import { useNow } from "../../lib/clock";
import { type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import {
  type Closes,
  type DayCloses,
  drawnDays,
  isCloses,
  isMovers,
  type Mover,
  type Movers,
  moversFor,
} from "./feed";
import {
  ageShort,
  type Before,
  btcAxis,
  changeWords,
  CLOSE_KINDS,
  coverageSentence,
  dataFrom,
  INTERVALS,
  type Interval,
  isOverview,
  isSeries,
  KIND_SHORT,
  msat,
  plus,
  ppm,
  type RankedNode,
  type Series,
  type Stats,
} from "./lightning";
import { LiveFeed } from "./LiveFeed";
import {
  ask,
  closesInWords,
  Gate,
  LightningNav,
  NodeName,
  nodeColumns,
  rememberList,
  Stat,
  VERIFIED_NOTE,
} from "./parts";

const Chart = lazy(() => import("../../components/chart/Chart"));

/** Rows in each top list: a preview; the rankings hold the rest. */
const PREVIEW = 5;
/** The periods the page's figures, movers and chart share. */
const PERIODS = [INTERVALS[0], INTERVALS[1], INTERVALS[2]] as const;
type Period = (typeof PERIODS)[number];
/** Days of closes drawn. */
const CLOSE_DAYS = 30;

const JUMPS = [
  { id: "ln-now-title", label: "Now" },
  { id: "ln-feed-title", label: "As it happens" },
  { id: "ln-movers-title", label: "Movers" },
  { id: "ln-closes-title", label: "Closes" },
  { id: "ln-history-title", label: "Over time" },
  { id: "ln-top-capacity-title", label: "Top nodes" },
];

export default function LightningPage() {
  usePageTitle(() => "Lightning");
  const network = useNetwork();
  return (
    <div class="wrap ln">
      <LightningNav here="overview" />
      <header class="ln-head">
        <h1>Lightning</h1>
      </header>
      {/* Everything belongs to one network: switching networks starts it afresh. */}
      <Show when={network()} keyed>
        {(n) => (
          <Gate>
            <Overview network={n} />
          </Gate>
        )}
      </Show>
    </div>
  );
}

function Overview(props: { network: Network }) {
  rememberList(paths.lightning(), "Lightning overview");
  const [search] = useSearchParams();
  const period = createMemo(
    (): Period => PERIODS.find((p) => p.id === search["interval"]) ?? PERIODS[1],
  );
  const overviewRequest = createRequest(
    () => props.network,
    (n, signal) => ask(n, "/overview", isOverview, signal),
  );
  const [overview, { refetch }] = overviewRequest;
  // The chart's series; its first record also says from when the closes are known.
  const series = createRequest(
    () => period().id,
    (id, signal) => ask(props.network, `/statistics/${id}`, isSeries, signal),
  );
  const movers = createRequest(
    () => period().id,
    (id, signal) => ask(props.network, `/movers?period=${id}`, isMovers, signal),
  );
  const closes = createRequest(
    () => props.network,
    (n, signal) => ask(n, `/closes?days=${CLOSE_DAYS}`, isCloses, signal),
  );
  onSettled(() => void Chart.preload());
  // "History" in the section's links lands on the chart: once the sections above it have answered,
  // so they do not push it out of view after the jump (the feed's box holds its height).
  const location = useLocation();
  const settled = (r: ApiRequest<unknown>) => r[0].latest !== undefined || r[0].state === "errored";
  createEffect(
    () => [location.hash, settled(overviewRequest) && settled(movers) && settled(closes)] as const,
    ([hash, ready]) => {
      if (hash === "#history" && ready) document.getElementById("history")?.scrollIntoView();
    },
  );
  // A period keeps the movers' choices.
  const href = (id?: string) => {
    const q = new URLSearchParams();
    if (id !== undefined) q.set("interval", id);
    for (const k of ["measure", "moved"]) {
      const v = search[k];
      if (typeof v === "string") q.set(k, v);
    }
    const s = q.toString();
    return s === "" ? paths.lightning() : `${paths.lightning()}?${s}`;
  };
  const failed = () => (
    <ErrorState
      title="Could not load the Lightning network's figures"
      error={overview.error}
      retry={refetch}
    />
  );
  return (
    <>
      <div class="ln-periods">
        <Periods choices={PERIODS} current={period().id} fitted={false} href={href} />
      </div>
      {/* A phone's way down a long page. */}
      <nav class="ln-jumps" aria-label="On this page">
        <For each={JUMPS}>
          {(j) => (
            <a href={`#${j.id}`} rel="external">
              {j.label}
            </a>
          )}
        </For>
      </nav>
      <Show when={overview.state !== "errored"} fallback={failed()}>
        <Show when={overview.latest} fallback={<Loading label="Loading the Lightning network" />}>
          {(o) => <Now stats={o().statistics} before={o().before?.[period().id] ?? null} />}
        </Show>
      </Show>
      <LiveFeed network={props.network} />
      <MoversSection request={movers} period={period()} />
      <ClosesSection request={closes} first={series[0].latest?.first} />
      <History request={series} period={period()} />
      <Show when={overview.latest}>
        {(o) => (
          <div class="ln-pair">
            <section aria-labelledby="ln-top-capacity-title">
              <SectionHeader title="Largest nodes" id="ln-top-capacity-title">
                <Link href={paths.lightningRankings("capacity")}>Top 100</Link>
              </SectionHeader>
              <TopTable
                rows={o().top_capacity.slice(0, PREVIEW)}
                caption="The five nodes with the most capacity"
                by="capacity"
              />
            </section>
            <section aria-labelledby="ln-top-channels-title">
              <SectionHeader title="Most connected nodes" id="ln-top-channels-title">
                <Link href={paths.lightningRankings("channels")}>Top 100</Link>
              </SectionHeader>
              <TopTable
                rows={o().top_channels.slice(0, PREVIEW)}
                caption="The five nodes with the most channels"
                by="channels"
              />
              <p class="ln-more">
                <Link class="tap" href={paths.lightningRankings("age")}>
                  The oldest nodes
                </Link>
              </p>
            </section>
          </div>
        )}
      </Show>
    </>
  );
}

/** The newest snapshot's figures, each with its change since the period began, or why there is none. */
function Now(props: { stats: Stats | null; before: Before | null }) {
  const change = (key: keyof Before, format: (n: number) => string) => (
    <Show when={props.stats && props.before}>
      {changeWords(props.stats?.[key] ?? 0, props.before?.[key] ?? 0, format)}
    </Show>
  );
  return (
    <section class="ln-overview-now" aria-labelledby="ln-now-title">
      <SectionHeader title="The network now" id="ln-now-title">
        <Show when={props.stats}>{(s) => <>As of {formatMoment(s().time)}</>}</Show>
      </SectionHeader>
      <Show
        when={props.stats}
        fallback={
          <Empty title="No snapshot yet">
            This server stores the network's size every ten minutes once its channel graph is
            synced. The first appears here within ten minutes.
          </Empty>
        }
      >
        {(s) => (
          <>
            <dl class="ln-stats">
              <Stat label="Channels" sub={change("channels", groupDigits)}>
                <span class="num">{groupDigits(s().channels)}</span>
              </Stat>
              <Stat label="Nodes" sub={change("nodes", groupDigits)}>
                <span class="num">{groupDigits(s().nodes)}</span>
              </Stat>
              <Stat label="Capacity" sub={change("capacity", (n) => `${formatBtcShort(n)} BTC`)}>
                <Amount sats={s().capacity} short />
              </Stat>
              <Stat label="Median fee rate" sub={change("med_fee_rate", ppm)}>
                <span class="num">{ppm(s().med_fee_rate)}</span>
              </Stat>
              <Stat label="Median base fee" sub={change("med_base_fee_msat", msat)}>
                <span class="num">{msat(s().med_base_fee_msat)}</span>
              </Stat>
            </dl>
            <p class="ln-aside">Only channels checked against the chain are counted.</p>
            <More>
              <p>
                {VERIFIED_NOTE} Fee figures are what nodes charge to forward a payment, over{" "}
                {groupDigits(s().policies)} policies. A change compares the newest snapshot with the
                first stored at the period's start; none is shown when the record does not reach
                back that far.
              </p>
            </More>
          </>
        )}
      </Show>
    </section>
  );
}

const MEASURES = [
  { id: "capacity", label: "Capacity" },
  { id: "channels", label: "Channels" },
] as const;
const WAYS = [
  { id: "gained", label: "Gained" },
  { id: "lost", label: "Lost" },
  { id: "either", label: "Either way" },
] as const;

/** A signed change in a column whose header names its unit: `+5.56`, `−0.525`, `+68`. */
const signed = (n: number, measure: "capacity" | "channels") =>
  measure === "capacity"
    ? `${plus(n)}${formatBtcShort(n)}`
    : `${n > 0 ? "+" : n < 0 ? "−" : ""}${groupDigits(Math.abs(n))}`;

function MoversSection(props: { request: ApiRequest<Movers>; period: Period }) {
  const [search, setSearch] = useSearchParams();
  const measure = () => (search["measure"] === "channels" ? "channels" : "capacity");
  const way = () => WAYS.find((w) => w.id === search["moved"])?.id ?? "gained";
  const [movers, { refetch }] = props.request;
  const columns = createMemo((): Column<Mover>[] => {
    const m = measure();
    const unit = m === "capacity" ? "BTC" : "channels";
    return [
      { header: "Node", cell: (r) => <NodeName node={r} /> },
      {
        header: `Change, ${unit}`,
        short: "Change",
        numeric: true,
        cell: (r) => (
          <span class="num">
            {signed(m === "capacity" ? r.capacity_change : r.channels_change, m)}
            <span class="visually-hidden"> {unit}</span>
          </span>
        ),
      },
      {
        header: `Now, ${unit}`,
        short: "Now",
        numeric: true,
        drop: 1,
        cell: (r) =>
          m === "capacity" ? (
            <Amount sats={r.capacity} unit={false} short />
          ) : (
            groupDigits(r.channels)
          ),
      },
    ];
  });
  const pick = (
    label: string,
    choices: readonly { id: string; label: string }[],
    current: string,
    key: string,
  ) => (
    <div class="ln-picker" role="group" aria-label={label}>
      <ul>
        <For each={choices}>
          {(c) => (
            <li>
              <button
                type="button"
                class="ln-picker__item"
                aria-pressed={current === c.id ? "true" : "false"}
                onClick={() => setSearch({ [key]: c.id }, { replace: true, scroll: false })}
              >
                {c.label}
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
  const arrivals = (left: boolean): Column<Mover>[] => [
    { header: "Node", cell: (r) => <NodeName node={r} link={!left} /> },
    {
      header: left ? "Last close" : "First channel",
      sub: "ago",
      numeric: true,
      cell: (r) => (r.time === undefined ? "–" : <Ago time={r.time} />),
    },
    {
      header: left ? "Channels closed" : "Channels",
      drop: 1,
      ...(left ? { short: "Closed" } : {}),
      numeric: true,
      cell: (r) => groupDigits(left ? Math.abs(r.channels_change) : r.channels),
    },
  ];
  return (
    <section aria-labelledby="ln-movers-title">
      <SectionHeader title="Movers" id="ln-movers-title">
        Net change, {props.period.words}
      </SectionHeader>
      <Show
        when={movers.state !== "errored"}
        fallback={
          <ErrorState title="Could not load the movers" error={movers.error} retry={refetch} />
        }
      >
        <Show when={movers.latest} fallback={<Loading label="Loading the movers" />}>
          {(m) => (
            <div
              class="ln-busy"
              aria-busy={m().period === props.period.id && !movers.loading ? "false" : "true"}
            >
              <div class="ln-controls">
                {pick("Measure", MEASURES, measure(), "measure")}
                {pick("Which way", WAYS, way(), "moved")}
              </div>
              <DataTable
                caption={`Nodes by ${measure()} ${way() === "either" ? "moved" : way()}, ${props.period.words}`}
                columns={columns()}
                rows={moversFor(m(), measure(), way())}
                rowHref={(r) => paths.lightningNode(r.id)}
                empty={<Empty title="No change in this period" />}
              />
              <div class="ln-pair ln-pair--flat">
                <div>
                  <h3 class="ln-h3">Newest nodes</h3>
                  <DataTable
                    caption="Newest nodes"
                    columns={arrivals(false)}
                    rows={m().new}
                    rowHref={(r) => paths.lightningNode(r.id)}
                    empty={<Empty title="None in this period" />}
                  />
                </div>
                <div>
                  <h3 class="ln-h3">Nodes that left</h3>
                  <DataTable
                    caption="Nodes that left"
                    columns={arrivals(true)}
                    rows={m().left}
                    empty={<Empty title="None in this period" />}
                  />
                </div>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </section>
  );
}

/**
 * How long ago, in the node page's short form (`5 h`, `28 d`) under a header that says "ago", so
 * a narrow table's cell holds one line. The clock is read here, in the leaf, never by the list.
 */
function Ago(props: { time: number }) {
  const now = useNow();
  return (
    <span class="num" title={formatUtc(props.time)}>
      {ageShort(now() - props.time)}
    </span>
  );
}

const total = (d: DayCloses) => d.cooperative + d.force + d.penalty + d.other;

/** A round top for the bars' scale, at least the largest day, its half a whole number too. */
function barTop(most: number): number {
  const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, most))));
  return ([2, 4, 6, 8, 10].find((m) => m * p >= most) ?? 10) * p;
}

function ClosesSection(props: { request: ApiRequest<Closes>; first: number | null | undefined }) {
  const [closes, { refetch }] = props.request;
  return (
    <section aria-labelledby="ln-closes-title">
      <SectionHeader title="Closes by kind" id="ln-closes-title">
        Each day, UTC
      </SectionHeader>
      <Show
        when={closes.state !== "errored"}
        fallback={
          <ErrorState title="Could not load the closes" error={closes.error} retry={refetch} />
        }
      >
        <Show when={closes.latest} fallback={<Loading label="Loading the closes" />}>
          {(c) => (
            <CloseBars days={c().days} sum={closesInWords(c().total)} first={props.first ?? null} />
          )}
        </Show>
      </Show>
    </section>
  );
}

/**
 * A bar a day, its kinds stacked. The bars are a drawing, not controls (30 in a phone's width
 * cannot each be a thumb wide): the pointer over a day reads it out, and the figures are a table.
 */
function CloseBars(props: { days: DayCloses[]; sum: string; first: number | null }) {
  const [at, setAt] = createSignal<number>();
  const [figures, setFigures] = createSignal(false);
  const days = createMemo(() => drawnDays(props.days, props.first));
  const day = () => days()[at() ?? days().length - 1];
  // A day over before this server's record began is unknown, not a day without closes.
  const unknown = (d: DayCloses) => props.first !== null && d.time + 86_400 <= props.first;
  const partial = () => props.first !== null && props.first > (props.days[0]?.time ?? 0);
  const top = () => barTop(Math.max(0, ...days().map((d) => total(d))));
  return (
    <>
      <p class="ln-bars__readout">
        <strong>{day() ? formatDay(day()?.time ?? 0) : ""}</strong>
        <For each={CLOSE_KINDS}>
          {(k) => (
            <span class="ln-bars__key">
              <span class={`ln-bars__swatch ln-close-${k}`} aria-hidden="true" />
              {KIND_SHORT[k]}{" "}
              <span class="num">
                {(() => {
                  const d = day();
                  return d === undefined || unknown(d) ? "–" : groupDigits(d[k]);
                })()}
              </span>
            </span>
          )}
        </For>
      </p>
      <div class="ln-bars" aria-hidden="true">
        <span class="ln-bars__axis">
          <span class="num">{groupDigits(top())}</span>
          <span class="num">{groupDigits(top() / 2)}</span>
          <span class="num">0</span>
        </span>
        <div
          class="ln-bars__plot"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.floor(((e.clientX - r.left) / r.width) * days().length);
            setAt(Math.max(0, Math.min(days().length - 1, i)));
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setAt(undefined);
          }}
        >
          <For each={days()}>
            {(d, i) => (
              <span
                class={[
                  "ln-bars__day",
                  { "ln-bars__day--at": at() === i(), "ln-bars__day--unknown": unknown(d) },
                ]}
              >
                <For each={CLOSE_KINDS}>
                  {(k) => (
                    <Show when={d[k] > 0}>
                      <span
                        class={`ln-bars__seg ln-close-${k}`}
                        style={{ "--h": String(d[k] / top()) }}
                      />
                    </Show>
                  )}
                </For>
              </span>
            )}
          </For>
        </div>
      </div>
      <p class="ln-bars__ends" aria-hidden="true">
        <span class="num">{formatDay(days()[0]?.time ?? 0)}</span>
        <span class="num">{formatDay(days().at(-1)?.time ?? 0)}</span>
      </p>
      <p class="ln-aside">
        {partial() ? `Recorded from ${formatDay(props.first ?? 0)}` : `In ${CLOSE_DAYS} days`}:{" "}
        {props.sum}. <Link href={paths.lightningPenalties()}>Every penalty seen</Link>
      </p>
      <details class="more" onToggle={(e) => setFigures(e.currentTarget.open)}>
        <summary class="more__summary">Show the figures</summary>
        <div class="more__body">
          <Show when={figures()}>
            <DataTable
              caption={`Closes each day by kind, the last ${days().length} days`}
              columns={[
                { header: "Day", cell: (d: DayCloses) => formatDay(d.time) },
                ...CLOSE_KINDS.map((k): Column<DayCloses> => ({
                  header: KIND_SHORT[k],
                  numeric: true,
                  // Before the record began nothing is known: never "0".
                  cell: (d) => (unknown(d) ? "–" : groupDigits(d[k])),
                })),
              ]}
              rows={sorted(days(), (a, b) => b.time - a.time)}
            />
          </Show>
        </div>
      </details>
    </>
  );
}

function History(props: { request: ApiRequest<Series>; period: Interval }) {
  const [series, { refetch }] = props.request;
  const answer = () => series.latest;
  return (
    <section id="history" class="ln-history" aria-labelledby="ln-history-title">
      <SectionHeader title="Over time" id="ln-history-title">
        Every ten minutes
      </SectionHeader>
      <Show
        when={series.state !== "errored"}
        fallback={
          <ErrorState
            title="Could not load the network's history"
            error={series.error}
            retry={refetch}
          />
        }
      >
        <Show
          when={answer()}
          fallback={
            <div class="ln-chart">
              <Loading label="Loading the network's history" />
            </div>
          }
        >
          {(s) => (
            <div
              class="ln-busy"
              aria-busy={s().interval === props.period.id && !series.loading ? "false" : "true"}
            >
              <Show when={s().points.length > 0} fallback={<NothingRecorded s={s()} />}>
                <HistoryChart s={s()} interval={props.period} />
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </section>
  );
}

function NothingRecorded(props: { s: Series }) {
  return (
    <Show
      when={props.s.first !== null}
      fallback={
        <Empty title="Nothing recorded yet">
          This server's history of the network starts when its Lightning peer first synced: it
          stores the network's size every ten minutes from then on. The first point appears within
          ten minutes.
        </Empty>
      }
    >
      <Empty title="Nothing recorded in this period">
        This server's records begin {formatMoment(props.s.first ?? 0)}.
      </Empty>
    </Show>
  );
}

/** The period's whole width, the time before the first record hatched. */
function HistoryChart(props: { s: Series; interval: Interval }) {
  const x = () => props.s.points.map((p) => p.time);
  const col = (f: (p: Stats) => number) => props.s.points.map(f);
  const time = () =>
    props.s.step < 86_400 ? formatMoment : (t: number) => formatMoment(t).replace(/, .*$/, "");
  return (
    <>
      <Show when={coverageSentence(props.s)}>
        {(text) => (
          <p class="ln-coverage">
            <Show when={dataFrom(props.s) !== undefined}>
              <span class="ln-coverage__swatch" aria-hidden="true" />
            </Show>
            {text()}
          </p>
        )}
      </Show>
      <div class="ln-chart">
        <Pending>
          <Chart
            label={`Lightning channels and capacity, ${props.interval.words}`}
            x={x()}
            domain={[props.s.from, props.s.to]}
            dataFrom={dataFrom(props.s)}
            gap={props.s.step}
            height={240}
            left={{ format: (v) => groupDigits(v) }}
            right={{ format: btcAxis }}
            // Samples of the whole network every ten minutes: when there are few, each is marked.
            series={[
              {
                name: "Channels",
                values: col((p) => p.channels),
                draw: "area",
                format: groupDigits,
                marks: true,
              },
              {
                name: "Capacity",
                values: col((p) => p.capacity),
                draw: "line",
                axis: "right",
                tone: 2,
                // In magnitude, as the figures above read it: whole at any size.
                format: formatBtcShort,
                unit: "BTC",
                marks: true,
              },
            ]}
            notes={[
              { name: "Nodes", values: col((p) => p.nodes), format: groupDigits },
              { name: "Median fee rate", values: col((p) => p.med_fee_rate), format: ppm },
            ]}
            time={time()}
          />
        </Pending>
      </div>
    </>
  );
}

function TopTable(props: { rows: RankedNode[]; caption: string; by: "capacity" | "channels" }) {
  return (
    <DataTable
      caption={props.caption}
      columns={nodeColumns(props.by)}
      rows={props.rows}
      rowHref={(n) => paths.lightningNode(n.id)}
    />
  );
}
