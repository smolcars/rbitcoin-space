// The mining routes' replies (docs/API.md "Mining"), the periods the page offers, and what the
// page computes from them. Pure.
import type { Coverage } from "../../lib/api";
import { sorted } from "../../components/chart/geometry";
import { formatDay, formatMoment } from "../../components/chart/scale";
import type { Network } from "../../lib/network";

const DAY = 86_400;
const WEEK = 7 * DAY;

export const PERIODS = [
  { id: "24h", label: "24 h", words: "the last 24 hours", seconds: DAY },
  { id: "1w", label: "1 w", words: "the last week", seconds: 7 * DAY },
  { id: "1m", label: "1 m", words: "the last 30 days", seconds: 30 * DAY },
  { id: "1y", label: "1 y", words: "the last year", seconds: 365 * DAY },
  { id: "all", label: "All", words: "all time", seconds: undefined },
] as const;

export type Period = (typeof PERIODS)[number];
export type PeriodId = Period["id"];
export const DEFAULT_PERIOD: PeriodId = "1w";

/** The period a `?period=` value names; the default for anything else. */
export function parsePeriod(value: unknown): Period {
  const id: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  return PERIODS.find((p) => p.id === id) ?? periodById(DEFAULT_PERIOD);
}

/** The period an answer's route names, if it names one. */
export function answeredPeriod(a: { path: string } | undefined): Period | undefined {
  return PERIODS.find((p) => a?.path.endsWith(`/${p.id}`));
}

export function periodById(id: PeriodId): Period {
  // PERIODS holds every id, so this always finds one.
  return PERIODS.find((p) => p.id === id) ?? PERIODS[1];
}

/**
 * The hashrate chart's interval. Each daily point is a 7-day average, so a day would be a single
 * point: the shortest the chart shows is a week.
 */
export const hashrateInterval = (p: Period): PeriodId => (p.id === "24h" ? "1w" : p.id);

/** Pool shares over time are weekly: shorter periods have one or two points, so no chart. */
export const sharesOverTime = (p: Period): boolean => p.id !== "24h" && p.id !== "1w";

/**
 * The time range a chart of the period draws, so a period the data does not fill shows where it
 * is missing: from the period's start to now (or the last point, if later). Undefined for all
 * time, which draws the data's own extent.
 */
export function periodDomain(
  p: Period,
  x: readonly number[],
  now: number,
): [number, number] | undefined {
  const first = x[0];
  const last = x.at(-1);
  if (p.seconds === undefined || first === undefined || last === undefined) return undefined;
  return [Math.min(first, now - p.seconds), Math.max(last, now)];
}

/** Block-series points by time (the server orders them by height), or undefined for none. */
export function byTime<T extends BlockPoint>(points: readonly T[] | undefined): T[] | undefined {
  return points && sorted(points, (a, b) => a.timestamp - b.timestamp || a.avgHeight - b.avgHeight);
}

/**
 * A pool's weekly points with the weeks it found no block filled in as zero: the route leaves
 * them out, and a chart would otherwise draw a line across them. Weeks before its first and
 * after its last stored week are not invented.
 */
export function fillWeeks(weeks: readonly PoolWeek[]): PoolWeek[] {
  const by = sorted(weeks, (a, b) => a.timestamp - b.timestamp);
  const first = by[0];
  const last = by.at(-1);
  if (!first || !last) return [];
  const at = new Map(by.map((w) => [w.timestamp, w]));
  const out: PoolWeek[] = [];
  for (let t = first.timestamp; t <= last.timestamp; t += WEEK) {
    out.push(at.get(t) ?? { timestamp: t, avgHashrate: 0, share: 0, poolName: first.poolName });
  }
  return out;
}

/** `reward-stats` sums at most a year of blocks. */
export const REWARD_MAX = 52_560;

// Reply shapes. Numbers the page reads are checked; text is rendered as text.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nums = (o: Obj, keys: readonly string[]) => keys.every((k) => isNum(o[k]));
const listOf =
  <T>(check: (v: unknown) => v is T) =>
  (v: unknown): v is T[] =>
    Array.isArray(v) && v.every((x) => check(x));

export interface Ranked {
  poolId: number;
  name: string;
  link: string;
  blockCount: number;
  rank: number;
  emptyBlocks: number;
  slug: string;
  /** The mean match rate of the pool's audited blocks in the period; null with none. */
  avgMatchRate?: number | null;
}

export interface Ranking {
  pools: Ranked[];
  blockCount: number;
  lastEstimatedHashrate: number | null;
  lastEstimatedHashrate3d: number | null;
  lastEstimatedHashrate1w: number | null;
}

