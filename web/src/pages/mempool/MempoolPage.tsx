// The mempool over time: its size by fee band and what flowed through it, on one time axis, from
// the server's history (docs/FRONTEND.md "Mempool history", docs/DESIGN.md "Mempool history").
import { useSearchParams } from "@solidjs/router";
import { createMemo, createSignal, createUniqueId, For, onSettled, Show, untrack } from "solid-js";
import { type Column, DataTable } from "../../components/DataTable";
import {
  areaPath,
  extent,
  type Join,
  layerAt,
  linePath,
  nearestIndex,
  stackLayout,
} from "../../components/chart/geometry";
import { endLabels, formatSi, linearAxis, scale, timeTicks } from "../../components/chart/scale";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { Periods } from "../../components/Periods";
import { Empty, ErrorState, Loading } from "../../components/States";
import { ApiError, createRequest, fetchApp } from "../../lib/api";
import {
  FEE_BANDS,
  FEE_KEY_BOUNDS,
  formatFeeRate,
  formatSize,
  groupDigits,
} from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import {
  BRIDGE_STEPS,
  bandName,
  coverageSentence,
  crosshair,
  dataFrom,
  figures,
  filterFrom,
  type Flow,
  flowPoints,
  flowSentence,
  type History,
  INTERVALS,
  type Interval,
  isHistory,
  layersFrom,
  parseInterval,
  pointTime,
  rateText,
  recentMoment,
  type Series,
  seriesOf,
  sizeSummary,
} from "./history";
import RecentReplacements from "./RecentReplacements";
import "./MempoolPage.css";

/** A new sample lands about a second after each minute turns (docs/FRONTEND.md); ask just after. */
const REFRESH_OFFSET_MS = 3000;

/** The server runs without a data directory, so it keeps no history: no retry changes that. */
export const isNoStore = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 503 && /data directory/i.test(e.message);

export default function MempoolPage() {
  usePageTitle(() => "Mempool history");
  const network = useNetwork();
  // Everything on the page belongs to one network: switching networks starts it afresh.
  return (
    <Show when={network()} keyed>
      {(n) => <MempoolHistory network={n} />}
    </Show>
  );
}

function MempoolHistory(props: { network: Network }) {
  const [search] = useSearchParams();
  const interval = createMemo(() => parseInterval(search["interval"]));
  const [request, { refetch }] = createRequest(
    () => interval().id,
    async (id, signal) => {
      const v = await fetchApp<unknown>(props.network, `/mempool/history/${id}`, {
        signal,
        cached: true,
      });
      if (!isHistory(v)) throw new ApiError(200, "The server sent a reply that could not be read.");
      return v;
    },
  );
  // The last answer stays while the next loads, so a new interval never empties the page.
  const answer = () => request.latest;
  const current = () => answer()?.interval === interval().id;
  // No period in the address: a view whose records begin inside it starts where they do.
  const fit = () => search["interval"] === undefined;
  const fitted = () => {
    const h = answer();
    return fit() && h !== undefined ? dataFrom(h) : undefined;
  };

  onSettled(() => {
    // Live edge: ask again just after each new minute is recorded, so the newest point is never stale.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const ms = 60_000 - (Date.now() % 60_000) + REFRESH_OFFSET_MS;
      timer = setTimeout(() => {
        // Never cut short an ask still in flight (or retrying a busy server): it would never finish.
        if (request.state !== "errored" && !request.loading) refetch();
        schedule();
      }, ms);
    };
    schedule();
    return () => clearTimeout(timer);
  });

  return (
    <div class="wrap mempool mempool-history">
      <header class="mempool-head">
        <h1>Mempool history</h1>
        <Show when={answer()}>
          {(h) => (
            <Show when={coverageSentence(h())}>
              {(text) => (
                <p class="mempool-coverage">
                  {/* The hatch's key, where the plot draws one. */}
                  <Show when={fitted() === undefined && dataFrom(h()) !== undefined}>
                    <span class="mempool-coverage__swatch" aria-hidden="true" />
                  </Show>
                  {fitted() === undefined
                    ? text()
                    : `Recorded since ${recentMoment(h().first ?? 0)}.`}
                </p>
              )}
            </Show>
          )}
        </Show>
        <Periods
          choices={INTERVALS}
          current={interval().id}
          href={paths.mempool}
          fitted={fitted() !== undefined}
        />
      </header>
      <Show
        when={request.state !== "errored"}
        fallback={<Failure error={request.error} retry={refetch} />}
      >
        <Show
          when={answer()}
          fallback={
            <div class="mempool-slot">
              <Loading label="Loading the mempool's history" />
            </div>
          }
        >
          {(h) => (
            <div class="mempool-busy" aria-busy={current() && !request.loading ? "false" : "true"}>
              <Show when={h().points.length > 0} fallback={<NothingRecorded h={h()} />}>
                <Board h={h()} interval={interval()} from={fitted()} />
              </Show>
            </div>
          )}
        </Show>
      </Show>
      <RecentReplacements network={props.network} />
    </div>
  );
}

