import { describe, expect, it } from "vitest";
import {
  adjustmentPercent,
  byTime,
  coverageNote,
  fillWeeks,
  hashrateInterval,
  hashrateSeries,
  healthCoverage,
  healthSeries,
  isAdjustments,
  isPredictions,
  isPoolStats,
  isRanking,
  networkHashrate,
  networkNote,
  OTHER_POOLS,
  parsePeriod,
  periodBlocks,
  periodDomain,
  poolLayers,
  type Ranking,
  rewardFigures,
  safeLink,
  sharesOverTime,
} from "./mining";

const DAY = 86_400;

describe("periods", () => {
  it("reads the period from the address, with a week by default", () => {
    expect(parsePeriod("1m").id).toBe("1m");
    expect(parsePeriod(["1y"]).id).toBe("1y");
    expect(parsePeriod("10y").id).toBe("1w");
    expect(parsePeriod(undefined).id).toBe("1w");
  });
  it("shows at least a week of hashrate, and shares only by the month or longer", () => {
    expect(hashrateInterval(parsePeriod("24h"))).toBe("1w");
    expect(hashrateInterval(parsePeriod("1y"))).toBe("1y");
    expect(sharesOverTime(parsePeriod("1w"))).toBe(false);
    expect(sharesOverTime(parsePeriod("1m"))).toBe(true);
  });
  it("draws the whole period, or the data's extent for all time", () => {
    const now = 100 * DAY;
    expect(periodDomain(parsePeriod("1m"), [90 * DAY, 99 * DAY], now)).toStrictEqual([
      70 * DAY,
      now,
    ]);
    expect(periodDomain(parsePeriod("all"), [1, 2], now)).toBeUndefined();
    expect(periodDomain(parsePeriod("1m"), [], now)).toBeUndefined();
  });
});

describe("hashrate and difficulty", () => {
  it("gives each point the difficulty in force, and the one before the first retarget", () => {
    const s = hashrateSeries({
      hashrates: [
        { timestamp: 30, avgHashrate: 3 },
        { timestamp: 10, avgHashrate: 1 },
        { timestamp: 20, avgHashrate: 2 },
      ],
      difficulty: [{ time: 15, height: 2016, difficulty: 110, adjustment: 1.1 }],
      currentHashrate: 3,
      currentDifficulty: 110,
    });
    expect(s.x).toStrictEqual([10, 20, 30]);
    expect(s.hashrate).toStrictEqual([1, 2, 3]);
    expect(s.difficulty[0]).toBeCloseTo(100);
    expect(s.difficulty.slice(1)).toStrictEqual([110, 110]);
  });
  it("uses the current difficulty when no retarget falls in the period", () => {
    const s = hashrateSeries({
      hashrates: [{ timestamp: 10, avgHashrate: 1 }],
      difficulty: [],
      currentHashrate: 1,
      currentDifficulty: 148,
    });
    expect(s.difficulty).toStrictEqual([148]);
  });
});

