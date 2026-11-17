// The mempool's history (`/app/mempool/history/:interval`, docs/FRONTEND.md "Mempool history"):
// its shape, a check, the intervals, and what the page says about it. Pure.
import { formatMoment } from "../../components/chart/scale";
import {
  FEE_BANDS,
  FEE_KEY_BOUNDS,
  formatSize,
  groupDigits,
  UNSPLIT_BANDS,
  widenBands,
} from "../../lib/format";

export const INTERVALS = [
  { id: "2h", label: "2 h", words: "the last 2 hours" },
  { id: "24h", label: "24 h", words: "the last 24 hours" },
  { id: "1w", label: "1 w", words: "the last week" },
  { id: "1m", label: "1 m", words: "the last month" },
  { id: "3m", label: "3 m", words: "the last 3 months" },
  { id: "6m", label: "6 m", words: "the last 6 months" },
  { id: "1y", label: "1 y", words: "the last year" },
  { id: "2y", label: "2 y", words: "the last 2 years" },
  { id: "3y", label: "3 y", words: "the last 3 years" },
  { id: "4y", label: "4 y", words: "the last 4 years" },
  { id: "all", label: "All", words: "all of history" },
] as const;

export type Interval = (typeof INTERVALS)[number];
export const DEFAULT_INTERVAL = "24h";

/** The interval a `?interval=` value names; the default for anything else. */
export function parseInterval(value: unknown): Interval {
  const id: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  return (
    INTERVALS.find((p) => p.id === id) ??
    INTERVALS.find((p) => p.id === DEFAULT_INTERVAL) ??
    INTERVALS[1]
  );
}

export interface Point {
  time: number;
  samples: number;
  count: number;
  vsize: number;
  fees: number;
  /** sat per 1,000 vB */
  min_fee_rate: number;
  /** vB in each of the ten fee bands, cheapest first */
  bands: number[];
  in_count: number;
  in_vsize: number;
  out_count: number;
  out_vsize: number;
  mined_count: number;
  mined_vsize: number;
}

export interface History {
  interval: string;
  from: number;
  to: number;
  step: number;
  first: number | null;
  minutes: number;
  sampled: number;
  complete: boolean;
  points: Point[];
}

const NUMBERS = [
  "time",
  "samples",
  "count",
  "vsize",
  "fees",
  "min_fee_rate",
  "in_count",
  "in_vsize",
  "out_count",
  "out_vsize",
  "mined_count",
  "mined_vsize",
] as const;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isPoint(v: unknown): v is Point {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  const bands = p["bands"];
  return (
    NUMBERS.every((k) => finite(p[k])) &&
    Array.isArray(bands) &&
    // Ten for a minute stored before the lowest band was split (widenBands), else twelve.
    (bands.length === FEE_BANDS || bands.length === UNSPLIT_BANDS) &&
    bands.every((b) => finite(b))
  );
}

/** Whether a reply is a history answer the page can draw. */
export function isHistory(v: unknown): v is History {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  const points = h["points"];
  return (
    finite(h["from"]) &&
    finite(h["to"]) &&
    finite(h["step"]) &&
    h["step"] > 0 &&
    (h["first"] === null || finite(h["first"])) &&
    finite(h["minutes"]) &&
    finite(h["sampled"]) &&
    typeof h["complete"] === "boolean" &&
    Array.isArray(points) &&
    points.every((p) => isPoint(p))
  );
}

/** A share of the period, never rounded up to whole: `15%`, `under 1%`, `99%`. */
export function share(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 1) return "under 1%";
  return `${Math.floor(pct)}%`;
}

/**
 * How much of the period the answer holds, in one short line; undefined when every minute is there.
 * Say since when when recording began inside the period, or always for all of history (which owes
 * only the minutes since then), so a short history is not mistaken for a quiet mempool. One line
 * on a phone, so the chart below it is on the first screen.
 */
export const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
/** A moment without its year when the year is this one: the line must fit a phone in one. */
export const recentMoment = (t: number, now = Date.now() / 1000) => {
  const m = formatMoment(t);
  const year = String(new Date(now * 1000).getUTCFullYear());
  return m.replace(` ${year},`, ",");
};

