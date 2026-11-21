// The Lightning network for its operators: the totals and their change over a period, each one a
// choice of what the chart draws; closes by kind beside the chart; the live feed beside the
// period's movers; then four short node lists (docs/DESIGN.md "Lightning", docs/FRONTEND.md
// "Lightning pages").
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
import { useNow } from "../../lib/clock";
import {
  formatBtc,
  formatBtcShort,
  formatPowerOfTen,
  formatUtc,
  groupDigits,
} from "../../lib/format";
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
  CLOSE_KINDS,
  coverageSentence,
  dataFrom,
  INTERVALS,
  isOverview,
  isSeries,
  KIND_SHORT,
  msat,
  msatAsBtc,
  type Overview as OverviewAnswer,
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
  Fig,
  Gate,
  LightningNav,
  NodeName,
  rememberList,
  VERIFIED_NOTE,
} from "./parts";

const Chart = lazy(() => import("../../components/chart/Chart"));

/** Rows in each node list: a preview; the rankings hold the rest. */
const PREVIEW = 5;
/** The periods the page's figures, movers and chart share. */
const PERIODS = [INTERVALS[0], INTERVALS[1], INTERVALS[2]] as const;
type Period = (typeof PERIODS)[number];
/** Days of closes drawn. */
const CLOSE_DAYS = 30;

/** A figure's unit kept with it: the last plain space becomes a no-break one. */
const whole = (s: string) => s.replace(/ (?=[^ ]+$)/, "\u00A0");
const btc = (sats: number) => whole(`${formatBtcShort(sats)} BTC`);
/** A chart's readout of one point is exact, its axis compact (a mean may be a fraction of a sat). */
const btcExact = (sats: number) => formatBtc(Math.round(sats));

/** "12 Nov": the year only when it is not the year of `ref`, the newest moment beside it. */
function day(t: number, ref: number): string {
  const text = formatDay(t);
  const year = ` ${new Date(ref * 1000).getUTCFullYear()}`;
  return text.endsWith(year) ? text.slice(0, -year.length) : text;
}

interface Figure {
  key: keyof Stats;
  label: string;
  fmt: (n: number) => string;
  axis: (n: number) => string;
  unit?: string;
  /** The unit of the raw figure, for the chart's CSV: capacities are in sats. */
  raw?: string;
  /** A long change in magnitude, for a figure's narrowest room. */
  short?: (n: number) => string;
  /** The mean beside a median, in the chart's readout. */
  mean?: { key: keyof Stats; fmt: (n: number) => string };
}

/** The figures across the top. Each is also the chart's choice: the pressed one is drawn below. */
const FIGURES: readonly [Figure, ...Figure[]] = [
  { key: "channels", label: "Channels", fmt: groupDigits, axis: groupDigits },
  { key: "nodes", label: "Nodes", fmt: groupDigits, axis: groupDigits },
  { key: "capacity", label: "Capacity", fmt: btc, axis: formatBtcShort, unit: "BTC", raw: "sat" },
  {
    key: "med_capacity",
    label: "Median channel",
    fmt: btc,
    axis: formatBtcShort,
    unit: "BTC",
    raw: "sat",
    mean: { key: "avg_capacity", fmt: btc },
  },
  {
    key: "med_fee_rate",
    label: "Median fee rate",
    fmt: ppm,
    axis: groupDigits,
    unit: "ppm",
    raw: "ppm",
    short: (n) => `${formatPowerOfTen(n)} ppm`,
    mean: { key: "avg_fee_rate", fmt: ppm },
  },
  {
    key: "med_base_fee_msat",
    label: "Median base fee",
    fmt: msat,
    axis: groupDigits,
    unit: "msat",
    raw: "msat",
    short: msatAsBtc,
    mean: { key: "avg_base_fee_msat", fmt: msat },
  },
];