function Failure(props: { error: unknown; retry: () => void }) {
  return (
    <Show
      when={!isNoStore(props.error)}
      fallback={
        <Empty title="This server keeps no mempool history">
          It records the mempool once a minute only when it is given somewhere to store it (a data
          directory), and this one was started without one. The live mempool is on the{" "}
          <Link href={paths.home()}>home page</Link>.
        </Empty>
      }
    >
      <ErrorState
        title="Could not load the mempool's history"
        error={props.error}
        retry={props.retry}
      />
    </Show>
  );
}

/** Nothing in the period: say whether anything was ever recorded, and offer all of it. */
function NothingRecorded(props: { h: History }) {
  return (
    <Show
      when={props.h.first !== null}
      fallback={
        <Empty title="Nothing recorded yet">
          This server records the mempool once a minute while it follows it. The first minute
          appears here within two minutes of the server starting, without a reload.
        </Empty>
      }
    >
      <Empty title="Nothing recorded in this period">
        The server was not recording then. Its records begin {pointTime(60)(props.h.first ?? 0)}.{" "}
        <Link href={paths.mempool("all")}>See all of them</Link>
      </Empty>
    </Show>
  );
}

/** The period's figures, then the plot; the second reading layer under the panel. */
function Board(props: { h: History; interval: Interval; from: number | undefined }) {
  const s = createMemo(() => seriesOf(props.h));
  const flow = createMemo(() => flowPoints(props.h));
  return (
    <>
      <section class="mempool-board" aria-label="The mempool over the period">
        <Figures h={props.h} />
        <Plot h={props.h} s={s()} flow={flow()} interval={props.interval} from={props.from} />
      </section>
      <div class="mempool-more">
        <More>
          <p>
            Layers: what waits, by fee rate, cheapest at the bottom. A band in the key shows it and
            every dearer band alone.
          </p>
          <p>
            Flow: the line is what arrived, the shades what blocks mined and what left otherwise.
            {props.h.step < 600 ? " Ten-minute means, since a minute holds one block or none." : ""}
          </p>
          <p>“Next block reaches”: the cheapest band the dearest 1 MvB waiting reaches into.</p>
        </More>
        <FiguresTable h={props.h} s={s()} interval={props.interval} />
      </div>
    </>
  );
}

function Figures(props: { h: History }) {
  return (
    <Show when={figures(props.h)}>
      {(f) => (
        <dl class="mempool-figures">
          <div class="mempool-fig">
            <dt>Waiting now</dt>
            <dd class="mempool-fig__value num">{formatSize(f().last.vsize)}</dd>
            <dd class="mempool-fig__sub num">{groupDigits(f().last.count)} transactions</dd>
          </div>
          <div class="mempool-fig">
            <dt>Change</dt>
            <dd class="mempool-fig__value num">
              {f().change >= 0 ? "+" : "−"}
              {formatSize(Math.abs(f().change))}
            </dd>
            <dd class="mempool-fig__sub num">peak {formatSize(f().peak.vsize)}</dd>
          </div>
          <div class="mempool-fig">
            <dt>Arriving</dt>
            <dd class="mempool-fig__value num">{rateText(f().flow?.entered ?? 0)}</dd>
            <dd class="mempool-fig__sub num">blocks took {rateText(f().flow?.mined ?? 0)}</dd>
          </div>
          <div class="mempool-fig">
            <dt>Next block reaches</dt>
            <dd class="mempool-fig__value num">
              {f().deep === -1
                ? "Everything"
                : f().deep === 0
                  ? `${formatFeeRate(f().last.min_fee_rate / 1000)} sat/vB`
                  : `${FEE_KEY_BOUNDS[f().deep] ?? ""} sat/vB`}
            </dd>
            <dd class="mempool-fig__sub">
              {f().deep === -1 ? "under a block waiting" : "the dearest 1 MvB, now"}
            </dd>
          </div>
        </dl>
      )}
    </Show>
  );
}

