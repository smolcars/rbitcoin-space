// A time-series chart in SVG: lines, areas, steps, percentile bands and stacked shares, with a
// readout that follows the pointer, the finger or the arrow keys (docs/FRONTEND.md "Charts").
// The default export so pages load it with lazy().
import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { FEE_KEY_BOUNDS } from "../../lib/format";
import { onNetwork } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { type Column, DataTable } from "../DataTable";
import { Link } from "../Link";
import {
  areaPath,
  extent,
  layerAt,
  linePath,
  maxGap,
  nearestIndex,
  stackLayout,
  type Value,
} from "./geometry";
import {
  describeSeries,
  formatDay,
  linearAxis,
  logAxis,
  type Scale,
  scale,
  timeTicks,
  endLabels,
} from "./scale";
import "./Chart.css";

export interface ChartAxis {
  /** Tick labels. */
  format: (v: number) => string;
  /** A log scale; `"auto"` when the data spans more than three decades. */
  log?: boolean | "auto";
  /** Keep 0 in view (linear only). */
  zero?: boolean;
  /** A fixed domain, such as `[0, 1]` for shares. */
  domain?: readonly [number, number];
  /** Fee rates: the fee scale's colors run along the axis, as the fee key. */
  fee?: boolean;
}

export interface ChartSeries {
  name: string;
  values: readonly Value[];
  /** `step-area`: a step with the area under it, for counts that change at a moment. */
  draw: "line" | "area" | "step" | "step-area";
  /** Which value axis; `right` needs the chart's `right` axis. */
  axis?: "left" | "right";
  /** 1 is the main series (solid, text color), 2 a second one (dashed, muted). */
  tone?: 1 | 2;
  /** The value in the readout and the figures. */
  format: (v: number) => string;
  /**
   * The unit `format` leaves out: the readout writes it after the figure, the figures table in
   * its header ("Capacity, BTC"), so its cells are bare numbers.
   */
  unit?: string;
  /**
   * Its points are samples, the moments something was looked at: each is marked with a dot when
   * they stand {@link MARK_SPACING} px or more apart, so a line between two reads as two looks.
   */
  marks?: boolean;
  /** A step holds its last value on to this time (a balance that has not changed since). */
  until?: number;
}

/** A band between two series, such as the 10th to 90th percentile. Bands lie under the lines. */
export interface ChartBand {
  name: string;
  lo: readonly Value[];
  hi: readonly Value[];
  /** 1 is the outer, paler band, 2 the inner one. */
  tone?: 1 | 2;
  format: (v: number) => string;
  /** As a series' `unit`: once after the range in the readout, in the figures' header. */
  unit?: string;
  /** A shorter name for the figures' header on a phone ("Middle 80%"). */
  narrow?: string;
}

/**
 * Where the layers change how they divide the same total at one moment (a change of bookkeeping,
 * not of the data): at `index`, the run arrives at `before` and leaves at `after` (one value per
 * layer, each the point's own values when absent), changing on vertical edges, so the top of the
 * stack never moves. Only the drawing changes: the readout and the figures keep the point's own.
 */
export interface ChartJoin {
  index: number;
  before?: readonly number[];
  after?: readonly number[];
}

/** One stacked layer on the left axis, the first at the bottom: shares (0–1) or amounts. */
export interface ChartLayer {
  name: string;
  values: readonly Value[];
  /** A fee band (1–10): the layer is that band's fee color, for amounts by fee rate. */
  fee?: number;
  /** A mining pool's place (1–6, 0 for the rest): its categorical colour (`--pool-n`). */
  pool?: number;
  /** A shorter name for the readout, where the key says the rest; `name` is read aloud. */
  short?: string;
  /**
   * Held by only some points (the lowest band before it was split): read out last, and only at a
   * point that has it, its place kept so the plot never moves.
   */
  rare?: boolean;
}