const numOrNull = (v: unknown): boolean => v === null || isNum(v);

const isRanked = (v: unknown): v is Ranked =>
  isObj(v) &&
  nums(v, ["poolId", "blockCount", "rank", "emptyBlocks"]) &&
  typeof v["name"] === "string" &&
  typeof v["slug"] === "string" &&
  typeof v["link"] === "string" &&
  (v["avgMatchRate"] === undefined || numOrNull(v["avgMatchRate"]));

export const isRanking = (v: unknown): v is Ranking =>
  isObj(v) &&
  listOf(isRanked)(v["pools"]) &&
  isNum(v["blockCount"]) &&
  numOrNull(v["lastEstimatedHashrate"]) &&
  numOrNull(v["lastEstimatedHashrate1w"]);

export interface HashratePoint {
  timestamp: number;
  avgHashrate: number;
}
export interface Retarget {
  time: number;
  height: number;
  difficulty: number;
  adjustment: number;
}
export interface Hashrates {
  hashrates: HashratePoint[];
  difficulty: Retarget[];
  currentHashrate: number | null;
  currentDifficulty: number;
}

export const isHashrates = (v: unknown): v is Hashrates =>
  isObj(v) &&
  listOf((p): p is HashratePoint => isObj(p) && nums(p, ["timestamp", "avgHashrate"]))(
    v["hashrates"],
  ) &&
  listOf((p): p is Retarget => isObj(p) && nums(p, ["time", "height", "difficulty", "adjustment"]))(
    v["difficulty"],
  ) &&
  numOrNull(v["currentHashrate"]) &&
  isNum(v["currentDifficulty"]);

export interface PoolWeek {
  timestamp: number;
  avgHashrate: number;
  share: number;
  poolName: string;
}

export const isPoolWeeks = listOf(
  (p): p is PoolWeek =>
    isObj(p) && nums(p, ["timestamp", "avgHashrate", "share"]) && typeof p["poolName"] === "string",
);

export interface RewardStats {
  startBlock: number;
  endBlock: number;
  totalReward: string;
  totalFee: string;
  totalTx: string;
}

const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d{1,20}$/.test(v);

export const isRewardStats = (v: unknown): v is RewardStats =>
  isObj(v) &&
  nums(v, ["startBlock", "endBlock"]) &&
  isDigits(v["totalReward"]) &&
  isDigits(v["totalFee"]) &&
  isDigits(v["totalTx"]);

/** A point of a block series: the middle height and time of the blocks it averages. */
export interface BlockPoint {
  avgHeight: number;
  timestamp: number;
}

export const isPoints = (field: string) =>
  listOf((p): p is BlockPoint & Obj => isObj(p) && nums(p, ["avgHeight", "timestamp", field]));

export const RATE_KEYS = [
  "avgFee_0",
  "avgFee_10",
  "avgFee_25",
  "avgFee_50",
  "avgFee_75",
  "avgFee_90",
  "avgFee_100",
] as const;

export const isRatePoints = listOf(
  (p): p is BlockPoint & Record<(typeof RATE_KEYS)[number], number> =>
    isObj(p) && nums(p, ["avgHeight", "timestamp", ...RATE_KEYS]),
);

export const isSizes = (
  v: unknown,
): v is {
  sizes: (BlockPoint & { avgSize: number })[];
  weights: (BlockPoint & { avgWeight: number })[];
} => isObj(v) && isPoints("avgSize")(v["sizes"]) && isPoints("avgWeight")(v["weights"]);

export interface PoolStats {
  pool: {
    id: number;
    name: string;
    link: string;
    addresses: string[];
    regexes: string[];
    slug: string;
  };
  blockCount: { all: number; "24h": number; "1w": number };
  blockShare: { all: number; "24h": number; "1w": number };
  estimatedHashrate: number | null;
  totalReward: string;
}

const isPeriods = (v: unknown) => isObj(v) && nums(v, ["all", "24h", "1w"]);
const isStrings = listOf((s): s is string => typeof s === "string");

export const isPoolStats = (v: unknown): v is PoolStats => {
  if (!isObj(v)) return false;
  const p = v["pool"];
  return (
    isObj(p) &&
    isNum(p["id"]) &&
    typeof p["name"] === "string" &&
    typeof p["link"] === "string" &&
    typeof p["slug"] === "string" &&
    isStrings(p["addresses"]) &&
    isStrings(p["regexes"]) &&
    isPeriods(v["blockCount"]) &&
    isPeriods(v["blockShare"]) &&
    numOrNull(v["estimatedHashrate"]) &&
    isDigits(v["totalReward"])
  );
};