export function coverageSentence(h: History, now = Date.now() / 1000): string | undefined {
  if (h.points.length === 0) return undefined;
  const pct = share(h.sampled, h.minutes);
  if (h.first !== null && h.interval === "all") {
    const from = recentMoment(h.first, now);
    return h.complete
      ? `Every minute recorded since ${from}.`
      : `${cap(pct)} recorded, since ${from}.`;
  }
  if (h.complete) return undefined;
  if (h.first !== null && h.first > h.from) {
    return `${cap(pct)} recorded, from ${recentMoment(h.first, now)}.`;
  }
  return `${cap(pct)} recorded, with gaps while this server was off.`;
}

/**
 * Where the hatch for "not recorded yet" ends: the start of the step that holds the first record,
 * since that step's point is drawn at its start; undefined when that is not inside the period.
 */
export function dataFrom(h: History): number | undefined {
  if (h.first === null) return undefined;
  const start = Math.floor(h.first / h.step) * h.step;
  return start > h.from ? start : undefined;
}

/** How a point's time reads: to the minute for steps under a day, else the day. */
export function pointTime(step: number): (t: number) => string {
  return step < 86_400 ? formatMoment : (t) => formatMoment(t).replace(/, \d\d:\d\d UTC$/, "");
}

/** The figures the charts draw, one array per series, `null` nowhere: a missing step has no point. */
export function seriesOf(h: History) {
  const ps = h.points;
  const perSecond = (vb: number) => vb / 60;
  const wide = ps.map((p) => widenBands(p.bands));
  // A point stored before the lowest band was split keeps all under 0.2 whole, in a layer of its
  // own below the twelve: one column per point, that layer first, then the twelve bands.
  const merged = (b: readonly number[]) => [
    (b[0] ?? 0) + (b[1] ?? 0) + (b[2] ?? 0),
    0,
    0,
    0,
    ...b.slice(3),
  ];
  const cols = wide.map((w) =>
    w.unsplit ? [w.bands[0] ?? 0, 0, ...w.bands.slice(1)] : [0, ...w.bands],
  );
  // Where the bookkeeping changes, the chart joins on a vertical edge at one point, the total
  // unchanged across it: unsplit to split arrives at the split point as one layer; split to
  // unsplit (a later row summed with one from before) leaves the last split point as one layer.
  // Only the drawing joins: each point's figures stay as recorded.
  const joins: { index: number; before?: number[]; after?: number[] }[] = [];
  for (let i = 1; i < wide.length; i++) {
    const before = wide[i - 1]?.unsplit === true;
    const now = wide[i]?.unsplit === true;
    if (before && !now) joins.push({ index: i, before: merged(wide[i]?.bands ?? []) });
    if (!before && now) joins.push({ index: i - 1, after: merged(wide[i - 1]?.bands ?? []) });
  }
  const any = wide.some((w) => w.unsplit);
  return {
    x: ps.map((p) => p.time),
    vsize: ps.map((p) => p.vsize),
    count: ps.map((p) => p.count),
    floor: ps.map((p) => p.min_fee_rate / 1000),
    samples: ps.map((p) => p.samples),
    bands: Array.from({ length: FEE_BANDS }, (_, k) => cols.map((c) => c[k + 1] ?? 0)),
    unsplit: any ? cols.map((c) => c[0] ?? 0) : undefined,
    // In the layers' order, the unsplit layer first: only when there is one.
    joins: any ? joins : [],
    entered: ps.map((p) => perSecond(p.in_vsize)),
    mined: ps.map((p) => perSecond(p.mined_vsize)),
    otherwise: ps.map((p) => perSecond(Math.max(0, p.out_vsize - p.mined_vsize))),
  };
}

/**
 * The flow over the whole answer, weighted by the minutes behind each point: what came in, what
 * blocks took and what left otherwise, in vB a second, and whether that filled or drained it.
 */
export function netFlow(
  h: History,
): { entered: number; mined: number; otherwise: number; net: number } | undefined {
  let n = 0;
  let entered = 0;
  let mined = 0;
  let out = 0;
  for (const p of h.points) {
    n += p.samples;
    entered += p.in_vsize * p.samples;
    mined += p.mined_vsize * p.samples;
    out += p.out_vsize * p.samples;
  }
  if (n === 0) return undefined;
  const s = 60 * n;
  return {
    entered: entered / s,
    mined: mined / s,
    otherwise: Math.max(0, out - mined) / s,
    net: (entered - out) / s,
  };
}