describe("pool layers", () => {
  const week = (timestamp: number, poolName: string, share: number) => ({
    timestamp,
    poolName,
    share,
    avgHashrate: 0,
  });
  it("stacks the coloured pools, biggest at the bottom, and every other pool as one layer", () => {
    const weeks = [
      week(2, "AntPool", 0.5),
      week(2, "Luxor", 0.3),
      week(2, "Unknown", 0.1),
      week(2, "F2Pool", 0.1),
      week(1, "AntPool", 0.4),
      week(1, "F2Pool", 0.6),
    ];
    const { x, layers } = poolLayers(weeks);
    expect(x).toStrictEqual([1, 2]);
    expect(layers.map((l) => l.name)).toStrictEqual(["AntPool", "F2Pool", "Luxor", OTHER_POOLS]);
    expect(layers[0]?.values).toStrictEqual([0.4, 0.5]);
    expect(layers[3]?.values[1]).toBeCloseTo(0.1);
    // A pool's colour is its own, whatever its rank: AntPool is 2, F2Pool 3, Luxor 7, everywhere.
    expect(layers.map((l) => l.pool)).toStrictEqual([2, 3, 7, 0]);
  });
  it("picks and orders the pools by the table's blocks, not by summed weekly shares", () => {
    // Five pools at 17% both weeks; MARA 12% of a 1,000-block week and 1% of a 100-block one,
    // Luxor 3% and 14%: MARA has 121 blocks to Luxor's 44, so MARA is drawn, not Luxor.
    const five = ["Foundry USA", "AntPool", "F2Pool", "ViaBTC", "SpiderPool"];
    const weeks = [1, 2].flatMap((t) => five.map((name) => week(t, name, 0.17)));
    weeks.push(
      week(1, "MARA Pool", 0.12),
      week(1, "Luxor", 0.03),
      week(2, "MARA Pool", 0.01),
      week(2, "Luxor", 0.14),
    );
    const table = [...five, "MARA Pool", "Luxor"];
    expect(poolLayers(weeks, table).layers.map((l) => l.name)).toStrictEqual([
      ...five,
      "MARA Pool",
      OTHER_POOLS,
    ]);
    // Without the table, the weekly sums are all there is.
    expect(poolLayers(weeks).layers.map((l) => l.name)).toContain("Luxor");
  });

  it("keeps the rest when the table names a pool the weeks do not hold", () => {
    // Foundry mined only in the period's opening part-week, which the weekly answer leaves out.
    const weeks = [week(1, "AntPool", 0.8), week(1, "Unknown", 0.2)];
    const { layers } = poolLayers(weeks, ["Foundry USA", "AntPool", "Unknown"]);
    expect(layers.map((l) => [l.name, l.values[0]])).toStrictEqual([
      ["Foundry USA", 0],
      ["AntPool", 0.8],
      [OTHER_POOLS, 0.2],
    ]);
  });

  it("draws only the period's six largest coloured pools, so it agrees with the table", () => {
    const names = ["Luxor", "Foundry USA", "Ocean.xyz", "AntPool", "SecPool", "F2Pool", "ViaBTC"];
    const weeks = names.map((name, i) => week(1, name, (10 - i) / 100));
    const { layers } = poolLayers(weeks);
    expect(layers.map((l) => l.name)).toStrictEqual([...names.slice(0, 6), OTHER_POOLS]);
    expect(layers.at(-1)?.values[0]).toBeCloseTo(0.04);
  });
  it("leaves out the grey layer when every pool has a colour", () => {
    const { layers } = poolLayers([week(1, "ViaBTC", 0.7), week(1, "Foundry USA", 0.3)]);
    expect(layers.map((l) => [l.name, l.pool])).toStrictEqual([
      ["ViaBTC", 4],
      ["Foundry USA", 1],
    ]);
  });
});

describe("figures", () => {
  const ranking: Ranking = {
    pools: [],
    blockCount: 10,
    lastEstimatedHashrate: 1,
    lastEstimatedHashrate3d: 2,
    lastEstimatedHashrate1w: 3,
  };
  it("takes the network's hashrate over the same stretch as the shares", () => {
    expect(networkHashrate(parsePeriod("24h"), ranking, undefined)).toBe(1);
    expect(networkHashrate(parsePeriod("1w"), ranking, undefined)).toBe(3);
    const h = {
      hashrates: [
        { timestamp: 1, avgHashrate: 4 },
        { timestamp: 2, avgHashrate: 6 },
      ],
      difficulty: [],
      currentHashrate: 6,
      currentDifficulty: 1,
    };
    expect(networkHashrate(parsePeriod("1y"), ranking, h)).toBe(5);
  });
  it("splits a reward into subsidy and fees", () => {
    expect(
      rewardFigures({
        startBlock: 1,
        endBlock: 4,
        totalReward: "1250001000",
        totalFee: "1000",
        totalTx: "40",
      }),
    ).toStrictEqual({
      blocks: 4,
      reward: 1_250_001_000,
      fees: 1000,
      subsidy: 1_250_000_000,
      txs: 40,
      feeShare: 1000 / 1_250_001_000,
      perBlock: 312_500_250,
    });
  });
});

describe("coverage", () => {
  const year = parsePeriod("1y");
  it("says nothing when the data covers the period", () => {
    expect(coverageNote(undefined, year)).toBeUndefined();
    expect(coverageNote({ complete: true, fromHeight: 0, fromTime: 0 }, year)).toBeUndefined();
  });
  it("says where the data starts when it does not", () => {
    const text = coverageNote(
      { complete: false, fromHeight: 968_000, fromTime: Date.UTC(2026, 8, 22) / 1000 },
      year,
    );
    expect(text).toBe("Data from 22 Sep 2026 onward.");
  });
  it("says when nothing is stored", () => {
    expect(
      coverageNote({ complete: false, fromHeight: undefined, fromTime: undefined }, year),
    ).toBe("No blocks are stored for the last year yet.");
  });
});

