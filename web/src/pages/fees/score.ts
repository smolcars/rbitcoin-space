// The fee score: how this server's own recommendations fared against the blocks that followed
// them, from `/app/fees/score` (docs/API.md "The score kept", docs/MEMPOOL.md "The score the
// server keeps"), read and turned into what the page says.
import { formatFeeRate, groupDigits } from "../../lib/format";

/** The periods the route scores, in the order the page offers them. */
export const WINDOWS = [
  { id: "24h", label: "24 h", words: "the last 24 hours" },
  { id: "1w", label: "1 w", words: "the last week" },
  { id: "1m", label: "1 m", words: "the last month" },
  { id: "all", label: "All", words: "everything recorded" },
] as const;

export type Window = (typeof WINDOWS)[number];
export type WindowId = Window["id"];

/**
 * A week when the address names none: long enough for the day-long level to be judged (the last
 * 24 hours hold few of its finished answers), short enough to show the method as it is now.
 */
export const DEFAULT_WINDOW: WindowId = "1w";

/** The window a `?window=` value names; the default for anything else. */
export function parseWindow(value: unknown): Window {
  const id: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  return (
    WINDOWS.find((w) => w.id === id) ?? WINDOWS.find((w) => w.id === DEFAULT_WINDOW) ?? WINDOWS[1]
  );
}

/**
 * The share each level is held to: every level met at least 85% of the time (docs/MEMPOOL.md,
 * "Against the targets"). The route does not send it.
 */
export const TARGET = 0.85;
/** The target as the page writes it: `85%`. */
export const TARGET_TEXT = `${Math.round(TARGET * 100)}%`;

export type LevelName = "high" | "medium" | "low" | "no_rush";

/**
 * The four levels as the home page's "Fee to pay now" names them (`PRIORITIES` in home/fees.ts,
 * held equal by a test), slowest first as it lists them, with each level's horizon in blocks.
 */
export const LEVELS: readonly { level: LevelName; name: string; when: string; blocks: number }[] = [
  { level: "no_rush", name: "No rush", when: "within a day", blocks: 144 },
  { level: "low", name: "Low", when: "within an hour", blocks: 6 },
  { level: "medium", name: "Medium", when: "within 30 min", blocks: 3 },
  { level: "high", name: "High", when: "next block", blocks: 1 },
];

export interface ScoreLevel {
  name: LevelName;
  /** The horizon in blocks. */
  blocks: number;
  /** Answers whose horizon finished and was judged. */
  scored: number;
  /** Distinct blocks that decided them: the evidence. */
  outcomes: number;
  enough: boolean;
  /** Fractions; null when there is not enough evidence. */
  met: number | null;
  interval: readonly [number, number] | null;
  /** sat/vB above what sufficed, when met; each null when none was met. */
  overpay: { mean: number | null; median: number | null } | null;
  /** sat/vB short of what sufficed, when missed; null when none missed. */
  shortfall: number | null;
  /** The median rate the level recommended among the answers judged, sat/vB: overpay's base. */
  recommended: number | null;
  leftOut: { outage: number; unfinished: number; noClearing: number };
}