export interface PoolBlock {
  id: string;
  height: number;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  extras: { totalFees: number; medianFee: number | null; reward: number };
}

export const isPoolBlocks = listOf(
  (b): b is PoolBlock =>
    isObj(b) &&
    typeof b["id"] === "string" &&
    nums(b, ["height", "timestamp", "tx_count", "size", "weight"]) &&
    isObj(b["extras"]) &&
    nums(b["extras"], ["totalFees", "reward"]) &&
    numOrNull(b["extras"]["medianFee"]),
);

// What the page computes.

/**
 * Hashrate points and the difficulty in force at each, from the hashrate answer. Before the
 * first retarget in the answer, the difficulty is the one that retarget replaced; with no retarget
 * in the answer, it is the current one throughout.
 */
export function hashrateSeries(h: Hashrates): {
  x: number[];
  hashrate: number[];
  difficulty: (number | null)[];
} {
  const points = sorted(h.hashrates, (a, b) => a.timestamp - b.timestamp);
  const retargets = sorted(h.difficulty, (a, b) => a.time - b.time);
  const first = retargets[0];
  // No retarget in the answer: every point is in the current period.
  const before = first
    ? first.adjustment > 0
      ? first.difficulty / first.adjustment
      : null
    : h.currentDifficulty;
  let k = -1;
  const difficulty = points.map((p) => {
    while (k + 1 < retargets.length && (retargets[k + 1]?.time ?? Infinity) <= p.timestamp) k++;
    return k >= 0 ? (retargets[k]?.difficulty ?? null) : before;
  });
  return {
    x: points.map((p) => p.timestamp),
    hashrate: points.map((p) => p.avgHashrate),
    difficulty,
  };
}

export const OTHER_POOLS = "Other pools";

/**
 * Pools with a colour of their own, the same at every period and in every share graphic, so a
 * colour always names one pool: the twelve that reach a period's top six, over the last year and
 * all of history, as of November 2026. A period draws its own six largest of them, so the share
 * graphics agree with the table's top rows, and counts every other pool in "Other pools", in
 * grey; the table names them all.
 * shortcut: a fixed list, revise it when a pool outside it reaches a period's top six.
 */
export const COLOURED_POOLS = [
  "Foundry USA",
  "AntPool",
  "F2Pool",
  "ViaBTC",
  "SpiderPool",
  "MARA Pool",
  "Luxor",
  "SecPool",
  "Ocean.xyz",
  "Poolin",
  "BTC.com",
  "Binance Pool",
] as const;

/** How many pools a share graphic draws on their own; the rest are "Other pools". */
export const SHARES_DRAWN = 6;

/** A pool's colour, 1–12, or 0 for the grey every other pool shares. */
export function poolColour(name: string): number {
  return (COLOURED_POOLS as readonly string[]).indexOf(name) + 1;
}

/**
 * Weekly pool shares as stacked layers: the period's six largest pools that have a colour, the
 * biggest at the bottom, then every other pool as one grey layer. `ranked` is the period's table,
 * largest first, by blocks: when given, it picks and orders the six, so the chart agrees with the
 * table even where weeks of different sizes would rank the summed weekly shares otherwise.
 */