export default function LightningPage() {
  usePageTitle(() => "Lightning");
  const network = useNetwork();
  return (
    <div class="wrap ln ln-ov">
      <LightningNav here="overview" />
      <h1 class="ln-ov__title">Lightning</h1>
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
  const [search, setSearch] = useSearchParams();
  const period = createMemo(
    (): Period => PERIODS.find((p) => p.id === search["interval"]) ?? PERIODS[1],
  );
  const figure = createMemo(
    (): Figure => FIGURES.find((f) => f.key === search["figure"]) ?? FIGURES[0],
  );
  const overviewRequest = createRequest(
    () => props.network,
    (n, signal) => ask(n, "/overview", isOverview, signal),
  );
  const [overview, { refetch }] = overviewRequest;
  // The chart's and the figures' series; its first record also says from when closes are known.
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
  // so they do not push it out of view after the jump.
  const location = useLocation();
  const settled = (r: ApiRequest<unknown>) => r[0].latest !== undefined || r[0].state === "errored";
  createEffect(
    () => [location.hash, settled(overviewRequest) && settled(series) && settled(closes)] as const,
    ([hash, ready]) => {
      if (hash === "#history" && ready) document.getElementById("history")?.scrollIntoView();
    },
  );
  // A period keeps the chosen figure and the movers' choices.
  const href = (id?: string) => {
    const q = new URLSearchParams();
    if (id !== undefined) q.set("interval", id);
    for (const k of ["figure", "measure", "moved"]) {
      const v = search[k];
      if (typeof v === "string") q.set(k, v);
    }
    const s = q.toString();
    return s === "" ? paths.lightning() : `${paths.lightning()}?${s}`;
  };
  // The series answers for the period asked, or is still the last one's.
  const current = () => {
    const s = series[0].latest;
    return s?.interval === period().id ? s : undefined;
  };
  return (
    <>
      <p class="ln-ov__asof">
        <Show when={overview.latest?.statistics}>{(s) => <>As of {formatMoment(s().time)}</>}</Show>
      </p>
      <div class="ln-ov__periods">
        <Periods choices={PERIODS} current={period().id} fitted={false} href={href} />
      </div>
      <section class="panel ln-ov-now" aria-labelledby="ln-now-title">
        <h2 id="ln-now-title" class="visually-hidden">
          The network now
        </h2>
        <Show
          when={overview.state !== "errored"}
          fallback={
            <ErrorState
              title="Could not load the Lightning network's figures"
              error={overview.error}
              retry={refetch}
            />
          }
        >
          <Show when={overview.latest} fallback={<Loading label="Loading the Lightning network" />}>
            {(o) => (
              <Show
                when={o().statistics}
                fallback={
                  <Empty title="No snapshot yet">
                    This server stores the network's size every ten minutes once its channel graph
                    is synced. The first appears here within ten minutes.
                  </Empty>
                }
              >
                {(st) => (
                  <Figures
                    stats={st()}
                    before={o().before?.[period().id] ?? null}
                    series={current()}
                    current={figure().key}
                    pick={(key) => setSearch({ figure: key }, { replace: true, scroll: false })}
                  />
                )}
              </Show>
            )}
          </Show>
        </Show>
      </section>
      <div class="ln-ov__row">
        <History request={series} period={period()} figure={figure()} />
        <ClosesSection request={closes} first={series[0].latest?.first} />
      </div>
      <div class="ln-ov__row">
        <LiveFeed network={props.network} />
        <MoversSection request={movers} period={period()} />
      </div>
      <NodeLists overview={overviewRequest} movers={movers} period={period()} />
    </>
  );
}

/** The value at the period's start: the server's own `before`, else the series' first point. */
function startOf(
  key: keyof Stats,
  before: Before | null,
  series: Series | undefined,
): number | undefined {
  if (before !== null && key in before) return before[key as keyof Before];
  return series?.points[0]?.[key];
}

/** The newest snapshot's figures, each a button that charts it, with its change and its trend. */
function Figures(props: {
  stats: Stats;
  before: Before | null;
  series: Series | undefined;
  current: keyof Stats;
  pick: (key: keyof Stats) => void;
}) {
  // With no totals at the period's start, changes run from the first record inside it.
  const since = () => (props.before === null ? props.series?.points[0]?.time : undefined);
  const reach = () => {
    const s = props.stats;
    return [
      { name: "Clearnet", n: s.clearnet_nodes, cls: "ln-reach--clear" },
      { name: "Clearnet and Tor", n: s.clearnet_tor_nodes, cls: "ln-reach--both" },
      { name: "Tor", n: s.tor_nodes, cls: "ln-reach--tor" },
      { name: "No address", n: s.unannounced_nodes, cls: "ln-reach--none" },
    ];
  };
  const pct = (n: number) =>
    props.stats.nodes > 0 ? `${Math.round((n / props.stats.nodes) * 100)}%` : "–";
  return (
    <>
      <div class="ln-ov-figs" role="group" aria-label="Figures; the pressed one is charted below">
        <For each={FIGURES}>
          {(f) => {
            const change = () => {
              const start = startOf(f.key, props.before, props.series);
              return start === undefined ? undefined : props.stats[f.key] - start;
            };
            return (
              // Its own cell, which it fills: a figure is a control of several lines by design.
              <div class="ln-ov-figs__cell">
                <button
                  type="button"
                  class="ln-ov-fig"
                  aria-pressed={props.current === f.key ? "true" : "false"}
                  onClick={() => props.pick(f.key)}
                >
                  <span class="ln-ov-fig__label">{f.label}</span>
                  <span class="ln-ov-fig__value num">
                    <Show when={f.unit === "BTC"} fallback={f.fmt(props.stats[f.key])}>
                      <Amount sats={props.stats[f.key]} short />
                    </Show>
                  </span>
                  <span class="ln-ov-fig__change">
                    <Show when={change()}>
                      {(d) => (
                        <>
                          <span aria-hidden="true">{d() > 0 ? "↑" : "↓"}</span>
                          <span class="visually-hidden">{d() > 0 ? "Up" : "Down"}</span>{" "}
                          <Show
                            when={f.short}
                            fallback={<span class="num">{whole(f.fmt(Math.abs(d())))}</span>}
                          >
                            {(short) => (
                              <Fig
                                exact={whole(f.fmt(Math.abs(d())))}
                                short={whole(short()(Math.abs(d())))}
                              />
                            )}
                          </Show>
                        </>
                      )}
                    </Show>
                    <Show when={change() === 0}>No change</Show>
                  </span>
                  <Show when={props.series} fallback={<span class="ln-spark" />}>
                    {(s) => <Spark series={s()} pick={(p) => p[f.key]} />}
                  </Show>
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={since()}>
        {(t) => (
          <p class="ln-aside">Changes since {day(t(), props.stats.time)}, when the record began.</p>
        )}
      </Show>
      <div class="ln-reach">
        <span class="ln-reach__label">Nodes reached by</span>
        <span class="ln-reach__bar" aria-hidden="true">
          <For each={reach()}>
            {(r) => <span class={r.cls} style={{ "flex-grow": String(r.n) }} />}
          </For>
        </span>
        <ul class="ln-reach__key">
          <For each={reach()}>
            {(r) => (
              <li>
                <span class={`ln-reach__swatch ${r.cls}`} aria-hidden="true" />
                {r.name} <span class="num">{pct(r.n)}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
      <More>
        <p>
          {VERIFIED_NOTE} Fee figures are what nodes charge to forward a payment, over{" "}
          {groupDigits(props.stats.policies)} policies. A change compares the newest snapshot with
          the first stored at the period's start, or with the first record when the record is
          shorter.
        </p>
      </More>
    </>
  );
}

/** The period's trend in a figure: its whole width, hatched before the record, broken at gaps. */
function Spark(props: { series: Series; pick: (p: Stats) => number }) {
  const W = 120;
  const H = 28;
  const d = createMemo(() => {
    const { from, to, step, points } = props.series;
    const vs = points.map((p) => props.pick(p));
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const y = (v: number) => (hi === lo ? H / 2 : H - 2 - ((v - lo) / (hi - lo)) * (H - 4));
    const x = (t: number) => ((t - from) / (to - from)) * W;
    let path = "";
    let last: number | undefined;
    points.forEach((p, i) => {
      // Up to five missing steps are bridged, as the charts do; a longer pause breaks the line.
      const move = last === undefined || p.time - last > step * 6;
      path += `${move ? "M" : "L"}${x(p.time).toFixed(1)} ${y(vs[i] ?? 0).toFixed(1)}`;
      last = p.time;
    });
    return path;
  });
  // Before the record: hatched as the charts hatch it, unknown rather than flat.
  const none = () => {
    const { from, to, points } = props.series;
    const first = points[0]?.time ?? to;
    return Math.max(0, ((first - from) / (to - from)) * 100);
  };
  return (
    <span class="ln-spark" aria-hidden="true">
      <Show when={none() > 1}>
        <span class="ln-spark__none" style={{ width: `${none()}%` }} />
      </Show>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <path d={d()} />
      </svg>
    </span>
  );
}

function History(props: { request: ApiRequest<Series>; period: Period; figure: Figure }) {
  const [series, { refetch }] = props.request;
  const aside = () => {
    const s = series.latest;
    return (s && coverageSentence(s)?.replace(/\.$/, "")) ?? "Every ten minutes";
  };
  return (
    <section id="history" class="ln-history" aria-labelledby="ln-history-title">
      <SectionHeader title={`${props.figure.label}, over time`} id="ln-history-title">
        {aside()}
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
          when={series.latest}
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
                <HistoryChart s={s()} period={props.period} figure={props.figure} />
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

/** The chosen figure over the period's whole width, the time before the first record hatched. */
function HistoryChart(props: { s: Series; period: Period; figure: Figure }) {
  const f = () => props.figure;
  const col = (key: keyof Stats) => props.s.points.map((p) => p[key]);
  const time = () =>
    props.s.step < 86_400 ? formatMoment : (t: number) => formatMoment(t).replace(/, .*$/, "");
  return (
    <div class="ln-chart">
      <Pending>
        <Chart
          label={`Lightning ${f().label.toLowerCase()}, ${props.period.words}`}
          x={props.s.points.map((p) => p.time)}
          domain={[props.s.from, props.s.to]}
          dataFrom={dataFrom(props.s)}
          gap={props.s.step}
          height={220}
          left={{ format: f().axis }}
          // Samples of the whole network every ten minutes: when there are few, each is marked.
          series={[
            {
              name: f().label,
              values: col(f().key),
              draw: "line",
              format: f().unit === "BTC" ? btcExact : f().axis,
              ...(f().unit === undefined ? {} : { unit: f().unit }),
              ...(f().raw === undefined ? {} : { rawUnit: f().raw }),
              marks: true,
            },
          ]}
          notes={(() => {
            const m = f().mean;
            return m === undefined
              ? []
              : [
                  {
                    name: "Mean",
                    values: col(m.key),
                    format: f().unit === "BTC" ? (n: number) => `${btcExact(n)} BTC` : m.fmt,
                    ...(f().raw === undefined ? {} : { rawUnit: f().raw }),
                  },
                ];
          })()}
          time={time()}
        />
      </Pending>
    </div>
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
    <section class="ln-ov-closes" aria-labelledby="ln-closes-title">
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
          {(c) => <CloseBars closes={c()} first={props.first ?? null} />}
        </Show>
      </Show>
    </section>
  );
}

/**
 * A bar a day, its kinds stacked. The bars are a drawing, not controls (30 in a phone's width
 * cannot each be a thumb wide): the pointer over a day reads it out, and the figures are a table.
 */
function CloseBars(props: { closes: Closes; first: number | null }) {
  const [at, setAt] = createSignal<number>();
  const [figures, setFigures] = createSignal(false);
  const days = createMemo(() => drawnDays(props.closes.days, props.first));
  const ref = () => props.closes.time;
  const today = () => days()[at() ?? days().length - 1];
  // A day over before this server's record began is unknown, not a day without closes.
  const unknown = (d: DayCloses) => props.first !== null && d.time + 86_400 <= props.first;
  const partial = () => props.first !== null && props.first > (props.closes.days[0]?.time ?? 0);
  const top = () => barTop(Math.max(0, ...days().map((d) => total(d))));
  return (
    <>
      <p class="ln-bars__readout">
        <strong>{today() ? day(today()?.time ?? 0, ref()) : ""}</strong>
        <For each={CLOSE_KINDS}>
          {(k) => (
            <span class="ln-bars__key">
              <span class={`ln-bars__swatch ln-close-${k}`} aria-hidden="true" />
              {KIND_SHORT[k]}{" "}
              <span class="num">
                {(() => {
                  const d = today();
                  return d === undefined || unknown(d) ? "–" : groupDigits(d[k]);
                })()}
              </span>
            </span>
          )}
        </For>
        <Show when={today()}>
          {(d) => <span class="ln-bars__key num">{unknown(d()) ? "" : btc(d().capacity)}</span>}
        </Show>
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
        <span class="num">{day(days()[0]?.time ?? 0, ref())}</span>
        <span class="num">{day(days().at(-1)?.time ?? 0, ref())}</span>
      </p>
      <p class="ln-aside">
        {partial() ? `Since ${day(props.first ?? 0, ref())}` : `In ${CLOSE_DAYS} days`}:{" "}
        {closesInWords(props.closes.total)},{" "}
        <span class="num">{btc(props.closes.total.capacity)}</span>.{" "}
        <Link class="tap" href={paths.lightningPenalties()}>
          Penalties
        </Link>
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

/** One row of choices, the current one pressed in. */
function Picker(props: {
  label: string;
  choices: readonly { id: string; label: string }[];
  current: string;
  pick: (id: string) => void;
}) {
  return (
    <div class="ln-picker" role="group" aria-label={props.label}>
      <ul>
        <For each={props.choices}>
          {(c) => (
            <li>
              <button
                type="button"
                class="ln-picker__item"
                aria-pressed={props.current === c.id ? "true" : "false"}
                onClick={() => props.pick(c.id)}
              >
                {c.label}
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

function MoversSection(props: { request: ApiRequest<Movers>; period: Period }) {
  const [search, setSearch] = useSearchParams();
  const measure = () => (search["measure"] === "channels" ? "channels" : "capacity");
  const way = () => WAYS.find((w) => w.id === search["moved"])?.id ?? "gained";
  const choose = (key: string) => (id: string) =>
    setSearch({ [key]: id }, { replace: true, scroll: false });
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
  return (
    <section class="ln-ov-movers" aria-labelledby="ln-movers-title">
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
                <Picker
                  label="Measure"
                  choices={MEASURES}
                  current={measure()}
                  pick={choose("measure")}
                />
                <Picker label="Which way" choices={WAYS} current={way()} pick={choose("moved")} />
              </div>
              <DataTable
                caption={`Nodes by ${measure()} ${way() === "either" ? "moved" : way()}, ${props.period.words}`}
                columns={columns()}
                rows={moversFor(m(), measure(), way())}
                rowHref={(r) => paths.lightningNode(r.id)}
                empty={<Empty title="No change in this period" />}
              />
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
function Ago(props: { time: number | undefined }) {
  const now = useNow();
  return (
    <Show when={props.time} fallback="–">
      {(t) => (
        <span class="num" title={formatUtc(t())}>
          {ageShort(now() - t())}
        </span>
      )}
    </Show>
  );
}

const LISTS = [
  { id: "capacity", label: "Largest" },
  { id: "channels", label: "Connected" },
  { id: "new", label: "Newest" },
  { id: "left", label: "Left" },
] as const;

/** Four short lists side by side: who is big, who is connected, who came, who went. */
function NodeLists(props: {
  overview: ApiRequest<OverviewAnswer>;
  movers: ApiRequest<Movers>;
  period: Period;
}) {
  const [overview] = props.overview;
  const [movers] = props.movers;
  // A phone shows one list at a time; a wide screen all four, and no picker.
  const [shown, setShown] = createSignal<string>("capacity");
  const ranked = (by: "capacity" | "channels"): Column<RankedNode>[] => [
    { header: "Node", cell: (n) => <NodeName node={n} /> },
    by === "capacity"
      ? {
          header: "Capacity, BTC",
          short: "BTC",
          numeric: true,
          cell: (n) => <Amount sats={n.capacity} unit={false} short />,
        }
      : { header: "Channels", numeric: true, cell: (n) => groupDigits(n.channels) },
  ];
  const arrivals = (left: boolean): Column<Mover>[] => [
    { header: "Node", cell: (r) => <NodeName node={r} link={!left} /> },
    ...(left
      ? [
          {
            header: "Closed",
            numeric: true,
            cell: (r: Mover) => groupDigits(Math.abs(r.channels_change)),
          },
        ]
      : []),
    {
      // One short word: four lists share a desktop's width. The titles say what the time is.
      header: "Ago",
      numeric: true,
      cell: (r) => <Ago time={r.time} />,
    },
  ];
  const top = (by: "capacity" | "channels", caption: string) => (
    <Show
      when={overview.latest}
      fallback={
        <Show when={overview.state !== "errored"} fallback={<p class="ln-aside">Not loaded.</p>}>
          <Loading label="Loading the nodes" />
        </Show>
      }
    >
      {(o) => (
        <DataTable
          caption={caption}
          columns={ranked(by)}
          rows={(by === "capacity" ? o().top_capacity : o().top_channels).slice(0, PREVIEW)}
          rowHref={(n) => paths.lightningNode(n.id)}
        />
      )}
    </Show>
  );
  // The last period's rows wait, marked busy, for the period chosen; a failed period shows none.
  const moved = (left: boolean) => (
    <Show when={movers.state !== "errored"} fallback={<p class="ln-aside">Not loaded.</p>}>
      <Show when={movers.latest} fallback={<Loading label="Loading the nodes" />}>
        {(m) => (
          <div
            class="ln-busy"
            aria-busy={m().period === props.period.id && !movers.loading ? "false" : "true"}
          >
            <DataTable
              caption={left ? "Nodes that left" : "Newest nodes"}
              columns={arrivals(left)}
              rows={(left ? m().left : m().new).slice(0, PREVIEW)}
              {...(left ? {} : { rowHref: (r: Mover) => paths.lightningNode(r.id) })}
              empty={<Empty title="None in this period" />}
            />
          </div>
        )}
      </Show>
    </Show>
  );
  return (
    <div class="ln-lists" data-show={shown()}>
      <div class="ln-lists__pick">
        <Picker label="Nodes" choices={LISTS} current={shown()} pick={setShown} />
      </div>
      <section data-list="capacity" aria-labelledby="ln-top-capacity-title">
        <SectionHeader title="Largest nodes" id="ln-top-capacity-title">
          <Link class="tap" href={paths.lightningRankings("capacity")}>
            Top 100
          </Link>
        </SectionHeader>
        {top("capacity", "The five nodes with the most capacity")}
      </section>
      <section data-list="channels" aria-labelledby="ln-top-channels-title">
        <SectionHeader title="Most connected" id="ln-top-channels-title">
          <Link class="tap" href={paths.lightningRankings("channels")}>
            Top 100
          </Link>
        </SectionHeader>
        {top("channels", "The five nodes with the most channels")}
      </section>
      <section data-list="new" aria-labelledby="ln-new-title">
        <SectionHeader title="Newest nodes" id="ln-new-title">
          {props.period.label}
        </SectionHeader>
        {moved(false)}
      </section>
      <section data-list="left" aria-labelledby="ln-left-title">
        <SectionHeader title="Nodes that left" id="ln-left-title">
          {props.period.label}
        </SectionHeader>
        {moved(true)}
      </section>
    </div>
  );
}