export interface Score {
  window: WindowId;
  /** Unix seconds: the oldest answer in the window, null when there is none. */
  from: number | null;
  /** Unix seconds: when the server made this answer. */
  to: number;
  minBlocks: number;
  /** In the server's order, fastest first. */
  levels: ScoreLevel[];
  /** Answers in the window that were not this server's own method's. */
  notOurs: { node: number; nothing: number };
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isShare = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;
const isRate = (v: unknown): v is number => isNum(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nullable =
  <T>(test: (v: unknown) => v is T) =>
  (v: unknown): v is T | null =>
    v === null || test(v);

function readLevel(v: unknown, blocks: number, name: LevelName): ScoreLevel | undefined {
  if (!isObject(v)) return undefined;
  const { scored, outcomes, enough, met, interval, overpay, shortfall } = v;
  // A server older than the field leaves it out: read as unknown, the rest still stands.
  const recommended = v["recommended"] ?? null;
  const left = v["left_out"];
  if (
    v["name"] !== name ||
    v["blocks"] !== blocks ||
    !isCount(scored) ||
    !isCount(outcomes) ||
    typeof enough !== "boolean" ||
    !nullable(isShare)(met) ||
    !nullable(isRate)(shortfall) ||
    !nullable(isRate)(recommended) ||
    !isObject(left) ||
    !isCount(left["outage"]) ||
    !isCount(left["unfinished"]) ||
    !isCount(left["no_clearing"])
  ) {
    return undefined;
  }
  let span: readonly [number, number] | null = null;
  if (interval !== null) {
    if (!Array.isArray(interval) || interval.length !== 2) return undefined;
    const pair: readonly unknown[] = interval as unknown[];
    const [lo, hi] = pair;
    if (!isShare(lo) || !isShare(hi) || lo > hi) return undefined;
    span = [lo, hi];
  }
  // The server sends a share and its interval for every level with enough evidence: an answer
  // without them would draw a share with no interval, so it is not the route's.
  if (enough && (met === null || span === null)) return undefined;
  let paid: ScoreLevel["overpay"] = null;
  if (overpay !== null) {
    if (!isObject(overpay)) return undefined;
    const { mean, median } = overpay;
    if (!nullable(isRate)(mean) || !nullable(isRate)(median)) return undefined;
    paid = { mean, median };
  }
  // The route gives no share without enough evidence: never show one it did not mean to give.
  const shown = enough && met !== null;
  return {
    name,
    blocks,
    scored,
    outcomes,
    enough: shown,
    met: shown ? met : null,
    interval: shown ? span : null,
    overpay: shown ? paid : null,
    shortfall: shown ? shortfall : null,
    recommended: shown ? recommended : null,
    leftOut: {
      outage: left["outage"],
      unfinished: left["unfinished"],
      noClearing: left["no_clearing"],
    },
  };
}

/** The route's answer, checked field by field; undefined when it is not what the route sends. */
export function readScore(v: unknown): Score | undefined {
  if (!isObject(v)) return undefined;
  const { window, from, to, levels } = v;
  const minBlocks = v["min_blocks"];
  const notOurs = v["not_ours"];
  const known = WINDOWS.find((w) => w.id === window);
  if (
    known === undefined ||
    !nullable(isCount)(from) ||
    !isCount(to) ||
    !isCount(minBlocks) ||
    !isObject(notOurs) ||
    !isCount(notOurs["node"]) ||
    !isCount(notOurs["nothing"]) ||
    !Array.isArray(levels) ||
    levels.length !== LEVELS.length
  ) {
    return undefined;
  }
  // The server sends the levels fastest first: the reverse of the order the page lists them.
  const read: ScoreLevel[] = [];
  for (const [i, want] of LEVELS.entries()) {
    const level = readLevel(levels[LEVELS.length - 1 - i], want.blocks, want.level);
    if (level === undefined) return undefined;
    read.push(level);
  }
  return {
    window: known.id,
    from,
    to,
    minBlocks,
    levels: read,
    notOurs: { node: notOurs["node"], nothing: notOurs["nothing"] },
  };
}

/**
 * A share as a percentage, to a tenth: `0.8847` → `88.5%`; whole at the ends, `0%` and `100%`.
 * Rounded to the nearest tenth, except that a figure under the target never rounds up to it: it
 * rounds away from the target, down to `84.9%`, so a share or bound below 85% never prints as 85%
 * beside "Below target". At or over the target, rounding to the nearest cannot go under it.
 */
export function percent(share: number): string {
  const target = Math.round(TARGET * 1000);
  const nearest = Math.round(share * 1000);
  const tenths = share < TARGET && nearest >= target ? target - 1 : nearest;
  if (tenths <= 0) return "0%";
  if (tenths >= 1000) return "100%";
  return `${(tenths / 10).toFixed(1)}%`;
}

/** An interval as one range with one sign: `85.8–91.2%`. */
export function percentRange([lo, hi]: readonly [number, number]): string {
  return `${percent(lo).replace("%", "")}–${percent(hi)}`;
}

/**
 * A difference in fee rate, as the site prints a rate; one too small to print as more than zero
 * says so rather than claim nothing was paid.
 */
export function rateDifference(rate: number): string {
  const printed = formatFeeRate(rate);
  return rate > 0 && Number(printed) === 0 ? "under 0.01" : printed;
}

/**
 * Where a level stands against its target. `untested` is a share under it on a test network,
 * where blocks have room and an answer at the minimum reads as a miss (`levelView`).
 */
export type Standing = "meets" | "below" | "untested" | "too-few";

export interface LevelView {
  level: LevelName;
  /** The home page's name and promise: "High", "next block". */
  name: string;
  when: string;
  /** "the next block", "the next 6 blocks". */
  horizon: string;
  standing: Standing;
  /** "Meets target", "Below target", "Not a fair test here", "Too few blocks yet". */
  verdict: string;
  /** "88.5%"; undefined without enough evidence. */
  met: string | undefined;
  /** "85.8–91.2%". */
  interval: string | undefined;
  /** For the drawing, in percent of the axis. */
  marks: { met: number; lo: number; hi: number } | undefined;
  /** One sentence on how sure the verdict is, or what is missing. */
  detail: string;
  /** The detail says something the drawing does not: the interval reaches across the target. */
  unsure: boolean;
  source: ScoreLevel;
}

const plural = (n: number, one: string, many: string) =>
  `${groupDigits(n)} ${n === 1 ? one : many}`;

/** "the next block", "the next 3 blocks". */
export const horizon = (blocks: number): string =>
  blocks === 1 ? "the next block" : `the next ${groupDigits(blocks)} blocks`;

/**
 * What the page says about one level. On a test network (`testNet`) a share under the target is
 * not called a miss: its blocks have room, and an answer at the minimum counts as missing them.
 */
export function levelView(l: ScoreLevel, minBlocks: number, testNet = false): LevelView {
  const names = LEVELS.find((x) => x.level === l.name) ?? { name: l.name, when: "" };
  const target = TARGET_TEXT;
  const base = { level: l.name, name: names.name, when: names.when, horizon: horizon(l.blocks) };
  if (!l.enough || l.met === null) {
    // All of the level's own samples: judged, and left out for each reason.
    const own = l.scored + l.leftOut.unfinished + l.leftOut.outage + l.leftOut.noClearing;
    const waiting =
      l.leftOut.unfinished * 2 > own
        ? ` Most of its answers are still waiting for ${l.blocks === 1 ? "the next block" : `their ${groupDigits(l.blocks)}th block`}.`
        : "";
    return {
      ...base,
      standing: "too-few",
      verdict: "Too few blocks yet",
      met: undefined,
      interval: undefined,
      marks: undefined,
      detail: `A share is given from ${groupDigits(minBlocks)} blocks; ${plural(l.outcomes, "block has", "blocks have")} decided this level so far.${waiting}`,
      unsure: true,
      source: l,
    };
  }
  const meets = l.met >= TARGET;
  const [lo, hi] = l.interval ?? [l.met, l.met];
  const unsure = meets ? lo < TARGET : hi >= TARGET;
  const detail = meets
    ? unsure
      ? `Its interval reaches below ${target}, so more blocks are needed to be sure.`
      : `At or above ${target} across its whole interval.`
    : unsure
      ? `Its interval reaches ${target}, so more blocks are needed to be sure.`
      : `Under ${target} across its whole interval.`;
  const standing: Standing = meets ? "meets" : testNet ? "untested" : "below";
  return {
    ...base,
    standing,
    verdict: { meets: "Meets target", below: "Below target", untested: "Not a fair test here" }[
      standing
    ],
    met: percent(l.met),
    interval: l.interval ? percentRange(l.interval) : undefined,
    marks: { met: l.met * 100, lo: lo * 100, hi: hi * 100 },
    detail,
    unsure,
    source: l,
  };
}

/** The levels as the page lists them: the home page's order, slowest first. */
export const levelViews = (s: Score, testNet = false): LevelView[] =>
  LEVELS.flatMap((want) => {
    const l = s.levels.find((x) => x.name === want.level);
    return l ? [levelView(l, s.minBlocks, testNet)] : [];
  });

/** Whether anything at all was recorded in the window. */
export const hasSamples = (s: Score): boolean =>
  s.from !== null || s.levels.some((l) => l.scored > 0) || s.notOurs.node + s.notOurs.nothing > 0;

/** What one level paid for its record, in words a reader can check against the table. */
export interface CostView {
  name: string;
  recommended: string | undefined;
  overpayMean: string | undefined;
  overpayMedian: string | undefined;
  shortfall: string | undefined;
}

export function costView(l: LevelView): CostView {
  const s = l.source;
  const shown = (v: number | null | undefined) =>
    v === null || v === undefined ? undefined : rateDifference(v);
  return {
    name: l.name,
    recommended: s.recommended === null ? undefined : formatFeeRate(s.recommended),
    overpayMean: shown(s.overpay?.mean),
    overpayMedian: shown(s.overpay?.median),
    shortfall: shown(s.shortfall),
  };
}

/** Why a cost cell is empty: no evidence yet, or nothing of that kind happened. */
export function costGap(l: LevelView, kind: "met" | "missed"): string {
  if (l.standing === "too-few") return "too few blocks";
  return kind === "met" ? "none met" : "none missed";
}

/**
 * The sentence on answers that were not ours, or undefined when every answer was. Those answers
 * are not scored: the score is of this server's own method.
 */
export function notOursSentence(s: Score): string | undefined {
  const { node, nothing } = s.notOurs;
  const total = node + nothing;
  if (total === 0) return undefined;
  const times = (n: number) => (n === 1 ? "once" : `${groupDigits(n)} times`);
  const parts = [
    node > 0 ? `${times(node)} it served the node's own estimates instead` : "",
    nothing > 0 ? `${times(nothing)} it had no answer to serve` : "",
  ].filter(Boolean);
  return `In ${plural(total, "sample", "samples")} from this period the server was not serving its own answer, so ${total === 1 ? "it is" : "they are"} not scored: ${parts.join(", and ")}. That happens while it warms up after a restart, and while its view of the mempool is out of date.`;
}

/**
 * The answers a level left out, as one figure and the kinds behind it: the total, and every kind
 * that is not zero, named, so no kind is ever dropped from sight. With one kind its word alone.
 */
export function leftOutView(l: ScoreLevel): { total: string; kinds: string | undefined } {
  const { unfinished, outage, noClearing } = l.leftOut;
  const kinds = (
    [
      [unfinished, "not finished"],
      [outage, "outage"],
      [noClearing, "no clearing rate"],
    ] as const
  ).filter(([n]) => n > 0);
  const total = groupDigits(unfinished + outage + noClearing);
  if (kinds.length === 0) return { total, kinds: undefined };
  if (kinds.length === 1) return { total, kinds: kinds[0]?.[1] };
  return { total, kinds: kinds.map(([n, word]) => `${groupDigits(n)} ${word}`).join(", ") };
}