export function poolLayers(
  weeks: readonly PoolWeek[],
  ranked?: readonly string[],
): {
  x: number[];
  layers: { name: string; values: number[]; pool: number }[];
} {
  const x = sorted(new Set(weeks.map((w) => w.timestamp)), (a, b) => a - b);
  const at = new Map(x.map((t, i) => [t, i]));
  const totals = new Map<string, number>();
  for (const w of weeks) totals.set(w.poolName, (totals.get(w.poolName) ?? 0) + w.share);
  const order =
    ranked ??
    sorted(totals.entries(), (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  const named = order.filter((name) => poolColour(name) > 0).slice(0, SHARES_DRAWN);
  const layers = named.map((name) => ({
    name,
    values: x.map(() => 0),
    pool: poolColour(name),
  }));
  const index = new Map(named.map((n, i) => [n, i]));
  const rest = x.map(() => 0);
  for (const w of weeks) {
    const i = at.get(w.timestamp) ?? 0;
    const layer = layers[index.get(w.poolName) ?? -1];
    if (layer) layer.values[i] = (layer.values[i] ?? 0) + w.share;
    else rest[i] = (rest[i] ?? 0) + w.share;
  }
  // Any pool in the weeks but not drawn: the table can name a pool the weeks do not hold.
  if ([...totals.keys()].some((name) => !index.has(name))) {
    layers.push({ name: OTHER_POOLS, values: rest, pool: 0 });
  }
  return { x, layers };
}

/**
 * A pool's estimated hashrate over the period: its share of the blocks times the network's
 * hashrate over the same stretch (the blocks of the last 24 hours, of the last 7 days, the average
 * of the chart's points beyond).
 */
export function networkHashrate(
  p: Period,
  ranking: Ranking,
  hashrates: Hashrates | undefined,
): number | undefined {
  if (p.id === "24h") return ranking.lastEstimatedHashrate ?? undefined;
  if (p.id === "1w") return ranking.lastEstimatedHashrate1w ?? undefined;
  const points = hashrates?.hashrates ?? [];
  if (points.length === 0) return undefined;
  return points.reduce((sum, h) => sum + h.avgHashrate, 0) / points.length;
}

/**
 * The network's hashrate now: over the last 24 hours when the period is a day, else over the
 * last 7 days. By time, not a count of blocks, which reaches back days once blocks slow down.
 */
export function nowWindow(p: Period): {
  field: "lastEstimatedHashrate" | "lastEstimatedHashrate1w";
  words: string;
} {
  return p.id === "24h"
    ? { field: "lastEstimatedHashrate", words: "Over the last 24 hours" }
    : { field: "lastEstimatedHashrate1w", words: "Over the last 7 days" };
}

/** The figures of a period's rewards, in sats; undefined for a reply that is not whole numbers. */
export function rewardFigures(r: RewardStats): {
  blocks: number;
  reward: number;
  fees: number;
  subsidy: number;
  txs: number;
  feeShare: number;
  perBlock: number;
} {
  const reward = Number(r.totalReward);
  const fees = Number(r.totalFee);
  const blocks = Math.max(0, r.endBlock - r.startBlock + 1);
  return {
    blocks,
    reward,
    fees,
    subsidy: Math.max(0, reward - fees),
    txs: Number(r.totalTx),
    feeShare: reward > 0 ? fees / reward : 0,
    perBlock: blocks > 0 ? reward / blocks : 0,
  };
}

/**
 * What a reply's coverage says about the period asked for, as a sentence; undefined when the
 * data covers it. "Data from 3 Oct 2026 onward.".
 */
export function coverageNote(c: Coverage | undefined, p: Period): string | undefined {
  if (!c || c.complete) return undefined;
  if (c.fromTime === undefined) return `No blocks are stored for ${p.words} yet.`;
  // One short line, so the chart under it is on a phone's first screen; the hatch shows the rest.
  return `Data from ${formatDay(c.fromTime)} onward.`;
}

const NOTES: Record<Network, string | undefined> = {
  mainnet: undefined,
  signet:
    "Signet's blocks are signed by a small set of authorized signers, not won by competing miners. The pool list names none of them, so most blocks show as Unknown, and the hashrate says little about the network.",
  testnet4:
    "Testnet4 lets anyone mine a block at the minimum difficulty when none has been found for 20 minutes, so its hashrate estimate swings widely and pool shares change from day to day.",
  // Testnet 5 has no minimum-difficulty exception (BIP 95): its figures read as mainnet's.
  testnet5: undefined,
  regtest:
    "Regtest blocks are made on demand by whoever runs the node, at the minimum difficulty. There are no pools and the hashrate is not meaningful here; the block figures are real.",
};

/** What makes a network's mining figures different from mainnet's, in plain words. */
export const networkNote = (network: Network): string | undefined => NOTES[network];

/** Whether pools and hashrate mean anything on a network. */
export const competitive = (network: Network): boolean => network !== "regtest";

/**
 * A data-derived link, only if it is plain http or https (SECURITY.md rule 14): its URL and the
 * host to show; undefined for anything else.
 */
export function safeLink(link: string): { href: string; host: string } | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return { href: url.href, host: url.host.replace(/^www\./, "") };
}

// Past difficulty adjustments and block health (docs/API.md "Mining" and "Block audits").

/** `difficulty-adjustments`: `[time, height, difficulty, ratio]`, newest first. */
export type Adjustment = readonly [time: number, height: number, difficulty: number, ratio: number];
/** `predictions`: `[timestamp, height, matchRate]`, lowest height first. */
export type Prediction = readonly [time: number, height: number, matchRate: number];

const numbers = (v: unknown, n: number): boolean =>
  Array.isArray(v) && v.length === n && v.every((x) => isNum(x));
export const isAdjustments = listOf((v): v is Adjustment => numbers(v, 4));
export const isPredictions = listOf((v): v is Prediction => numbers(v, 3));

/** An adjustment's ratio as a change in percent: 1.05539 is 5.539. */
export const adjustmentPercent = (ratio: number): number => (ratio - 1) * 100;

/** At most this many points in the health chart: past it, each point is a run of blocks. */
export const HEALTH_POINTS = 1000;

export interface Health {
  /** Each point's time, ascending; a gap's is between its neighbours. */
  x: number[];
  /** The point's match rate, its lowest when it stands for several blocks; null for a gap. */
  rate: (number | null)[];
  /** The block that rate is of, which the point opens. */
  height: (number | null)[];
  /** How many of the run's blocks were audited. */
  audited: (number | null)[];
  /** Blocks a point stands for. */
  per: number;
  /** Audited blocks in all. */
  count: number;
  /** The earliest audited block's time. */
  first: number | undefined;
}

/**
 * The match rate per block, in height order, with a gap wherever a block between two audited
 * ones has no audit. Past `max` blocks, each point is the lowest of a run of `per` heights, so a
 * bad block still shows, and a run missing a block breaks the line after it. A block stamped
 * before the one below it is drawn at that one's time, since times must ascend.
 */
export function healthSeries(points: readonly Prediction[], max = HEALTH_POINTS): Health {
  const by = sorted(points, (a, b) => a[1] - b[1]);
  const lo = by[0]?.[1] ?? 0;
  const hi = by.at(-1)?.[1] ?? 0;
  const per = Math.max(1, Math.ceil((hi - lo + 1) / max));
  const out: Health = {
    x: [],
    rate: [],
    height: [],
    audited: [],
    per,
    count: by.length,
    // A loop, not a spread: a long record has more audits than a call takes arguments.
    first: by.reduce<number | undefined>(
      (m, p) => (m === undefined || p[0] < m ? p[0] : m),
      undefined,
    ),
  };
  const push = (x: number, rate: number | null, height: number | null, n: number | null) => {
    out.x.push(Math.max(x, out.x.at(-1) ?? x));
    out.rate.push(rate);
    out.height.push(height);
    out.audited.push(n);
  };
  let run: { g: number; t: number; h: number; r: number; n: number } | undefined;
  const close = () => {
    if (run) push(run.t, run.r, run.h, run.n);
  };
  let below: number | undefined;
  /** A height with no audit since the last break: the line breaks after the point holding it. */
  let hole = false;
  for (const [t, h, r] of by) {
    if (below !== undefined && h > below + 1) hole = true;
    below = h;
    const g = Math.floor(h / per);
    if (run && g === run.g) {
      run.n += 1;
      if (r < run.r) Object.assign(run, { t, h, r });
      continue;
    }
    close();
    // A block with no audit between two that have one: a gap, drawn as a break.
    if (run && hole) push((Math.max(run.t, out.x.at(-1) ?? run.t) + t) / 2, null, null, null);
    hole = false;
    run = { g, t, h, r, n: 1 };
  }
  close();
  return out;
}

/**
 * How many blocks the period holds, from the pools ranking's answer: only when that answer is of
 * the same period and covers all of it (a history still filling in counts fewer blocks).
 */
export function periodBlocks(
  ranking:
    | { path: string; value: { blockCount: number }; coverage: Coverage | undefined }
    | undefined,
  p: Period,
): number | undefined {
  return answeredPeriod(ranking)?.id === p.id && ranking?.coverage?.complete === true
    ? ranking.value.blockCount
    : undefined;
}

/** A share of a whole, never rounded up to all of it: `15%`, `under 1%`, `99%`. */
function shareOf(part: number, whole: number): string {
  const pct = whole > 0 ? (part / whole) * 100 : 0;
  return pct > 0 && pct < 1 ? "under 1%" : `${Math.floor(Math.min(100, pct))}%`;
}

/** A moment to the minute, its year left out when it is this one, so the line fits a phone. */
const shortMoment = (t: number, now: number): string =>
  formatMoment(t).replace(` ${new Date(now * 1000).getUTCFullYear()},`, ",");

/**
 * How much of the period the audits cover, in one short line: what share of its blocks (when
 * `blocks`, the period's count, is known) and from when; undefined when every block has one. "15% audited, from 12 Nov,
 * 11:14 UTC."
 */
export function healthCoverage(
  h: Health,
  blocks: number | undefined,
  now = Date.now() / 1000,
): string | undefined {
  if (h.first === undefined) return undefined;
  const from = shortMoment(h.first, now);
  if (blocks === undefined || blocks <= 0) return `Audited from ${from}.`;
  if (h.count >= blocks) return undefined;
  const pct = shareOf(h.count, blocks);
  return `${pct.charAt(0).toUpperCase()}${pct.slice(1)} audited, from ${from}.`;
}