describe("networks", () => {
  it("explains each test network and leaves mainnet alone", () => {
    expect(networkNote("mainnet")).toBeUndefined();
    expect(networkNote("signet")).toContain("signers");
    expect(networkNote("testnet4")).toContain("minimum difficulty");
    // Testnet 5 has no minimum-difficulty exception: no note.
    expect(networkNote("testnet5")).toBeUndefined();
    expect(networkNote("regtest")).toContain("no pools");
  });
});

describe("data-derived links", () => {
  it("allows plain http and https only", () => {
    expect(safeLink("https://www.foundrydigital.com/")).toStrictEqual({
      href: "https://www.foundrydigital.com/",
      host: "foundrydigital.com",
    });
    // oxlint-disable-next-line no-script-url -- hostile data the check must refuse
    expect(safeLink("javascript:alert(1)")).toBeUndefined();
    expect(safeLink("data:text/html,<b>x</b>")).toBeUndefined();
    expect(safeLink("https://user:pass@example.com")).toBeUndefined();
    expect(safeLink("not a url")).toBeUndefined();
    expect(safeLink("")).toBeUndefined();
  });
});

describe("reply checks", () => {
  it("accepts the ranking's shape and refuses others", () => {
    expect(
      isRanking({
        pools: [
          {
            poolId: 0,
            name: "Unknown",
            link: "",
            blockCount: 1,
            rank: 1,
            emptyBlocks: 0,
            slug: "unknown",
          },
        ],
        blockCount: 1,
        lastEstimatedHashrate: null,
        lastEstimatedHashrate3d: null,
        lastEstimatedHashrate1w: null,
      }),
    ).toBe(true);
    expect(isRanking({ pools: [{ name: 1 }], blockCount: 1 })).toBe(false);
    expect(isRanking(null)).toBe(false);
  });
  it("refuses a pool whose totals are not whole numbers", () => {
    const stats = {
      pool: { id: 1, name: "A", link: "", addresses: [], regexes: [], slug: "a" },
      blockCount: { all: 1, "24h": 1, "1w": 1 },
      blockShare: { all: 1, "24h": 1, "1w": 1 },
      estimatedHashrate: null,
      totalReward: "625000000",
    };
    expect(isPoolStats(stats)).toBe(true);
    expect(isPoolStats({ ...stats, totalReward: "1e9" })).toBe(false);
  });
});

describe("ordering and gaps", () => {
  it("orders block points by time, which can run backwards across heights", () => {
    const pts = [
      { avgHeight: 1, timestamp: 100 },
      { avgHeight: 2, timestamp: 300 },
      { avgHeight: 3, timestamp: 200 },
    ];
    expect(byTime(pts)?.map((p) => p.avgHeight)).toStrictEqual([1, 3, 2]);
    expect(byTime(undefined)).toBeUndefined();
  });
  it("fills a pool's weeks without a block as zero, inventing none outside its stored weeks", () => {
    const W = 7 * DAY;
    const week = (timestamp: number, share: number) => ({
      timestamp,
      share,
      avgHashrate: share * 1e21,
      poolName: "A",
    });
    const filled = fillWeeks([week(3 * W, 0.2), week(W, 0.3)]);
    expect(filled.map((w) => [w.timestamp, w.share])).toStrictEqual([
      [W, 0.3],
      [2 * W, 0],
      [3 * W, 0.2],
    ]);
    expect(fillWeeks([])).toStrictEqual([]);
  });
});

