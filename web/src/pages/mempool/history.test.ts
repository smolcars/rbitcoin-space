import { describe, expect, it } from "vitest";
import { runs } from "../../components/chart/geometry";
import {
  coverageSentence,
  crosshair,
  dataFrom,
  figures,
  filterFrom,
  flowPoints,
  flowSentence,
  isHistory,
  layersFrom,
  netFlow,
  parseInterval,
  pointTime,
  seriesOf,
} from "./history";
import { history, point, T0 } from "./testdata";

describe("intervals", () => {
  it("reads every interval the server serves and falls back to a day", () => {
    expect(parseInterval("2h").id).toBe("2h");
    expect(parseInterval("all").id).toBe("all");
    expect(parseInterval(["1w", "2h"]).id).toBe("1w");
    expect(parseInterval("5m").id).toBe("24h");
    expect(parseInterval(undefined).id).toBe("24h");
  });
});

describe("checking a reply", () => {
  it("accepts the server's shape", () => {
    expect(isHistory(history())).toBe(true);
    expect(isHistory(history({ first: null, points: [] }))).toBe(true);
  });
  it("refuses anything it could not draw", () => {
    expect(isHistory(null)).toBe(false);
    expect(isHistory({ ...history(), step: 0 })).toBe(false);
    expect(isHistory(history({ points: [{ ...point(T0), bands: [1, 2] }] }))).toBe(false);
    expect(isHistory(history({ points: [{ ...point(T0), vsize: Number.NaN }] }))).toBe(false);
    expect(isHistory({ ...history(), points: [{ ...point(T0), count: "1" }] })).toBe(false);
  });
});

describe("coverage", () => {
  it("says nothing when every minute is there, or when there is nothing to qualify", () => {
    expect(coverageSentence(history(), T0)).toBeUndefined();
    expect(coverageSentence(history({ complete: false, points: [] }), T0)).toBeUndefined();
  });
  it("says since when, and how much, when recording began inside the period", () => {
    const h = history({ first: T0 + 6060, complete: false, sampled: 18, minutes: 119 });
    expect(coverageSentence(h, T0)).toBe("15% recorded, from 12 Nov, 15:41 UTC.");
    expect(dataFrom(h)).toBe(T0 + 6060);
    // A year that is not this one stays.
    expect(coverageSentence(h, T0 + 60 * 86_400)).toBe(
      "15% recorded, from 12 Nov 2026, 15:41 UTC.",
    );
  });
  it("names gaps as gaps when recording began before the period", () => {
    const h = history({ first: T0 - 3600, complete: false, sampled: 1, minutes: 1440 });
    expect(coverageSentence(h, T0)).toBe("Under 1% recorded, with gaps while this server was off.");
    expect(dataFrom(h)).toBeUndefined();
  });
  it("ends the hatch where the step holding the first record starts, as its point is drawn there", () => {
    const h = history({
      step: 600,
      first: T0 + 3780,
      complete: false,
      sampled: 5,
      minutes: 10_000,
    });
    expect(dataFrom(h)).toBe(T0 + 3600);
  });
  it("says since when for all of history, which owes only the minutes since the first record", () => {
    // A young server: its first record at 14:00, grouped into the day that starts at midnight.
    const midnight = T0 - 14 * 3600;
    const all = {
      interval: "all",
      from: midnight,
      step: 86_400,
      first: T0,
      points: [point(midnight)],
    };
    expect(dataFrom(history({ ...all, complete: true }))).toBeUndefined();
    expect(coverageSentence(history({ ...all, complete: true }), T0)).toBe(
      "Every minute recorded since 12 Nov, 14:00 UTC.",
    );
    expect(
      coverageSentence(history({ ...all, complete: false, sampled: 30, minutes: 40 }), T0),
    ).toBe("75% recorded, since 12 Nov, 14:00 UTC.");
  });
  it("never rounds a share up to whole", () => {
    const h = history({ first: T0 - 60, complete: false, sampled: 1439, minutes: 1440 });
    expect(coverageSentence(h, T0)).toContain("99%");
  });
});

