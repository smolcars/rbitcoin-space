import { describe, expect, it } from "vitest";
import { PRIORITIES } from "../home/fees";
import {
  costGap,
  costView,
  hasSamples,
  leftOutView,
  LEVELS,
  levelView,
  type LevelView,
  levelViews,
  notOursSentence,
  parseWindow,
  percent,
  percentRange,
  rateDifference,
  readScore,
  type Score,
  type ScoreLevel,
} from "./score";
import { MAINNET_1W, MAINNET_24H, SIGNET_1W } from "./testdata";

/** The level views of a recorded answer, slowest first, each one known to be there. */
const views = (v: unknown): LevelView[] => levelViews(read(v));
const at = (list: LevelView[], i: number): LevelView => {
  const v = list[i];
  if (!v) throw new Error(`no level ${i}`);
  return v;
};

const read = (v: unknown): Score => {
  const s = readScore(v);
  if (!s) throw new Error("unreadable");
  return s;
};

/** A level with enough evidence, its figures overridden. */
const level = (over: Partial<ScoreLevel> = {}): ScoreLevel => ({
  name: "high",
  blocks: 1,
  scored: 3000,
  outcomes: 150,
  enough: true,
  met: 0.9,
  interval: [0.87, 0.93],
  overpay: { mean: 1.2, median: 1 },
  shortfall: 0.5,
  recommended: 2,
  leftOut: { outage: 0, unfinished: 20, noClearing: 1 },
  ...over,
});

/** The route's JSON, mainnet's last week, with `edit` applied to a copy. */
const edited = (edit: (v: Record<string, unknown>) => void): unknown => {
  const v = structuredClone(MAINNET_1W) as Record<string, unknown>;
  edit(v);
  return v;
};
const firstLevel = (v: Record<string, unknown>) =>
  (v["levels"] as Record<string, unknown>[])[0] as Record<string, unknown>;

describe("the levels", () => {
  it("are named and promised as the home page's fee panel names them, in its order", () => {
    expect(LEVELS.map(({ level: l, name, when }) => ({ level: l, name, when }))).toStrictEqual(
      PRIORITIES.map(({ level: l, name, when }) => ({ level: l, name, when })),
    );
  });
});

describe("parseWindow", () => {
  it("takes a window the route knows, and a week for anything else", () => {
    expect(parseWindow("24h").id).toBe("24h");
    expect(parseWindow(["all", "1w"]).id).toBe("all");
    expect(parseWindow(undefined).id).toBe("1w");
    expect(parseWindow("2h").id).toBe("1w");
  });
});