const PHONE = "(max-width: 40em)";
const STRIP = "Flow, vB/s: arrived and left";
const STRIP_SHORT = "Flow, vB/s";
const NO_DATA = "No data stored";
/** Under this many px the axis names its ends rather than ticks (`endLabels`). */
const TICKS_FROM = 420;

/** How wide the widest label draws, in px, in the plot's own font. */
function labelWidth(labels: readonly string[], el: Element | undefined, kind = "label"): number {
  if (!el || labels.length === 0) return 0;
  const ruler = document.createElement("span");
  ruler.className = `mempool-${kind} mempool-ruler`;
  el.append(ruler);
  let widest = 0;
  for (const label of labels) {
    ruler.textContent = label;
    widest = Math.max(widest, ruler.getBoundingClientRect().width);
  }
  ruler.remove();
  return widest;
}

const swatch = (band: number) => (band === -1 ? "var(--fee-1)" : `var(--fee-${band + 1})`);

/**
 * The size by fee band over the flow, one time axis and one crosshair; beside it (under it on a
 * phone) the key, which reads the bands at the crosshair and filters them.
 */
function Plot(props: {
  h: History;
  s: Series;
  flow: Flow;
  interval: Interval;
  from: number | undefined;
}) {
  const id = createUniqueId();
  const phoneQuery = typeof matchMedia === "function" ? matchMedia(PHONE) : undefined;
  const [phone, setPhone] = createSignal(phoneQuery?.matches === true);
  const [width, setWidth] = createSignal(0);
  /** The time under the pointer, so a new minute never moves it; undefined reads the latest. */
  const [picked, setPicked] = createSignal<number>();
  /** The layer under the pointer, by its index in the stack; -1 for none. */
  const [hover, setHover] = createSignal(-1);
  /** The cheapest band shown; 0 shows them all. */
  const [floor, setFloor] = createSignal(0);
  let box: HTMLDivElement | undefined;

  onSettled(() => {
    const change = (e: MediaQueryListEvent) => setPhone(e.matches);
    phoneQuery?.addEventListener("change", change);
    // A tap outside the plot lets a picked layer go.
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !box?.contains(e.target)) setHover(-1);
    };
    document.addEventListener("pointerdown", away);
    const el = box;
    const ro = el ? new ResizeObserver(() => setWidth(el.clientWidth)) : undefined;
    if (el) {
      setWidth(el.clientWidth);
      ro?.observe(el);
    }
    return () => {
      ro?.disconnect();
      document.removeEventListener("pointerdown", away);
      phoneQuery?.removeEventListener("change", change);
    };
  });

  const frame = createMemo(() => {
    const w = width();
    const h = props.h;
    if (w <= 0 || h.points.length === 0) return undefined;
    const narrow = phone();
    const L = layersFrom(props.s, floor());
    const x = props.s.x;
    const stack = stackLayout(
      L.layers.map((l) => l.values),
      x.length,
    );
    const yAxis = linearAxis(0, extent(stack.at(-1)?.hi ?? [])?.[1] ?? 1, narrow ? 3 : 5, true);
    const F = props.flow;
    const D = F.drawn;
    const outTop = D.mined.map((m, i) => (m === null ? null : m + (D.other[i] ?? 0)));
    const fAxis = linearAxis(0, extent(D.entered, outTop)?.[1] ?? 1, 2, true);
    const yLabels = yAxis.ticks.map((t) => formatSi(t, "vB"));
    const fLabels = fAxis.ticks.map((t) => formatSi(t, ""));
    // The value axis as wide as its longest label needs, so none is ever cut.
    const ml = Math.max(
      narrow ? 40 : 52,
      Math.ceil(labelWidth([...yLabels, ...fLabels], box)) + 10,
    );
    const mr = 6;
    const sizeTop = 8;
    // The narrowest phones stack their figures taller: a shorter size strip keeps the axis in sight.
    const sizeBottom = sizeTop + (narrow ? (w < 300 ? 150 : 170) : 330);
    const flowTop = sizeBottom + (narrow ? 36 : 44);
    const flowBottom = flowTop + (narrow ? 64 : 112);
    const height = flowBottom + 22;
    const from = props.from ?? h.from;
    const sx = scale([from, h.to], [ml, w - mr]);
    const sy = scale(yAxis.domain, [sizeBottom, sizeTop]);
    const fy = scale(fAxis.domain, [flowBottom, flowTop]);
    // Each join's values stacked as the layers are, so a layer arrives and leaves on an edge.
    const cum = (vs: readonly number[]) => {
      let acc = 0;
      return vs.map((v) => {
        const lo = acc;
        acc += v;
        return { lo, hi: acc };
      });
    };
    const joinMaps = L.layers.map((_, k) => {
      const m = new Map<number, Join>();
      for (const j of L.joins) {
        m.set(j.index, {
          in: j.before ? cum(j.before)[k] : undefined,
          out: j.after ? cum(j.after)[k] : undefined,
        });
      }
      return m;
    });
    // A few missing minutes are bridged; points either side of n missing steps stand n + 1 apart.
    const gap = h.step * (BRIDGE_STEPS + 1);
    const room = w - ml - mr;
    const ticks = room < TICKS_FROM ? undefined : timeTicks(from, h.to, Math.floor(room / 96));
    const hatchTo = props.from === undefined ? dataFrom(h) : undefined;
    // The strip's name, shorter where a large text size would run it off the plot.
    const strip = [STRIP, STRIP_SHORT].find((t) => labelWidth([t], box, "strip") <= room) ?? "";
    const hatchLabel = labelWidth([NO_DATA], box) + 16;
    return {
      w,
      height,
      ml,
      mr,
      sizeTop,
      sizeBottom,
      flowTop,
      flowBottom,
      stack,
      layers: stack.map((l, k) => ({
        band: L.layers[k]?.band ?? 0,
        d: areaPath(x, l.hi, l.lo, sx, sy, gap, 1.5, joinMaps[k]),
      })),
      sx,
      sy,
      yTicks: yAxis.ticks.map((t, k) => ({ y: Math.round(sy(t)) + 0.5, label: yLabels[k] ?? "" })),
      fTicks: fAxis.ticks.map((t, k) => ({ y: Math.round(fy(t)) + 0.5, label: fLabels[k] ?? "" })),
      // Each point holds its ten minutes' mean, so the means step at their edges.
      mined: areaPath(D.x, D.mined, 0, sx, fy, gap, 1.5, undefined, true),
      other: areaPath(D.x, outTop, D.mined, sx, fy, gap, 1.5, undefined, true),
      entered: linePath(D.x, D.entered, sx, fy, gap, true),
      ticks: ticks?.ticks.map((t) => {
        const at = sx(t);
        // A label near an end stays on the plot.
        const anchor: "start" | "end" | "middle" =
          at - ml < 40 ? "start" : w - mr - at < 40 ? "end" : "middle";
        return { x: at, label: ticks.label(t), anchor };
      }),
      ends: endLabels(from, h.to, room),
      strip,
      hatchLabel,
      hatch: hatchTo === undefined ? undefined : { x: sx(h.from), w: sx(hatchTo) - sx(h.from) },
    };
  });

  const index = () => {
    const t = picked();
    const last = props.h.points.length - 1;
    return t === undefined ? last : nearestIndex(props.s.x, t);
  };
  const at = () => crosshair(props.h, props.s, props.flow, index(), floor());
  const time = () => pointTime(props.h.step);
  /** The band under the pointer, as the key names it; -2 for none. */
  const hoverBand = () => frame()?.layers[hover()]?.band ?? -2;
  const bandValue = (k: number, i = index()) =>
    k === -1 ? (props.s.unsplit?.[i] ?? 0) : (props.s.bands[k]?.[i] ?? 0);
  // Dearest at the top, as the stack is; the unsplit row keeps its place wherever the answer has
  // one, so the key never changes height as the crosshair moves.
  const rows = () => [
    ...Array.from({ length: FEE_BANDS }, (_, i) => FEE_BANDS - 1 - i),
    ...(props.s.unsplit ? [-1] : []),
  ];
  const offered = () => filterFrom(props.s);
  const shownBand = (k: number) => (k === -1 ? floor() === 0 : k >= floor());

  const pick = (e: PointerEvent) => {
    const f = frame();
    if (!f) return;
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const i = nearestIndex(props.s.x, f.sx.invert(e.clientX - r.left));
    setPicked(props.s.x[i]);
    const y = e.clientY - r.top;
    setHover(y >= f.sizeTop && y <= f.sizeBottom ? layerAt(f.stack, i, f.sy.invert(y)) : -1);
  };
  const leave = (e: PointerEvent) => {
    // A finger lifting keeps the reading, as a tap shows it.
    if (e.pointerType !== "mouse") return;
    setPicked(undefined);
    setHover(-1);
  };
  const key = (e: KeyboardEvent) => {
    const n = props.h.points.length;
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      PageUp: -10,
      PageDown: 10,
    };
    const by = moves[e.key];
    const move = (i: number) => setPicked(props.s.x[Math.max(0, Math.min(n - 1, i))]);
    if (by !== undefined) move(index() + by);
    else if (e.key === "Home") move(0);
    else if (e.key === "End" || e.key === "Escape") setPicked(undefined);
    else return;
    setHover(-1);
    e.preventDefault();
  };
  /** Everything the crosshair reads, for a screen reader. */
  const valueText = () => {
    const a = at();
    if (!a) return "";
    const p = a.point;
    const bands = rows()
      .filter((k) => shownBand(k) && (k !== -1 || bandValue(-1) > 0))
      .map((k) =>
        k === -1
          ? `under 0.2 sat/vB, not yet split ${formatSize(bandValue(k))}`
          : `${bandName(k)} sat/vB ${formatSize(bandValue(k))}`,
      );
    return [
      `${time()(p.time)}: Total ${formatSize(p.vsize)}`,
      ...(floor() > 0 ? [`Shown ${formatSize(a.shown)}`] : []),
      `Transactions ${groupDigits(p.count)}`,
      `Lowest accepted ${formatFeeRate(p.min_fee_rate / 1000)} sat/vB`,
      ...bands,
      `Arrived ${rateText(a.flow.entered)}`,
      `Mined ${rateText(a.flow.mined)}`,
      `Left otherwise ${rateText(a.flow.other)}`,
    ].join(", ");
  };
  const choose = (k: number) => {
    setFloor(k <= 0 || untrack(floor) === k ? 0 : k);
    setHover(-1);
  };

  return (
    <div class="mempool-plot">
      <div class="mempool-now" aria-hidden="true">
        <Show when={at()}>
          {(a) => (
            <>
              <span class="mempool-now__when num">{time()(a().point.time)}</span>
              <span class="mempool-now__total num">
                {formatSize(floor() > 0 ? a().shown : a().point.vsize)}
                <Show when={floor() > 0}>
                  <span class="mempool-now__of"> of {formatSize(a().point.vsize)}</span>
                </Show>
              </span>
              <span class="mempool-now__more num">
                {groupDigits(a().point.count)} tx, from{" "}
                {formatFeeRate(a().point.min_fee_rate / 1000)} sat/vB
              </span>
            </>
          )}
        </Show>
      </div>
      <div
        class="mempool-canvas"
        ref={box}
        tabindex="0"
        role="slider"
        aria-label={`The mempool's size by fee rate and its flow, ${props.interval.words}`}
        aria-describedby={`${id}-summary`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, props.h.points.length - 1)}
        aria-valuenow={index()}
        aria-valuetext={valueText()}
        onKeyDown={key}
        style={{ "--h": `${frame()?.height ?? 0}px` }}
      >
        <p id={`${id}-summary`} class="visually-hidden">
          {sizeSummary(props.h)} {flowSentence(props.h, props.interval.words) ?? ""}
        </p>
        <Show when={frame()}>
          {(f) => (
            <svg
              width={f().w}
              height={f().height}
              viewBox={`0 0 ${f().w} ${f().height}`}
              aria-hidden="true"
              class={hover() >= 0 ? "mempool-svg--picking" : undefined}
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={leave}
            >
              <defs>
                <pattern
                  id={`${id}-hatch`}
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <line class="mempool-hatch" x1="0" y1="0" x2="0" y2="6" />
                </pattern>
              </defs>
              <For each={[...f().yTicks, ...f().fTicks]}>
                {(t) => (
                  <g>
                    <line class="mempool-grid" x1={f().ml} x2={f().w - f().mr} y1={t.y} y2={t.y} />
                    <text class="mempool-label" x={f().ml - 6} y={t.y + 4} text-anchor="end">
                      {t.label}
                    </text>
                  </g>
                )}
              </For>
              <text class="mempool-strip" x={f().ml} y={f().flowTop - 12}>
                {f().strip}
              </text>
              <Show when={f().hatch}>
                {(hz) => (
                  <>
                    <rect
                      x={hz().x}
                      y={f().sizeTop}
                      width={Math.max(0, hz().w)}
                      height={f().sizeBottom - f().sizeTop}
                      fill={`url(#${id}-hatch)`}
                    />
                    <rect
                      x={hz().x}
                      y={f().flowTop}
                      width={Math.max(0, hz().w)}
                      height={f().flowBottom - f().flowTop}
                      fill={`url(#${id}-hatch)`}
                    />
                    <Show when={hz().w > f().hatchLabel}>
                      <text class="mempool-label" x={hz().x + 8} y={f().sizeTop + 16}>
                        {NO_DATA}
                      </text>
                    </Show>
                  </>
                )}
              </Show>
              <For each={f().layers}>
                {(l, k) => (
                  <path
                    class={["mempool-layer", { "mempool-layer--on": hover() === k() }]}
                    style={{ fill: swatch(l.band) }}
                    d={l.d}
                  />
                )}
              </For>
              <path class="mempool-flow-mined" d={f().mined} />
              <path class="mempool-flow-other" d={f().other} />
              <path class="mempool-flow-in" d={f().entered} />
              <line
                class="mempool-axis"
                x1={f().ml}
                x2={f().w - f().mr}
                y1={f().sizeBottom + 0.5}
                y2={f().sizeBottom + 0.5}
              />
              <line
                class="mempool-axis"
                x1={f().ml}
                x2={f().w - f().mr}
                y1={f().flowBottom + 0.5}
                y2={f().flowBottom + 0.5}
              />
              <Show
                when={f().ticks}
                fallback={
                  <>
                    <text class="mempool-label" x={f().ml} y={f().height - 4}>
                      {f().ends[0]}
                    </text>
                    <text
                      class="mempool-label"
                      x={f().w - f().mr}
                      y={f().height - 4}
                      text-anchor="end"
                    >
                      {f().ends[1]}
                    </text>
                  </>
                }
              >
                {(ts) => (
                  <For each={ts()}>
                    {(t) => (
                      <text class="mempool-label" x={t.x} y={f().height - 4} text-anchor={t.anchor}>
                        {t.label}
                      </text>
                    )}
                  </For>
                )}
              </Show>
              <Show when={props.s.x[index()]}>
                {(t) => (
                  <line
                    class="mempool-cross"
                    x1={Math.round(f().sx(t())) + 0.5}
                    x2={Math.round(f().sx(t())) + 0.5}
                    y1={f().sizeTop}
                    y2={f().flowBottom}
                  />
                )}
              </Show>
            </svg>
          )}
        </Show>
      </div>
      <div class="mempool-keys">
        <div class="mempool-keys__head">
          <span>By fee rate, sat/vB</span>
          <Show
            when={floor() > 0}
            fallback={
              <Show when={offered() > 0}>
                <button type="button" class="mempool-keys__all" onClick={() => choose(offered())}>
                  From {FEE_KEY_BOUNDS[offered()]} up
                </button>
              </Show>
            }
          >
            <button type="button" class="mempool-keys__all" onClick={() => choose(0)}>
              Show all
            </button>
          </Show>
        </div>
        <ul class="mempool-bands">
          <For each={rows()}>
            {(k) => (
              <li>
                <button
                  type="button"
                  class={[
                    "mempool-band",
                    {
                      "mempool-band--off": !shownBand(k),
                      "mempool-band--on": hoverBand() === k,
                      "mempool-band--empty": bandValue(k) === 0,
                    },
                  ]}
                  aria-pressed={floor() > 0 && k === floor() ? "true" : "false"}
                  title={k <= 0 ? "Show every band" : `Show ${bandName(k)} sat/vB and dearer`}
                  onClick={() => choose(k)}
                >
                  <span class="mempool-swatch" style={{ background: swatch(k) }} />
                  <span class="mempool-band__name">
                    {k === -1 ? "under 0.2, not split" : bandName(k)}
                  </span>
                  <span class="mempool-band__value num">{formatSize(bandValue(k))}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <ul class="mempool-flowkey" aria-hidden="true">
          <li>
            <span class="mempool-key mempool-key--in" />
            Arrived
            <span class="num">{rateText(at()?.flow.entered ?? 0)}</span>
          </li>
          <li>
            <span class="mempool-key mempool-key--mined" />
            Mined
            <span class="num">{rateText(at()?.flow.mined ?? 0)}</span>
          </li>
          <li>
            <span class="mempool-key mempool-key--other" />
            Left otherwise
            <span class="num">{rateText(at()?.flow.other ?? 0)}</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Every stored point as a row, newest first, behind a disclosure under the panel, so opening it
 * never changes the panel's height. It renders only once opened.
 */
function FiguresTable(props: { h: History; s: Series; interval: Interval }) {
  const [open, setOpen] = createSignal(false);
  const per = () => props.h.step / 60;
  const perSecond = (vb: number) => groupDigits(Math.round(vb / 60));
  const columns = (): Column<number>[] => {
    const at = pointTime(props.h.step);
    const p = (i: number) => props.h.points[i];
    const unsplit = props.s.unsplit;
    return [
      { header: "Time, UTC", cell: (i) => at(p(i)?.time ?? 0).replace(/ UTC$/, "") },
      { header: "Total, vB", numeric: true, cell: (i) => groupDigits(p(i)?.vsize ?? 0) },
      {
        header: "Transactions",
        numeric: true,
        cell: (i) => groupDigits(Math.round(p(i)?.count ?? 0)),
      },
      {
        header: "Lowest accepted, sat/vB",
        numeric: true,
        cell: (i) => formatFeeRate((p(i)?.min_fee_rate ?? 0) / 1000),
      },
      // A point stands for several minutes past two hours: say how many were seen.
      ...(per() > 1
        ? [
            {
              header: "Minutes recorded",
              numeric: true,
              cell: (i: number) => `${p(i)?.samples ?? 0} of ${per()}`,
            },
          ]
        : []),
      ...Array.from({ length: FEE_BANDS }, (_, j) => FEE_BANDS - 1 - j).map((k) => ({
        header: `${bandName(k)} sat/vB`,
        numeric: true,
        cell: (i: number) => formatSize(props.s.bands[k]?.[i] ?? 0),
      })),
      ...(unsplit
        ? [
            {
              header: "under 0.2 sat/vB, not yet split",
              numeric: true,
              cell: (i: number) => formatSize(unsplit[i] ?? 0),
            },
          ]
        : []),
      { header: "Arrived, vB/s", numeric: true, cell: (i) => perSecond(p(i)?.in_vsize ?? 0) },
      { header: "Mined, vB/s", numeric: true, cell: (i) => perSecond(p(i)?.mined_vsize ?? 0) },
      {
        header: "Left otherwise, vB/s",
        numeric: true,
        cell: (i) => {
          const q = p(i);
          return perSecond(Math.max(0, (q?.out_vsize ?? 0) - (q?.mined_vsize ?? 0)));
        },
      },
    ];
  };
  const label = () => `The mempool's size by fee rate and its flow, ${props.interval.words}`;
  return (
    <details class="more mempool-figures-table" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary class="more__summary">Show the figures</summary>
      <Show when={open()}>
        {/* It scrolls, so it takes focus: the keyboard can scroll it too. */}
        <div
          class="mempool-table"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region must take focus to be scrolled by keyboard
          tabindex="0"
          role="region"
          aria-label={`${label()}, figures`}
        >
          <DataTable
            caption={label()}
            columns={columns()}
            rows={Array.from(
              { length: props.h.points.length },
              (_, i) => props.h.points.length - 1 - i,
            )}
          />
        </div>
      </Show>
    </details>
  );
}