describe("series", () => {
  const ten = (u: number) => [u, 50, 0, 0, 0, 0, 0, 0, 0, 0];
  const twelve = (a: number, b: number) => [a, b, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0];
  it("joins minutes from before the split to the three finer bands at one point", () => {
    const h = history({
      points: [
        point(T0, { bands: ten(900), vsize: 950 }),
        point(T0 + 60, { bands: twelve(300, 600), vsize: 950 }),
      ],
    });
    const s = seriesOf(h);
    expect(s.unsplit).toStrictEqual([900, 0]);
    expect(s.bands[0]).toStrictEqual([0, 300]);
    expect(s.bands[1]).toStrictEqual([0, 600]);
    // Just before the split point the same total, all under 0.2 as one layer: a vertical edge.
    expect(s.joins).toStrictEqual([
      { index: 1, before: [900, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0] },
    ]);
  });
  it("joins the other way too, leaving the last split point as one layer", () => {
    const h = history({
      points: [
        point(T0, { bands: twelve(300, 600), vsize: 950 }),
        point(T0 + 60, { bands: ten(900), vsize: 950 }),
      ],
    });
    const s = seriesOf(h);
    // The split point keeps its recorded bands for the readout and the figures; only the
    // drawing leaves it as one layer.
    expect(s.unsplit).toStrictEqual([0, 900]);
    expect(s.bands[0]).toStrictEqual([300, 0]);
    expect(s.bands[1]).toStrictEqual([600, 0]);
    expect(s.joins).toStrictEqual([
      { index: 0, after: [900, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0] },
    ]);
    // Every point's layers still add up to its total.
    for (let i = 0; i < 2; i++) {
      const sum = (s.unsplit?.[i] ?? 0) + s.bands.reduce((t, b) => t + (b[i] ?? 0), 0);
      expect(sum).toBe(950);
    }
  });

  it("has one entry per point and no zero where a step is missing", () => {
    const h = history({ points: [point(T0), point(T0 + 60), point(T0 + 300)] });
    const s = seriesOf(h);
    expect(s.x).toStrictEqual([T0, T0 + 60, T0 + 300]);
    expect(s.bands).toHaveLength(12);
    expect(s.bands[6]).toStrictEqual([400_000, 400_000, 400_000]);
    expect(s.unsplit).toBeUndefined();
    expect(s.floor[0]).toBe(0.1);
    expect(s.entered[0]).toBe(100);
    expect(s.mined[0]).toBe(40);
    expect(s.otherwise[0]).toBe(10);
  });
  it("reads a point's time to the minute, or to the day for daily steps", () => {
    expect(pointTime(60)(T0)).toBe("12 Nov 2026, 14:00 UTC");
    expect(pointTime(86_400)(T0)).toBe("12 Nov 2026");
  });
});

describe("flow", () => {
  it("weights each point by its minutes and says which way the mempool went", () => {
    const h = history({
      points: [
        point(T0, { samples: 1, in_vsize: 6000, out_vsize: 0, mined_vsize: 0 }),
        point(T0 + 600, { samples: 3, in_vsize: 6000, out_vsize: 12_000, mined_vsize: 12_000 }),
      ],
    });
    expect(netFlow(h)).toStrictEqual({ entered: 100, mined: 150, otherwise: 0, net: -50 });
    expect(flowSentence(h, "the last week")).toBe(
      "Over the last week, 100 vB/s arrived, blocks took 150 vB/s and 0 vB/s left otherwise: the mempool drained by 50 vB/s on average.",
    );
  });
  it("has nothing to say about an empty period", () => {
    expect(flowSentence(history({ points: [] }), "x")).toBeUndefined();
  });
});