describe("readScore", () => {
  it("reads a recorded answer, slowest level first as the home page lists them", () => {
    const s = read(MAINNET_1W);
    expect(s.window).toBe("1w");
    expect(s.minBlocks).toBe(30);
    expect(s.levels.map((l) => l.name)).toStrictEqual(["no_rush", "low", "medium", "high"]);
    const high = s.levels[3];
    expect(high).toMatchObject({
      blocks: 1,
      enough: true,
      met: 0.8846,
      interval: [0.8575, 0.9118],
    });
    expect(high?.leftOut).toStrictEqual({ outage: 0, unfinished: 34, noClearing: 4 });
    expect(high?.recommended).toBe(2.001);
    expect(s.notOurs).toStrictEqual({ node: 268, nothing: 271 });
  });

  it("keeps a level without enough evidence free of figures", () => {
    const noRush = read(MAINNET_24H).levels[0];
    expect(noRush).toMatchObject({ name: "no_rush", enough: false, met: null, interval: null });
    expect(noRush?.overpay).toBeNull();
    expect(noRush?.shortfall).toBeNull();
    expect(noRush?.recommended).toBeNull();
  });

  it("reads an answer from a server older than the recommended rate as not knowing it", () => {
    const s = read(edited((v) => delete firstLevel(v)["recommended"]));
    expect(s.levels[3]?.recommended).toBeNull();
    expect(s.levels[2]?.recommended).toBe(1.016);
  });

  it("refuses a level with enough evidence but no share or no interval", () => {
    const noInterval = edited((v) => {
      firstLevel(v)["interval"] = null;
    });
    expect(readScore(noInterval)).toBeUndefined();
    const noShare = edited((v) => {
      firstLevel(v)["met"] = null;
    });
    expect(readScore(noShare)).toBeUndefined();
  });

  it("never shows a share the route did not mean to give", () => {
    const s = read(
      edited((v) => {
        firstLevel(v)["enough"] = false;
      }),
    );
    expect(s.levels[3]).toMatchObject({ enough: false, met: null, interval: null, overpay: null });
  });

  it("reads an overpay with nothing met", () => {
    const high = read(SIGNET_1W).levels[3];
    expect(high).toMatchObject({ met: 0, overpay: { mean: null, median: null }, shortfall: 0.671 });
  });

  it("refuses anything that is not the route's answer", () => {
    expect(readScore(null)).toBeUndefined();
    expect(readScore([])).toBeUndefined();
    const broken: ((v: Record<string, unknown>) => void)[] = [
      (v) => (v["window"] = "2h"),
      (v) => (v["levels"] = (v["levels"] as unknown[]).slice(1)),
      (v) => (v["not_ours"] = { node: -1, nothing: 0 }),
      (v) => (firstLevel(v)["name"] = "medium"),
      (v) => (firstLevel(v)["blocks"] = 2),
      (v) => (firstLevel(v)["met"] = 1.2),
      (v) => (firstLevel(v)["met"] = "0.9"),
      (v) => (firstLevel(v)["interval"] = [0.9, 0.8]),
      (v) => (firstLevel(v)["interval"] = [0.8]),
      (v) => (firstLevel(v)["overpay"] = { mean: -1, median: 0 }),
      (v) => (firstLevel(v)["scored"] = 1.5),
      (v) => (firstLevel(v)["recommended"] = -1),
      (v) => (firstLevel(v)["recommended"] = "2"),
      (v) => (firstLevel(v)["left_out"] = { outage: 0, unfinished: 0 }),
      (v) => {
        const [a, b, c, d] = v["levels"] as unknown[];
        v["levels"] = [d, c, b, a];
      },
    ];
    for (const edit of broken) expect(readScore(edited(edit))).toBeUndefined();
  });
});

describe("figures at the target", () => {
  /** What the page prints and says for a share with the interval `[lo, hi]`. */
  const shown = (met: number, lo: number, hi: number) => {
    const v = levelView(level({ met, interval: [lo, hi] }), 30);
    return { met: v.met, interval: v.interval, verdict: v.verdict, detail: v.detail };
  };

  it("never prints a share under the target as the target", () => {
    expect(percent(0.8499)).toBe("84.9%");
    expect(percent(0.84996)).toBe("84.9%");
    expect(percent(0.85)).toBe("85.0%");
    expect(percent(0.85004)).toBe("85.0%");
    expect(shown(0.8499, 0.8, 0.9)).toMatchObject({ met: "84.9%", verdict: "Below target" });
    expect(shown(0.84996, 0.8, 0.9)).toMatchObject({ met: "84.9%", verdict: "Below target" });
    expect(shown(0.85, 0.8, 0.9)).toMatchObject({ met: "85.0%", verdict: "Meets target" });
    expect(shown(0.85004, 0.8, 0.9)).toMatchObject({ met: "85.0%", verdict: "Meets target" });
  });

  it("never prints an interval's upper bound under the target as the target", () => {
    const under = "Under 85% across its whole interval.";
    const reaches = "Its interval reaches 85%, so more blocks are needed to be sure.";
    expect(shown(0.8, 0.75, 0.8499)).toMatchObject({ interval: "75.0–84.9%", detail: under });
    expect(shown(0.8, 0.75, 0.84996)).toMatchObject({ interval: "75.0–84.9%", detail: under });
    expect(shown(0.8, 0.75, 0.85)).toMatchObject({ interval: "75.0–85.0%", detail: reaches });
    expect(shown(0.8, 0.75, 0.85004)).toMatchObject({ interval: "75.0–85.0%", detail: reaches });
  });

  it("never prints an interval's lower bound under the target as the target", () => {
    const sure = "At or above 85% across its whole interval.";
    const unsure = "Its interval reaches below 85%, so more blocks are needed to be sure.";
    expect(shown(0.9, 0.8499, 0.95)).toMatchObject({ interval: "84.9–95.0%", detail: unsure });
    expect(shown(0.9, 0.84996, 0.95)).toMatchObject({ interval: "84.9–95.0%", detail: unsure });
    expect(shown(0.9, 0.85, 0.95)).toMatchObject({ interval: "85.0–95.0%", detail: sure });
    expect(shown(0.9, 0.85004, 0.95)).toMatchObject({ interval: "85.0–95.0%", detail: sure });
  });
});