/** A rate of virtual size: `2 340 vB/s`, `14.6 kvB/s`. */
export const rateText = (vbs: number): string => `${formatSize(vbs, "vB")}/s`;

/** The flow in one sentence: whether the mempool filled or drained, and by how much. */
export function flowSentence(h: History, words: string): string | undefined {
  const f = netFlow(h);
  if (!f) return undefined;
  const parts = `${rateText(f.entered)} arrived, blocks took ${rateText(f.mined)} and ${rateText(f.otherwise)} left otherwise`;
  // Under 1 vB/s either way is noise against thousands arriving.
  if (Math.abs(f.net) < 1) return `Over ${words}, ${parts}: the mempool held steady.`;
  const dir = f.net > 0 ? "filled" : "drained";
  return `Over ${words}, ${parts}: the mempool ${dir} by ${rateText(Math.abs(f.net))} on average.`;
}

/** The size chart in words, for a screen reader. */
export function sizeSummary(h: History): string {
  const ps = h.points;
  const first = ps[0];
  const last = ps.at(-1);
  if (!first || !last) return "No data.";
  const at = pointTime(h.step);
  if (ps.length === 1) {
    return `The mempool held ${formatSize(first.vsize)} in ${groupDigits(first.count)} transactions at ${at(first.time)}.`;
  }
  const lo = ps.reduce((a, b) => (b.vsize < a.vsize ? b : a));
  const hi = ps.reduce((a, b) => (b.vsize > a.vsize ? b : a));
  return `The mempool went from ${formatSize(first.vsize)} at ${at(first.time)} to ${formatSize(last.vsize)} at ${at(last.time)}; smallest ${formatSize(lo.vsize)} at ${at(lo.time)}, largest ${formatSize(hi.vsize)} at ${at(hi.time)}.`;
}

/** A band's range as the key prints it, cheapest first: `under 0.12`, `0.2–0.3`, `10+`. */
export function bandName(k: number): string {
  const from = FEE_KEY_BOUNDS[k];
  const to = FEE_KEY_BOUNDS[k + 1];
  if (k === 0) return `under ${to ?? ""}`;
  return to === undefined ? `${from ?? ""}+` : `${from ?? ""}–${to}`;
}

/** A block's worth of virtual size. */
const BLOCK_VB = 1_000_000;

/**
 * The period's four figures: what waits now, how that changed and its peak, the flow, and the
 * cheapest band the dearest block's worth now reaches into (`deep`, -1 when less than a block
 * waits). The history keeps no block's lowest rate, so this is the honest stand-in for one.
 */
export function figures(h: History) {
  const ps = h.points;
  const first = ps[0];
  const last = ps.at(-1);
  if (!first || !last) return undefined;
  const peak = ps.reduce((a, b) => (b.vsize > a.vsize ? b : a));
  const bands = widenBands(last.bands).bands;
  let deep = -1;
  let acc = 0;
  for (let k = bands.length - 1; k >= 0; k--) {
    acc += bands[k] ?? 0;
    if (acc >= BLOCK_VB) {
      deep = k;
      break;
    }
  }
  return { last, peak, change: last.vsize - first.vsize, flow: netFlow(h), deep };
}

/** The flow reads in means over this many seconds when the answer is finer: about a block. */
export const FLOW_STEP = 600;
/** The longest run of missing steps drawn across rather than as a break. */
export const BRIDGE_STEPS = 5;

/**
 * The flow at each point in vB a second: what arrived, what blocks took and what left otherwise.
 * A minute holds one block or none, so a finer answer gives each point the mean of its ten
 * minutes, weighted by the minutes seen, else a block's minute dwarfs what arrives; coarser
 * answers are as recorded. A break in recording ends a mean, so none reaches across one, and the
 * values stand at the points' own times, so the flow breaks where the size does. `drawn` is the
 * same as steps: each value holds over its own step, the last of each run included, so the newest
 * value has width and is never a bare edge.
 */