describe("the flow drawn", () => {
  it("reads minutes in ten-minute means, weighted by the minutes seen, so a block's minute never swamps the rest", () => {
    // Ten minutes, one of them holding a block: 600 vB/s mined in that minute is 60 vB/s on average.
    const points = Array.from({ length: 12 }, (_, i) =>
      point(T0 + i * 60, {
        in_vsize: 6000 * (i + 1),
        mined_vsize: i === 3 ? 36_000 : 0,
        out_vsize: i === 3 ? 36_600 : 600,
      }),
    );
    const f = flowPoints(history({ points }));
    expect(f.step).toBe(600);
    // Each point holds its ten minutes' mean: minutes 1 to 10 arrive at 100 to 1,000 vB/s, 550.
    expect(f.entered).toHaveLength(12);
    for (const i of [0, 3, 9]) {
      expect(f.entered[i]).toBeCloseTo(550);
      expect(f.mined[i]).toBeCloseTo(60);
      expect(f.other[i]).toBeCloseTo(10);
    }
    // The last two minutes, through the newest, are a group of their own.
    expect(f.entered[10]).toBeCloseTo(1150);
    expect(f.entered[11]).toBeCloseTo(1150);
  });

  it("never averages across a break in recording", () => {
    // Six minutes missing inside one ten minutes: the size breaks there, and so does the mean.
    const h = history({
      points: [point(T0, { in_vsize: 6000 }), point(T0 + 420, { in_vsize: 18_000 })],
    });
    expect(flowPoints(h).entered).toStrictEqual([100, 300]);
    // Five missing are bridged, and share a mean.
    const bridged = history({
      points: [point(T0, { in_vsize: 6000 }), point(T0 + 360, { in_vsize: 18_000 })],
    });
    expect(flowPoints(bridged).entered).toStrictEqual([200, 200]);
  });

  it("gives the newest value, and the last of every run, a step of its own", () => {
    // Ten quiet minutes, then a minute that opens new ten minutes with a block: 200 vB/s mined.
    const points = Array.from({ length: 11 }, (_, i) =>
      point(T0 + i * 60, { mined_vsize: i === 10 ? 12_000 : 0, out_vsize: i === 10 ? 12_000 : 0 }),
    );
    const { drawn } = flowPoints(history({ points }));
    expect(drawn.x.slice(-3)).toStrictEqual([T0 + 540, T0 + 600, T0 + 660]);
    expect(drawn.mined.slice(-3)).toStrictEqual([0, 200, 200]);
    // A break (six minutes missing, the fewest that break): each run's last value holds over its
    // minute, then a break the paths never join across, though the next point is only 6 min on.
    const broken = flowPoints(history({ points: [point(T0), point(T0 + 420)] })).drawn;
    expect(broken.x).toStrictEqual([T0, T0 + 60, T0 + 60, T0 + 420, T0 + 480]);
    expect(broken.entered).toStrictEqual([100, 100, null, 100, 100]);
    expect(runs(broken.x, (i) => broken.entered[i] !== null, 360)).toStrictEqual([
      [0, 1],
      [3, 4],
    ]);
    // Never past the period's end.
    const end = flowPoints(history({ to: T0 + 30, points: [point(T0)] })).drawn;
    expect(end.x).toStrictEqual([T0, T0 + 30]);
  });

  it("draws coarser steps as recorded", () => {
    const h = history({ step: 3600, points: [point(T0), point(T0 + 3600, { in_vsize: 12_000 })] });
    const f = flowPoints(h);
    expect(f.step).toBe(3600);
    expect(f.entered).toStrictEqual([100, 200]);
  });
});