describe("figures", () => {
  it("writes a share to a tenth, whole at the ends", () => {
    expect(percent(0.8846)).toBe("88.5%");
    expect(percent(0.85)).toBe("85.0%");
    expect(percent(0)).toBe("0%");
    expect(percent(0.0004)).toBe("0%");
    expect(percent(0.9996)).toBe("100%");
    expect(percent(1)).toBe("100%");
    expect(percentRange([0.8575, 0.9118])).toBe("85.8–91.2%");
    expect(percentRange([0, 0.0039])).toBe("0–0.4%");
  });

  it("writes a rate difference as the site writes a rate, never a positive one as zero", () => {
    expect(rateDifference(1.064)).toBe("1.06");
    expect(rateDifference(0.043)).toBe("0.04");
    expect(rateDifference(0.002)).toBe("under 0.01");
    expect(rateDifference(0)).toBe("0.00");
  });
});

describe("levelView", () => {
  it("meets its target when the share is at least 85%, sure when the whole interval is", () => {
    const v = levelView(level(), 30);
    expect(v).toMatchObject({
      name: "High",
      when: "next block",
      horizon: "the next block",
      standing: "meets",
      verdict: "Meets target",
      met: "90.0%",
      interval: "87.0–93.0%",
    });
    expect(v.detail).toBe("At or above 85% across its whole interval.");
    expect(v.unsure).toBe(false);
    expect(v.marks?.met).toBeCloseTo(90, 9);
    const unsure = levelView(level({ met: 0.86, interval: [0.8, 0.92] }), 30);
    expect(unsure.standing).toBe("meets");
    expect(unsure.detail).toBe(
      "Its interval reaches below 85%, so more blocks are needed to be sure.",
    );
    expect(unsure.unsure).toBe(true);
  });

  it("is below target under 85%, plainly, whatever its interval", () => {
    const noRush = at(views(MAINNET_1W), 0);
    expect(noRush).toMatchObject({
      name: "No rush",
      horizon: "the next 144 blocks",
      standing: "below",
      verdict: "Below target",
      met: "67.4%",
      interval: "63.3–71.4%",
      detail: "Under 85% across its whole interval.",
    });
    const close = levelView(level({ met: 0.84, interval: [0.8, 0.88] }), 30);
    expect(close.verdict).toBe("Below target");
    expect(close.detail).toBe("Its interval reaches 85%, so more blocks are needed to be sure.");
  });

  it("on a test network calls a share under the target no fair test, not a miss", () => {
    const signet = (testNet: boolean) => levelViews(read(SIGNET_1W), testNet);
    // The condition: a test network, and a share under the target.
    expect(signet(true).map((v) => [v.standing, v.verdict])).toStrictEqual(
      Array.from({ length: 4 }, () => ["untested", "Not a fair test here"]),
    );
    // Every figure stays.
    expect(at(signet(true), 3)).toMatchObject({ met: "0%", interval: "0–0.4%" });
    expect(at(signet(true), 3).marks).toBeDefined();
    // The same figures on mainnet are a plain miss.
    expect(at(signet(false), 3)).toMatchObject({ standing: "below", verdict: "Below target" });
    // A test network's level at or over the target, or without enough blocks, is as anywhere.
    expect(levelView(level(), 30, true).standing).toBe("meets");
    expect(levelView(level({ met: 0.85, interval: [0.8, 0.9] }), 30, true).standing).toBe("meets");
    expect(levelView(level({ met: 0.849, interval: [0.8, 0.9] }), 30, true).standing).toBe(
      "untested",
    );
    expect(at(levelViews(read(MAINNET_24H), true), 0).standing).toBe("too-few");
    // Mainnet's miss stays a plain miss.
    expect(at(views(MAINNET_1W), 0).standing).toBe("below");
  });

  it("gives no share with too few blocks, and says how many are needed", () => {
    const noRush = at(views(MAINNET_24H), 0);
    expect(noRush).toMatchObject({
      standing: "too-few",
      verdict: "Too few blocks yet",
      met: undefined,
      interval: undefined,
      marks: undefined,
    });
    expect(noRush.detail).toBe(
      "A share is given from 30 blocks; 6 blocks have decided this level so far. Most of its answers are still waiting for their 144th block.",
    );
    const one = levelView(
      level({
        enough: false,
        met: null,
        interval: null,
        outcomes: 1,
        scored: 2,
        leftOut: { outage: 0, unfinished: 0, noClearing: 0 },
      }),
      30,
    );
    expect(one.detail).toBe(
      "A share is given from 30 blocks; 1 block has decided this level so far.",
    );
    // Most of the level's own samples were left out for an outage, not still waiting.
    const outage = levelView(
      level({
        enough: false,
        met: null,
        interval: null,
        outcomes: 3,
        scored: 10,
        leftOut: { outage: 100, unfinished: 20, noClearing: 0 },
      }),
      30,
    );
    expect(outage.detail).not.toContain("waiting");
    const waiting = levelView(
      level({
        enough: false,
        met: null,
        interval: null,
        outcomes: 3,
        scored: 10,
        leftOut: { outage: 5, unfinished: 20, noClearing: 0 },
      }),
      30,
    );
    expect(waiting.detail).toContain("Most of its answers are still waiting for the next block.");
  });
});