/** A figure the readout and the table show at each point, without drawing it. */
export interface ChartNote {
  name: string;
  values: readonly Value[];
  format: (v: number) => string;
}

export interface ChartProps {
  /** What the chart shows, as its accessible name: "Hashrate and difficulty, last year". */
  label: string;
  /** The points' times, unix seconds, ascending. */
  x: readonly number[];
  /** The time range drawn; the points' extent when not given. */
  domain?: readonly [number, number] | undefined;
  /**
   * The earliest time the data reaches (docs/API.md "Coverage"). The part of `domain` before it
   * is hatched and says no data is stored there, rather than showing a false zero.
   */
  dataFrom?: number | undefined;
  left: ChartAxis;
  right?: ChartAxis;
  series?: readonly ChartSeries[];
  bands?: readonly ChartBand[];
  layers?: readonly ChartLayer[];
  /** A layer's value in the readout and the figures. */
  layerFormat?: (v: number) => string;
  /** Figures read out after the series, not drawn: a count beside a size. */
  notes?: readonly ChartNote[];
  /**
   * The longest step between neighbouring points that is still one line, when the data has a
   * fixed step: wider is a gap. Three times the median step when not given.
   */
  gap?: number | undefined;
  /** Vertical joins between the layers' bookkeepings ({@link ChartJoin}). */
  joins?: readonly ChartJoin[] | undefined;
  /** How a point's time reads: a day by default. */
  time?: (t: number) => string;
  /** Replaces the summary written from the series. */
  summary?: string;
  /** Plot height in px. */
  height?: number;
  /**
   * Where a point leads (a path from `paths`), when each point is an item of its own: a click,
   * a second tap on the point a finger picked, or Enter opens it, and its row in the figures links
   * to it.
   */
  href?: (i: number) => string | undefined;
}

/** How far from the picked point, in px, a second tap still means that point: half a thumb's
 * target (`--touch`) either side. */
const TAP_SLOP = 22;
/** Samples this far apart on screen, or farther, are each marked (`ChartSeries.marks`). */
const MARK_SPACING = 24;

const MARGIN = { top: 10, bottom: 26, left: 66, right: 14, rightAxis: 58 };
/** Shades of the text color for stacked layers, alternating so neighbours stand apart. */
const LAYER_MIX = [72, 30, 56, 16, 44, 24, 64, 36, 10, 50];

/** A value as the readout says it, or that there is none. */
const reading = (v: Value | undefined, format: (v: number) => string) =>
  typeof v === "number" ? format(v) : "no data";

const layerMix = (k: number) => `${LAYER_MIX[k % LAYER_MIX.length] ?? 50}%`;

/** A layer's fill: its fee colour, its pool's colour, or its shade of series 1 (Chart.css). */
const layerStyle = (l: ChartLayer | undefined, k: number) => {
  if (l?.fee !== undefined) return { "--fill": `var(--fee-${l.fee})` };
  if (l?.pool !== undefined)
    return { "--fill": l.pool > 0 ? `var(--pool-${l.pool})` : "var(--pool-other)" };
  return { "--mix": layerMix(k) };
};
/** A layer with a colour of its own rather than a shade. */
const filled = (l: ChartLayer | undefined) => l?.fee !== undefined || l?.pool !== undefined;

/**
 * How wide the widest of `labels` draws as a tick label, in px: set in a hidden label beside the
 * plot, so the page's own fonts measure it (a canvas's `system-ui` is another face in Firefox).
 */
function labelWidth(labels: readonly string[], el: Element | undefined): number {
  if (!el || labels.length === 0) return 0;
  const ruler = document.createElement("span");
  ruler.className = "chart__label chart__ruler";
  el.append(ruler);
  let widest = 0;
  for (const label of labels) {
    ruler.textContent = label;
    widest = Math.max(widest, ruler.getBoundingClientRect().width);
  }
  ruler.remove();
  return widest;
}