describe("the fee filter", () => {
  const bands = (b: number[]) => point(T0, { bands: b, vsize: b.reduce((x, y) => x + y, 0) });
  it("offers the first band above where nine tenths of the latest point lie", () => {
    // 60% under 0.12 and 37% at 0.12 to 0.15: from 0.15 up.
    const s = seriesOf(history({ points: [bands([600, 370, 10, 10, 0, 0, 0, 0, 0, 0, 0, 10])] }));
    expect(filterFrom(s)).toBe(2);
    // Under nine tenths in the lowest band alone: from 0.12 up.
    const t = seriesOf(history({ points: [bands([950, 30, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0])] }));
    expect(filterFrom(t)).toBe(1);
  });

  it("offers nothing when nothing would be left, or nothing waits", () => {
    const all = seriesOf(history({ points: [bands([1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])] }));
    expect(filterFrom(all)).toBe(0);
    const none = seriesOf(history({ points: [bands(Array.from({ length: 12 }, () => 0))] }));
    expect(filterFrom(none)).toBe(0);
    // Spread out, with no cheap bulk: the dearest tenth is only in the top band.
    const spread = seriesOf(
      history({ points: [bands([100, 100, 100, 100, 100, 100, 100, 100, 100, 50, 50, 100])] }),
    );
    expect(filterFrom(spread)).toBe(11);
  });

  it("starts at 0.2 or above where the latest point is from before the split", () => {
    const old = point(T0, { bands: [950, 20, 10, 10, 0, 0, 0, 0, 0, 10], vsize: 1000 });
    expect(filterFrom(seriesOf(history({ points: [old] })))).toBe(3);
  });

  it("keeps the bands from the filter up, and the unsplit layer only when all are shown", () => {
    const old = point(T0, { bands: [150_000, 50_000, 400_000, 0, 0, 0, 0, 0, 0, 0] });
    const s = seriesOf(history({ points: [old, point(T0 + 60)] }));
    expect(layersFrom(s, 0).layers.map((l) => l.band)).toStrictEqual([
      -1,
      ...Array.from({ length: 12 }, (_, k) => k),
    ]);
    const from = layersFrom(s, 2);
    expect(from.layers.map((l) => l.band)).toStrictEqual(
      Array.from({ length: 10 }, (_, k) => k + 2),
    );
    // The join keeps one value per layer drawn.
    expect(from.joins[0]?.before).toHaveLength(10);
  });
});

describe("the crosshair", () => {
  it("reads both strips at the one point: the bands shown and its ten minutes' flow", () => {
    // Arrivals at 100 vB/s in the first ten minutes, 300 vB/s in the next.
    const points = Array.from({ length: 20 }, (_, i) =>
      point(T0 + i * 60, { in_vsize: i < 10 ? 6000 : 18_000 }),
    );
    const h = history({ points });
    const s = seriesOf(h);
    const f = flowPoints(h);
    expect(crosshair(h, s, f, 3, 0)?.flow.entered).toBe(100);
    expect(crosshair(h, s, f, 13, 0)?.flow.entered).toBe(300);
    expect(crosshair(h, s, f, 13, 0)?.point.time).toBe(T0 + 780);
    // The test point holds 100 kvB under 0.12, 50 kvB at 0.5 to 1 and 400 kvB at 1 to 1.5.
    expect(crosshair(h, s, f, 13, 0)?.shown).toBe(550_000);
    expect(crosshair(h, s, f, 13, 6)?.shown).toBe(400_000);
    expect(crosshair(h, s, f, 20, 0)).toBeUndefined();
  });
});

describe("the four figures", () => {
  it("say what waits now, the change and peak, the flow, and how deep the next block reaches", () => {
    const h = history({
      points: [
        point(T0, { vsize: 900_000 }),
        point(T0 + 60, { vsize: 2_000_000 }),
        // 1.2 MvB at 1 to 1.5 and dearer: the dearest block's worth stops in that band.
        point(T0 + 120, {
          vsize: 1_500_000,
          bands: [300_000, 0, 0, 0, 0, 0, 1_000_000, 0, 0, 200_000, 0, 0],
        }),
      ],
    });
    const f = figures(h);
    expect(f?.last.vsize).toBe(1_500_000);
    expect(f?.change).toBe(600_000);
    expect(f?.peak.vsize).toBe(2_000_000);
    expect(f?.deep).toBe(6);
    expect(f?.flow?.entered).toBeCloseTo(100);
    // Less than a block waiting: everything goes.
    expect(figures(history())?.deep).toBe(-1);
    expect(figures(history({ points: [] }))).toBeUndefined();
  });
});