export function flowPoints(h: History) {
  const step = Math.max(h.step, FLOW_STEP);
  const gap = h.step * (BRIDGE_STEPS + 1);
  const ps = h.points;
  let run = 0;
  const keys = ps.map((p, i) => {
    if (i > 0 && p.time - (ps[i - 1]?.time ?? p.time) > gap) run += 1;
    return `${run}:${Math.floor(p.time / step)}`;
  });
  const groups = new Map<string, { n: number; in: number; mined: number; other: number }>();
  for (const [i, p] of ps.entries()) {
    const key = keys[i] ?? "";
    const g = groups.get(key) ?? { n: 0, in: 0, mined: 0, other: 0 };
    g.n += p.samples;
    g.in += p.in_vsize * p.samples;
    g.mined += p.mined_vsize * p.samples;
    g.other += Math.max(0, p.out_vsize - p.mined_vsize) * p.samples;
    groups.set(key, g);
  }
  const mean = (pick: (g: { in: number; mined: number; other: number }) => number) =>
    keys.map((k) => {
      const g = groups.get(k);
      return g && g.n > 0 ? pick(g) / g.n / 60 : 0;
    });
  const entered = mean((g) => g.in);
  const mined = mean((g) => g.mined);
  const other = mean((g) => g.other);
  // `null` is a break: the paths never join across one, however near its neighbours stand.
  const drawn = {
    x: [] as number[],
    entered: [] as (number | null)[],
    mined: [] as (number | null)[],
    other: [] as (number | null)[],
  };
  const add = (t: number, i: number | null) => {
    drawn.x.push(t);
    drawn.entered.push(i === null ? null : (entered[i] ?? 0));
    drawn.mined.push(i === null ? null : (mined[i] ?? 0));
    drawn.other.push(i === null ? null : (other[i] ?? 0));
  };
  const runOf = (i: number) => keys[i]?.split(":")[0];
  for (const [i, p] of ps.entries()) {
    add(p.time, i);
    // The end of a run: its last value holds to the end of its step, inside the period, and
    // the next run starts after a break.
    if (runOf(i + 1) !== runOf(i)) {
      const end = Math.min(p.time + h.step, h.to);
      add(end, i);
      if (i + 1 < ps.length) add(end, null);
    }
  }
  return { step, entered, mined, other, drawn };
}

export type Series = ReturnType<typeof seriesOf>;
export type Flow = ReturnType<typeof flowPoints>;

/**
 * The band the filter offers to start from: the first above the cheap bulk, where nine tenths of
 * the latest point lie below. 0 when there is no such bulk, or nothing would be left above it.
 */
export function filterFrom(s: Series): number {
  const at = s.x.length - 1;
  if (at < 0) return 0;
  const bands = s.bands.map((b) => b[at] ?? 0);
  const unsplit = s.unsplit?.[at] ?? 0;
  const total = unsplit + bands.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  // A point from before the split holds all under 0.2 in one: a filter starts at 0.2 or above.
  const lowest = unsplit > 0 ? 3 : 1;
  let below = unsplit;
  for (let k = 0; k < bands.length; k++) {
    if (k >= lowest && below >= total * 0.9) return below < total ? k : 0;
    below += bands[k] ?? 0;
  }
  return 0;
}

/**
 * The stacked layers from band `floor` up (0 shows them all), in the order they stack: the
 * unsplit layer first where the answer has one, then the twelve. `band` is the key's index, -1
 * for the unsplit layer, which is all under 0.2 and so belongs to the view only when all is shown.
 */
export function layersFrom(s: Series, floor: number) {
  const all = [
    ...(s.unsplit ? [{ band: -1, values: s.unsplit }] : []),
    ...s.bands.map((values, k) => ({ band: k, values })),
  ];
  const keep = all.map((l) => (l.band === -1 ? floor === 0 : l.band >= floor));
  const pick = <T>(xs: readonly T[]) => xs.filter((_, i) => keep[i] === true);
  return {
    layers: pick(all),
    joins: s.joins.map((j) => ({
      index: j.index,
      before: j.before ? pick(j.before) : undefined,
      after: j.after ? pick(j.after) : undefined,
    })),
  };
}

/**
 * What the crosshair reads at point `i` in both strips: the point, what of it the shown bands
 * hold, and the flow there (the flow's values stand at the same points as the size's).
 */
export function crosshair(h: History, s: Series, f: Flow, i: number, floor: number) {
  const p = h.points[i];
  if (!p) return undefined;
  const shown =
    (floor === 0 ? (s.unsplit?.[i] ?? 0) : 0) +
    s.bands.reduce((sum, b, k) => (k >= floor ? sum + (b[i] ?? 0) : sum), 0);
  const flow = { entered: f.entered[i] ?? 0, mined: f.mined[i] ?? 0, other: f.other[i] ?? 0 };
  return { point: p, shown, flow };
}