/** How tall a tick label's line is, in px, measured as `labelWidth` measures. */
function labelHeight(el: Element | undefined): number {
  if (!el) return 0;
  const ruler = document.createElement("span");
  ruler.className = "chart__label chart__ruler";
  ruler.textContent = "0";
  el.append(ruler);
  const h = ruler.getBoundingClientRect().height;
  ruler.remove();
  return Math.ceil(h);
}

interface AxisFrame {
  scale: Scale;
  ticks: number[];
}

function valueAxis(
  axis: ChartAxis,
  values: readonly (readonly Value[])[],
  range: readonly [number, number],
  count: number,
): AxisFrame {
  if (axis.domain) {
    return { scale: scale(axis.domain, range), ticks: linearAxis(...axis.domain, count).ticks };
  }
  const [lo, hi] = extent(...values) ?? [0, 1];
  const log = axis.log === true || (axis.log === "auto" && lo > 0 && hi / lo > 1000);
  const { domain, ticks } = log ? logAxis(lo, hi) : linearAxis(lo, hi, count, axis.zero);
  return { scale: scale(domain, range, log), ticks };
}

export default function Chart(props: ChartProps) {
  const id = createUniqueId();
  const [width, setWidth] = createSignal(0);
  /** The point the reader is on; undefined shows the latest. */
  const [picked, setPicked] = createSignal<number>();
  const [hoverLayer, setHoverLayer] = createSignal(-1);
  const [figures, setFigures] = createSignal(false);
  const navigate = useNavigate();
  const network = useNetwork();
  /** The point picked before the press under way, and where the press began. */
  let press: { was: number | undefined; x: number } | undefined;
  let box: HTMLDivElement | undefined;

  onSettled(() => {
    if (!box) return undefined;
    const plot = box;
    setWidth(box.clientWidth);
    const ro = new ResizeObserver(() => setWidth(box?.clientWidth ?? 0));
    ro.observe(box);
    // A finger's reading stays after it lifts; a press anywhere outside the plot lets it go.
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !plot.contains(e.target)) {
        setPicked(undefined);
        setHoverLayer(-1);
      }
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      ro.disconnect();
      document.removeEventListener("pointerdown", away, true);
    };
  });

  const height = () => props.height ?? 240;
  const series = () => props.series ?? [];
  const bands = () => props.bands ?? [];
  const layers = () => props.layers ?? [];
  const notes = () => props.notes ?? [];

  const frame = createMemo(() => {
    const w = width();
    const xs = props.x;
    const first = xs[0];
    const last = xs.at(-1);
    if (w <= 0 || first === undefined || last === undefined) return undefined;
    const h = height();
    const bottom = h - MARGIN.bottom;
    const domain = props.domain ?? [first, first === last ? first + 1 : last];
    const yRange = [bottom, MARGIN.top] as const;
    const count = Math.max(2, Math.round((bottom - MARGIN.top) / 50));
    const stack = stackLayout(
      layers().map((l) => l.values),
      xs.length,
    );
    // Each join's values stacked as the layers are, for each layer's path.
    const stacked = (values: readonly number[] | undefined) => {
      if (!values) return undefined;
      let floor = 0;
      return layers().map((_, k) => {
        const lo = floor;
        floor += values[k] ?? 0;
        return { hi: floor, lo };
      });
    };
    const joinStacks = (props.joins ?? []).map((j) => ({
      index: j.index,
      in: stacked(j.before),
      out: stacked(j.after),
    }));
    const joinsOf = (k: number) =>
      new Map(joinStacks.map((j) => [j.index, { in: j.in?.[k], out: j.out?.[k] }] as const));
    const on = (side: "left" | "right") =>
      series()
        .filter((s) => (s.axis ?? "left") === side)
        .map((s) => s.values);
    const yl = valueAxis(
      props.left,
      [...on("left"), ...bands().flatMap((b) => [b.lo, b.hi]), ...stack.map((s) => s.hi)],
      yRange,
      count,
    );
    const yr = props.right ? valueAxis(props.right, on("right"), yRange, count) : undefined;
    // Each value axis as wide as its longest label needs (0.0000002 BTC on regtest), never
    // narrower than it always was: labels sit 10 px left of the plot and 8 px right of it.
    const room = (axis: ChartAxis | undefined, ticks: readonly number[]) =>
      Math.ceil(labelWidth(axis ? ticks.map((t) => axis.format(t)) : [], box)) + 1;
    const left = Math.max(MARGIN.left, room(props.left, yl.ticks) + 10);
    const right =
      w -
      (props.right && yr
        ? Math.max(MARGIN.rightAxis, room(props.right, yr.ticks) + 8)
        : MARGIN.right);
    const sx = scale(domain, [left, right]);
    const gap = props.gap ?? maxGap(xs);
    // A fixed step makes a lone point a real sample between known gaps: show it as a sliver.
    const sliver = props.gap === undefined ? 0 : 2;
    const yOf = (s: ChartSeries) => ((s.axis ?? "left") === "right" && yr ? yr : yl).scale;
    const floor = yl.scale(yl.scale.domain[0]);
    const time = timeTicks(domain[0], domain[1], Math.max(2, Math.floor((right - left) / 84)));
    // Too narrow for ticks a reader can place (a phone): the axis names its two ends instead.
    const ends = right - left < 420 ? endLabels(domain[0], domain[1], right - left) : undefined;
    // At a large text size the two may not fit side by side: each takes a line of its own, the
    // first from the drawing's left edge and the last to its right, both under the axes' zeros,
    // and the drawing grows by two lines.
    const under =
      ends === undefined ||
      labelWidth([ends[0]], box) + labelWidth([ends[1]], box) + 8 <= right - left
        ? 0
        : labelHeight(box);
    const covered = props.dataFrom;
    // The median step on screen: samples far apart are few, and each is marked.
    const spread = (maxGap(xs) / 3) * ((right - left) / Math.max(1, domain[1] - domain[0]));
    return {
      w,
      h: h + 2 * under,
      under,
      left,
      right,
      bottom,
      sx,
      yl,
      yr,
      yOf,
      time,
      ends,
      hatch:
        covered !== undefined && covered > domain[0]
          ? { x: left, w: Math.min(right, sx(covered)) - left }
          : undefined,
      layers: stack.map((s, k) => areaPath(xs, s.hi, s.lo, sx, yl.scale, gap, sliver, joinsOf(k))),
      stack,
      bands: bands().map((b) => areaPath(xs, b.hi, b.lo, sx, yl.scale, gap, sliver)),
      // An area only over an axis from zero: filled down to a cut axis, it would overstate a change.
      areas: series().map((s) =>
        (s.draw === "area" || s.draw === "step-area") && yOf(s).domain[0] === 0
          ? areaPath(
              xs,
              s.values,
              yOf(s).domain[0],
              sx,
              yOf(s),
              gap,
              sliver,
              undefined,
              s.draw === "step-area",
            )
          : "",
      ),
      lines: series().map(
        (s) =>
          linePath(xs, s.values, sx, yOf(s), gap, s.draw === "step" || s.draw === "step-area") +
          (s.draw === "step" && s.until !== undefined && typeof s.values.at(-1) === "number"
            ? `H${Math.round(sx(s.until) * 10) / 10}`
            : ""),
      ),
      marks: series().map((s) =>
        s.marks === true && spread >= MARK_SPACING
          ? xs.flatMap((x, i) => {
              const v = s.values[i];
              return typeof v === "number" ? [{ x: sx(x), y: yOf(s)(v) }] : [];
            })
          : [],
      ),
      floor,
      fee: props.left.fee === true ? feeStrip(yl.scale) : [],
    };
  });

  /** The latest point any series has data for. */
  const latest = () => {
    for (let i = props.x.length - 1; i >= 0; i--) {
      if (
        series().some((s) => typeof s.values[i] === "number") ||
        bands().some((b) => typeof b.hi[i] === "number") ||
        layers().some((l) => typeof l.values[i] === "number")
      )
        return i;
    }
    return props.x.length - 1;
  };
  const index = () => Math.min(picked() ?? latest(), props.x.length - 1);
  const when = (i: number) => {
    const t = props.x[i];
    return t === undefined ? "" : (props.time ?? formatDay)(t);
  };
  const layerFormat = (v: number) => (props.layerFormat ?? String)(v);

  /** The figures at one point, as the readout shows them, with the key each is drawn with. */
  const readings = (i: number) => [
    ...bands().map((b) => ({
      kind: `band-${b.tone ?? 1}`,
      band: false,
      style: undefined,
      layer: -1,
      name: b.name,
      short: undefined,
      value:
        typeof b.lo[i] !== "number" || typeof b.hi[i] !== "number"
          ? "no data"
          : `${b.format(b.lo[i] ?? 0)} to ${b.format(b.hi[i] ?? 0)}${b.unit === undefined ? "" : ` ${b.unit}`}`,
      unit: b.unit,
      narrow: b.narrow,
      bare: undefined,
      range:
        typeof b.lo[i] === "number" && typeof b.hi[i] === "number"
          ? ([b.format(b.lo[i] ?? 0), b.format(b.hi[i] ?? 0)] as const)
          : undefined,
      empty: false,
      rare: false,
    })),
    ...series().map((s) => ({
      kind: `line-${s.tone ?? 1}`,
      band: false,
      style: undefined,
      layer: -1,
      name: s.name,
      short: undefined,
      value:
        reading(s.values[i], s.format) +
        (s.unit !== undefined && typeof s.values[i] === "number" ? ` ${s.unit}` : ""),
      unit: s.unit,
      narrow: undefined,
      bare: reading(s.values[i], s.format),
      range: undefined,
      empty: false,
      rare: false,
    })),
    ...notes().map((s) => ({
      kind: "note",
      band: false,
      style: undefined,
      layer: -1,
      name: s.name,
      short: undefined,
      value: reading(s.values[i], s.format),
      unit: undefined,
      narrow: undefined,
      bare: undefined,
      range: undefined,
      empty: false,
      rare: false,
    })),
    ...layers().map((l, k) => ({
      kind: filled(l) ? "fee" : "layer",
      band: l.fee !== undefined,
      style: layerStyle(l, k),
      layer: k,
      name: l.name,
      short: l.short,
      value: reading(l.values[i], layerFormat),
      unit: undefined,
      narrow: undefined,
      bare: undefined,
      range: undefined,
      empty: l.values[i] === 0,
      rare: l.rare === true,
    })),
  ];
  const valueText = () => {
    const i = index();
    return `${when(i)}: ${readings(i)
      .filter((r) => !(r.rare && r.empty))
      .map((r) => `${r.name} ${r.value}`)
      .join(", ")}`;
  };

  const summary = () =>
    props.summary ??
    [
      ...series().map((s) => describeSeries(s.name, props.x, s.values, s.format)),
      ...bands().map((b) => describeSeries(`${b.name}, upper`, props.x, b.hi, b.format)),
    ].join(" ");

  const pick = (e: PointerEvent) => {
    const f = frame();
    const el = e.currentTarget;
    if (!f || !(el instanceof Element)) return;
    const r = el.getBoundingClientRect();
    const i = nearestIndex(props.x, f.sx.invert(e.clientX - r.left));
    if (i >= 0) setPicked(i);
    setHoverLayer(layerAt(f.stack, i, f.yl.scale.invert(e.clientY - r.top)));
  };
  const open = (i: number | undefined) => {
    const to = i === undefined ? undefined : props.href?.(i);
    if (to !== undefined) navigate(onNetwork(network(), to));
  };
  const down = (e: PointerEvent) => {
    press = { was: picked(), x: e.clientX };
    pick(e);
  };
  // A press that ends where it began, on the point already picked (by the hover a mouse brings,
  // or a finger's first tap), opens it: the first tap only reads it, so a tap never navigates.
  const up = (e: PointerEvent) => {
    const f = frame();
    const el = e.currentTarget;
    const p = press;
    press = undefined;
    if (!props.href || !f || !p || p.was === undefined || !(el instanceof Element)) return;
    const at = f.sx(props.x[p.was] ?? Number.NaN) + el.getBoundingClientRect().left;
    if (Math.abs(e.clientX - p.x) <= TAP_SLOP && Math.abs(e.clientX - at) <= TAP_SLOP) open(p.was);
  };
  const leave = (e: PointerEvent) => {
    // A finger lifts: keep its reading, as a tap shows it.
    if (e.pointerType === "touch") return;
    setPicked(undefined);
    setHoverLayer(-1);
  };
  const key = (e: KeyboardEvent) => {
    const n = props.x.length;
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      PageDown: -10,
      PageUp: 10,
    };
    const step = steps[e.key];
    let next: number | undefined;
    if (step !== undefined) next = index() + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Enter") {
      open(index());
      return;
    } else if (e.key === "Escape") {
      setPicked(undefined);
      return;
    }
    if (next === undefined) return;
    e.preventDefault();
    setPicked(Math.max(0, Math.min(n - 1, next)));
  };

  // Times that say UTC say it once, in the header, so a phone's column is two short lines.
  const utc = () => props.x.some((_, i) => when(i).endsWith(" UTC"));
  // On a phone the time of day takes a line under the day, so the figures beside it fit; the day
  // breaks before its year only where even that is too wide (the widest fonts, at 320 px).
  const cellTime = (i: number) => {
    const [day = "", clock] = when(i).replace(/ UTC$/, "").split(", ");
    const cut = day.lastIndexOf(" ");
    return (
      <>
        <Show when={cut > 0} fallback={day}>
          <span class="chart__nowrap">{day.slice(0, cut)}</span>{" "}
          <span class="chart__nowrap">{day.slice(cut + 1)}</span>
        </Show>
        <Show when={clock}>
          {(c) => (
            <>
              {/* The comma goes where the time of day takes its own line. */}
              <span class="chart__when-comma">,</span>{" "}
              <span class="chart__nowrap chart__when-clock">{c()}</span>
            </>
          )}
        </Show>
      </>
    );
  };
  const columns = () => [
    {
      header: utc() ? "Time, UTC" : "Time",
      cell: (i: number) => (
        <Show when={props.href?.(i)} fallback={cellTime(i)}>
          {(to) => <Link href={to()}>{cellTime(i)}</Link>}
        </Show>
      ),
    },
    ...readings(0).map((r, k) => {
      const column: Column<number> = {
        header: r.unit === undefined ? r.name : `${r.name}, ${r.unit}`,
        numeric: true,
        cell: (i: number) => {
          const at = readings(i)[k];
          // A range may break before its upper end on a phone, never inside a figure.
          return at?.range ? (
            <span class="chart__range">
              <span class="chart__nowrap">{`${at.range[0]} to`}</span>{" "}
              <span class="chart__nowrap">{at.range[1]}</span>
            </span>
          ) : (
            (at?.bare ?? at?.value ?? "")
          );
        },
      };
      if (r.narrow !== undefined) {
        column.short = r.unit === undefined ? r.narrow : `${r.narrow}, ${r.unit}`;
      }
      return column;
    }),
  ];

  return (
    <figure class="chart">
      <div class="chart__readout" aria-hidden="true">
        <span class="chart__when num">{when(index())}</span>
        <ul class="chart__values">
          <For keyed={false} each={readings(index())}>
            {(r) => (
              <li
                class={[
                  "chart__value",
                  {
                    "chart__value--on": r().layer >= 0 && r().layer === hoverLayer(),
                    "chart__value--empty": r().empty,
                    "chart__value--band": r().band,
                    "chart__value--rare": r().rare,
                  },
                ]}
              >
                <Show when={r().kind !== "note"}>
                  <span class={`chart__key chart__key--${r().kind}`} style={r().style} />
                </Show>
                <span class="chart__name">{r().short ?? r().name}</span>
                <span class="chart__figure num">{r().value}</span>
              </li>
            )}
          </For>
          {/* A narrow chart names one fee band at a time: its line is held for it, saying how. */}
          <Show when={layers().some((l) => l.fee !== undefined)}>
            <li class="chart__value chart__hint">Tap a layer to name it</li>
          </Show>
        </ul>
      </div>
      <div
        class={["chart__plot", { "chart__plot--links": props.href !== undefined }]}
        ref={box}
        style={{ "--h": `${frame()?.h ?? height()}px` }}
        tabindex="0"
        role="slider"
        aria-label={props.label}
        aria-describedby={`${id}-summary`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, props.x.length - 1)}
        aria-valuenow={index()}
        aria-valuetext={valueText()}
        onKeyDown={key}
      >
        <Show when={frame()}>
          {(f) => (
            <svg
              class="chart__svg"
              width={f().w}
              height={f().h}
              viewBox={`0 0 ${f().w} ${f().h}`}
              aria-hidden="true"
              onPointerMove={pick}
              onPointerDown={down}
              onPointerUp={up}
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
                  <line class="chart__hatch-line" x1="0" y1="0" x2="0" y2="6" />
                </pattern>
              </defs>
              <For each={f().yl.ticks}>
                {(t) => (
                  <g class="chart__tick">
                    <line
                      class="chart__grid"
                      x1={f().left}
                      x2={f().right}
                      y1={f().yl.scale(t)}
                      y2={f().yl.scale(t)}
                    />
                    <text
                      class="chart__label"
                      x={f().left - 10}
                      y={f().yl.scale(t)}
                      text-anchor="end"
                      dy="0.32em"
                    >
                      {props.left.format(t)}
                    </text>
                  </g>
                )}
              </For>
              <Show when={f().yr}>
                {(yr) => (
                  <For each={yr().ticks}>
                    {(t) => (
                      <text
                        class="chart__label chart__label--right"
                        x={f().right + 8}
                        y={yr().scale(t)}
                        dy="0.32em"
                      >
                        {props.right?.format(t)}
                      </text>
                    )}
                  </For>
                )}
              </Show>
              <For each={f().fee}>
                {(b) => (
                  <rect
                    class="chart__fee"
                    x={f().left - 5}
                    width="3"
                    y={b.y}
                    height={b.h}
                    style={{ fill: `var(--fee-${b.band})` }}
                  />
                )}
              </For>
              <Show when={f().hatch}>
                {(hatch) => (
                  <g class="chart__nodata">
                    <rect
                      x={hatch().x}
                      y={MARGIN.top}
                      width={Math.max(0, hatch().w)}
                      height={f().bottom - MARGIN.top}
                      fill={`url(#${id}-hatch)`}
                    />
                    <Show when={hatch().w > 110}>
                      <text
                        class="chart__nodata-text"
                        x={hatch().x + hatch().w / 2}
                        y={(f().bottom + MARGIN.top) / 2}
                        text-anchor="middle"
                      >
                        No data stored
                      </text>
                    </Show>
                  </g>
                )}
              </Show>
              <For each={f().layers}>
                {(d, k) => (
                  <path
                    class={[
                      "chart__layer",
                      {
                        "chart__layer--fee": filled(layers()[k()]),
                        "chart__layer--on": hoverLayer() === k(),
                      },
                    ]}
                    d={d}
                    style={layerStyle(layers()[k()], k())}
                  />
                )}
              </For>
              <For each={f().bands}>
                {(d, k) => (
                  <path class={`chart__band chart__band--${bands()[k()]?.tone ?? 1}`} d={d} />
                )}
              </For>
              <For each={f().areas}>{(d) => <path class="chart__area" d={d} />}</For>
              <For each={f().lines}>
                {(d, k) => (
                  <path class={`chart__line chart__line--${series()[k()]?.tone ?? 1}`} d={d} />
                )}
              </For>
              <For each={f().marks}>
                {(points, k) => (
                  <For each={points}>
                    {(p) => (
                      <circle
                        class={`chart__mark chart__mark--${series()[k()]?.tone ?? 1}`}
                        cx={p.x}
                        cy={p.y}
                        r="2.5"
                      />
                    )}
                  </For>
                )}
              </For>
              <line
                class="chart__axis"
                x1={f().left}
                x2={f().right}
                y1={f().bottom}
                y2={f().bottom}
              />
              <Show
                when={f().ends}
                fallback={
                  <For each={f().time.ticks}>
                    {(t) => (
                      <text
                        class="chart__label"
                        x={f().sx(t)}
                        y={f().bottom + 18}
                        text-anchor="middle"
                      >
                        {f().time.label(t)}
                      </text>
                    )}
                  </For>
                }
              >
                {(ends) => (
                  <>
                    <text
                      class="chart__label"
                      x={f().under > 0 ? 0 : f().left}
                      y={f().under > 0 ? f().bottom + 1.2 * f().under : f().bottom + 18}
                      text-anchor="start"
                    >
                      {ends()[0]}
                    </text>
                    <text
                      class="chart__label"
                      x={f().under > 0 ? f().w : f().right}
                      y={f().under > 0 ? f().bottom + 2.2 * f().under : f().bottom + 18}
                      text-anchor="end"
                    >
                      {ends()[1]}
                    </text>
                  </>
                )}
              </Show>
              <Show when={props.x[index()]}>
                {(t) => (
                  <g class="chart__cursor">
                    <line x1={f().sx(t())} x2={f().sx(t())} y1={MARGIN.top} y2={f().bottom} />
                    <For each={series()}>
                      {(s) => (
                        <Show when={typeof s.values[index()] === "number"}>
                          <circle
                            class={`chart__dot chart__dot--${s.tone ?? 1}`}
                            cx={f().sx(t())}
                            cy={f().yOf(s)(s.values[index()] ?? 0)}
                            r="3.5"
                          />
                        </Show>
                      )}
                    </For>
                  </g>
                )}
              </Show>
            </svg>
          )}
        </Show>
      </div>
      <figcaption class="chart__caption">
        <p id={`${id}-summary`} class="visually-hidden">
          {summary()}
        </p>
        <details class="chart__figures" onToggle={(e) => setFigures(e.currentTarget.open)}>
          <summary>Show the figures</summary>
          <Show when={figures()}>
            {/* It scrolls, so it takes focus: the keyboard can scroll it too. */}
            <div
              class="chart__table"
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region must take focus to be scrolled by keyboard
              tabindex="0"
              role="region"
              aria-label={`${props.label}, figures`}
            >
              <DataTable
                caption={props.label}
                columns={columns()}
                rows={Array.from({ length: props.x.length }, (_, i) => props.x.length - 1 - i)}
                {...(props.href ? { rowHref: props.href } : {})}
              />
            </div>
          </Show>
        </details>
      </figcaption>
    </figure>
  );
}

/** The fee scale along a fee-rate axis: one strip per band, where the axis shows it. */
function feeStrip(sy: Scale): { band: number; y: number; h: number }[] {
  const [lo, hi] = sy.domain;
  return FEE_KEY_BOUNDS.flatMap((from, k) => {
    const a = Math.max(k === 0 ? lo : from, lo);
    const b = Math.min(FEE_KEY_BOUNDS[k + 1] ?? hi, hi);
    if (b <= a) return [];
    const y = sy(b);
    return [{ band: k + 1, y, h: sy(a) - y }];
  });
}