describe("cost", () => {
  it("shows what was paid over and short, and why a figure is missing", () => {
    const week = views(MAINNET_1W);
    expect(costView(at(week, 0))).toStrictEqual({
      name: "No rush",
      recommended: "0.12",
      overpayMean: "0.04",
      overpayMedian: "under 0.01",
      shortfall: "0.01",
    });
    expect(costView(at(week, 3)).overpayMean).toBe("1.06");
    expect(costView(at(week, 3)).recommended).toBe("2.00");
    expect(costView(at(views(MAINNET_24H), 0)).recommended).toBeUndefined();
    const signetHigh = at(views(SIGNET_1W), 3);
    expect(costView(signetHigh).overpayMean).toBeUndefined();
    expect(costGap(signetHigh, "met")).toBe("none met");
    const tooFew = at(views(MAINNET_24H), 0);
    expect(costGap(tooFew, "missed")).toBe("too few blocks");
    expect(costGap(levelView(level({ shortfall: null }), 30), "missed")).toBe("none missed");
  });
});

describe("leftOutView", () => {
  const left = (unfinished: number, outage: number, noClearing: number) =>
    leftOutView(level({ leftOut: { unfinished, outage, noClearing } }));
  it("gives the total and names every kind that is not zero", () => {
    expect(left(0, 0, 0)).toStrictEqual({ total: "0", kinds: undefined });
    expect(left(2235, 0, 0)).toStrictEqual({ total: "2\u202F235", kinds: "not finished" });
    expect(left(0, 0, 67)).toStrictEqual({ total: "67", kinds: "no clearing rate" });
    expect(left(13, 0, 5)).toStrictEqual({
      total: "18",
      kinds: "13 not finished, 5 no clearing rate",
    });
    expect(left(1, 2, 3).kinds).toBe("1 not finished, 2 outage, 3 no clearing rate");
  });
});

describe("the answers that were not ours", () => {
  it("are counted and explained, or not mentioned when there were none", () => {
    expect(notOursSentence(read(MAINNET_1W))).toBe(
      "In 539 samples from this period the server was not serving its own answer, so they are not scored: 268 times it served the node's own estimates instead, and 271 times it had no answer to serve. That happens while it warms up after a restart, and while its view of the mempool is out of date.",
    );
    expect(notOursSentence(read(MAINNET_24H))).toBeUndefined();
    const once = read(MAINNET_24H);
    once.notOurs = { node: 0, nothing: 1 };
    expect(notOursSentence(once)).toMatch(
      /^In 1 sample from this period .* so it is not scored: once it had no answer to serve\./,
    );
  });
});

describe("hasSamples", () => {
  it("is false only when the window holds nothing at all", () => {
    expect(hasSamples(read(MAINNET_24H))).toBe(true);
    const empty = read(MAINNET_24H);
    empty.from = null;
    empty.levels = empty.levels.map((l) => ({ ...l, scored: 0 }));
    expect(hasSamples(empty)).toBe(false);
    empty.notOurs = { node: 2, nothing: 0 };
    expect(hasSamples(empty)).toBe(true);
  });
});