describe("difficulty adjustments and block health", () => {
  it("reads the routes' tuples and nothing else", () => {
    expect(isAdjustments([[1_793_301_298, 973_728, 1.48e14, 1.05539]])).toBe(true);
    expect(isAdjustments([[1, 2, 3]])).toBe(false);
    expect(isAdjustments([[1, 2, 3, "1.05"]])).toBe(false);
    expect(isPredictions([[1_794_482_500, 975_542, 100]])).toBe(true);
    expect(isPredictions([[1, 2, null]])).toBe(false);
    expect(isPredictions({})).toBe(false);
    expect(adjustmentPercent(1.05539)).toBeCloseTo(5.539, 9);
    expect(adjustmentPercent(0.98688)).toBeCloseTo(-1.312, 9);
  });

  it("draws a block per point, with a gap wherever a block between two has no audit", () => {
    const h = healthSeries([
      [1_000, 100, 99.5],
      [1_600, 101, 97],
      // 102 was not audited; 103 was stamped before 101.
      [1_500, 103, 100],
      [2_000, 104, 60],
    ]);
    expect(h.per).toBe(1);
    expect(h.count).toBe(4);
    expect(h.first).toBe(1_000);
    expect(h.rate).toStrictEqual([99.5, 97, null, 100, 60]);
    expect(h.height).toStrictEqual([100, 101, null, 103, 104]);
    // Times ascend: the block stamped early is drawn at the time of the one before it.
    expect(h.x).toStrictEqual([1_000, 1_600, 1_600, 1_600, 2_000]);
  });

  it("past its limit, a point is the lowest block of a run, and opens that one", () => {
    const points = Array.from(
      { length: 10 },
      (_, i) => [i * 600, 200 + i, i === 3 ? 40 : 99] as const,
    );
    const h = healthSeries(points, 5);
    expect(h.per).toBe(2);
    expect(h.rate).toStrictEqual([99, 40, 99, 99, 99]);
    expect(h.height).toStrictEqual([200, 203, 204, 206, 208]);
    expect(h.audited).toStrictEqual([2, 2, 2, 2, 2]);
    expect(healthSeries([]).x).toStrictEqual([]);
    // A block without an audit inside a run still breaks the line, after that run.
    const holed = healthSeries(
      Array.from({ length: 1002 }, (_, k) => [k * 600, k, 99] as const).filter(
        ([, k]) => k !== 501,
      ),
    );
    expect(holed.per).toBe(2);
    const gap = holed.rate.indexOf(null);
    expect(holed.height[gap - 1]).toBe(500);
    expect(holed.audited[gap - 1]).toBe(1);
    expect(holed.rate.filter((r) => r === null)).toHaveLength(1);
  });

  it("finds the first audit in a record longer than a call takes arguments", () => {
    const many = Array.from({ length: 200_000 }, (_, i) => [1_000 + i, i, 100] as const);
    expect(healthSeries(many).first).toBe(1_000);
  });

  it("says what share of the period's blocks have an audit, and from when", () => {
    const now = Date.UTC(2026, 10, 13) / 1000;
    const h = healthSeries([[Date.UTC(2026, 10, 12, 11, 14) / 1000, 975_542, 100]]);
    expect(healthCoverage(h, 1_008, now)).toBe("Under 1% audited, from 12 Nov, 11:14 UTC.");
    expect(healthCoverage(h, 5, now)).toBe("20% audited, from 12 Nov, 11:14 UTC.");
    expect(healthCoverage(h, undefined, now)).toBe("Audited from 12 Nov, 11:14 UTC.");
    expect(healthCoverage(h, 1, now)).toBeUndefined();
    expect(healthCoverage(h, 5, Date.UTC(2027, 0, 2) / 1000)).toBe(
      "20% audited, from 12 Nov 2026, 11:14 UTC.",
    );
    expect(healthCoverage(healthSeries([]), 5, now)).toBeUndefined();
  });

  it("counts the period's blocks only from a ranking of that period that covers all of it", () => {
    const week = parsePeriod("1w");
    const ranking = (path: string, complete: boolean | undefined) => ({
      path,
      value: { blockCount: 144 },
      coverage: complete === undefined ? undefined : { fromHeight: 0, fromTime: 0, complete },
    });
    expect(periodBlocks(ranking("/v1/mining/pools/1w", true), week)).toBe(144);
    // Backfill has stored only the latest day: 144 is not the week's count.
    expect(periodBlocks(ranking("/v1/mining/pools/1w", false), week)).toBeUndefined();
    expect(periodBlocks(ranking("/v1/mining/pools/1w", undefined), week)).toBeUndefined();
    expect(periodBlocks(ranking("/v1/mining/pools/24h", true), week)).toBeUndefined();
    expect(periodBlocks(undefined, week)).toBeUndefined();
  });
});
