import { describe, expect, it } from "vitest";
import { BENCH, budget } from "../../lib/budget";
import { feeBand } from "../../lib/format";
import { type GridTx, gridSize, hitTest, type Layout, layout, MIN_AREA, rank } from "./layout";
import { COINBASE_COLOR, colorOf } from "./scene";

/** A repeatable pseudo-random source (mulberry32). */
function random(seed: number) {
  let a = seed;
  return () => {
    a = Math.trunc(a + 0x6d2b79f5) % 2 ** 32;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A block like today's: mostly 110–300 vB at under 1 sat/vB, some large ones, `total` vB in all. */
function block(total: number, seed = 1): GridTx[] {
  const rnd = random(seed);
  const txs: GridTx[] = [{ id: 0, vsize: 180, fee: 0, value: 313_000_000, coinbase: true }];
  let used = 180;
  while (used < total) {
    const big = rnd() < 0.02;
    const vsize = Math.min(
      total - used,
      Math.round(big ? 1000 + rnd() * 20_000 : 60 + rnd() * 300),
    );
    if (vsize <= 0) break;
    const rate = rnd() < 0.6 ? 0.1 + rnd() * 0.9 : rnd() * 30;
    txs.push({ id: txs.length, vsize, fee: Math.round(rate * vsize), value: 10_000 });
    used += vsize;
  }
  return txs;
}

const FULL = block(999_000);

/**
 * Checks the layout's own promises: every rectangle inside the packed area, areas that follow vsize
 * and add up to the packed area, and every point of the packed area inside exactly the rectangle
 * the hit test names: together, no gaps and no overlaps.
 */
function check(l: Layout, txs: readonly GridTx[]) {
  const faults: string[] = [];
  const eps = 1e-6;
  // Each area is the vsize's, at least MIN_AREA, all shrunk alike when the minimums overrun.
  const wanted = [...l.order].map((i) => {
    const v = txs[i]?.vsize ?? 0;
    return v > 0 ? Math.max(MIN_AREA, v / l.unit) : 0;
  });
  const packed = l.width * (l.rows - l.offset);
  const fit =
    packed /
    Math.max(
      packed,
      wanted.reduce((sum, a) => sum + a, 0),
    );
  let sum = 0;
  for (let r = 0; r < l.order.length; r++) {
    const [x, y, w, h] = [l.x[r] ?? -1, l.y[r] ?? -1, l.w[r] ?? 0, l.h[r] ?? 0];
    if (x < -eps || y < l.offset - eps || x + w > l.width + eps || y + h > l.rows + eps)
      faults.push(`rect ${r} is outside`);
    const a = (wanted[r] ?? 0) * fit;
    if (Math.abs(w * h - a) > 1e-6 * Math.max(1, a))
      faults.push(`rect ${r} area ${w * h} for ${a}`);
    sum += w * h;
  }
  if (Math.abs(sum - packed) > 1e-6 * Math.max(1, packed)) faults.push(`areas ${sum} of ${packed}`);
  const steps = 157;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const cx = ((i + 0.5) / steps) * l.width;
      const cy = l.offset + ((j + 0.5) / steps) * (l.rows - l.offset);
      const r = hitTest(l, cx, cy);
      const inside =
        r !== -1 &&
        cx >= (l.x[r] ?? 0) - eps &&
        cy >= (l.y[r] ?? 0) - eps &&
        cx <= (l.x[r] ?? 0) + (l.w[r] ?? 0) + eps &&
        cy <= (l.y[r] ?? 0) + (l.h[r] ?? 0) + eps;
      if (packed > 1 && !inside) faults.push(`point ${cx},${cy} hits ${r}`);
    }
  }
  expect(faults.slice(0, 5)).toStrictEqual([]);
}

describe("layout", () => {
  it("draws a full block as one clean rectangle, no gaps and no overlaps, sized by vsize", () => {
    const l = layout(FULL, 6 / 5, 1_000_000);
    expect(l.order).toHaveLength(FULL.length);
    check(l, FULL);
    // A full block leaves almost nothing above it.
    expect(l.offset / l.rows).toBeLessThan(0.002);
  });

  it("keeps ordinary transactions close to square", () => {
    const l = layout(FULL, 6 / 5, 1_000_000);
    const ratios = [...l.order].map((_, r) => {
      const w = l.w[r] ?? 0;
      const h = l.h[r] ?? 0;
      return Math.max(w / h, h / w);
    });
    ratios.sort((p, q) => p - q);
    const at = (share: number) => ratios[Math.floor(ratios.length * share)] ?? Number.NaN;
    // The typical rectangle is nearly square; a few at the seams between fee bands are not.
    expect(at(0.5)).toBeLessThan(1.5);
    expect(at(0.95)).toBeLessThan(6);
  });

  // A speed budget (lib/budget.ts), on request:
  // `BENCH=1 bunx vitest run src/components/txgrid/layout.test.ts`.
  it.skipIf(!BENCH)("is fast enough to run on the main thread", () => {
    // A few ms in a browser.
    expect(budget(200, () => layout(FULL, 6 / 5, 1_000_000)).rows).toBeGreaterThan(0);
  });

  it("draws the same picture for the same block, in any input order", () => {
    const shuffled = [...FULL];
    const rnd = random(7);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as GridTx, shuffled[i] as GridTx];
    }
    const a = layout(FULL, 6 / 5, 1_000_000);
    const b = layout(shuffled, 6 / 5, 1_000_000);
    const pictureOf = (l: Layout, txs: readonly GridTx[]) =>
      [...l.order].map((i, r) => [txs[i]?.id, l.x[r], l.y[r], l.w[r], l.h[r]]);
    expect(pictureOf(b, shuffled)).toStrictEqual(pictureOf(a, FULL));
  });

  it("starts with the coinbase, then the dearest fee band, at the top left", () => {
    const l = layout(FULL, 6 / 5, 1_000_000);
    expect(FULL[l.order[0] ?? -1]?.coinbase).toBe(true);
    expect([l.x[0], l.y[0]]).toStrictEqual([0, l.offset]);
    // By band, dearest first: within a band the colour is the same, so size orders it.
    const bands = [...l.order].slice(1).map((i) => {
      const t = FULL[i];
      return t ? feeBand(t.fee / t.vsize) : 0;
    });
    for (let r = 1; r < bands.length; r++)
      expect(bands[r] ?? 0).toBeLessThanOrEqual(bands[r - 1] ?? 0);
  });

  it("fills a half-full block half way, from the floor, leaving the rest as one empty band", () => {
    const half = block(500_000, 3);
    const l = layout(half, 6 / 5, 1_000_000);
    check(l, half);
    const used = half.reduce((s, t) => s + t.vsize, 0);
    expect(l.offset / l.rows).toBeCloseTo(1 - used / 1_000_000, 6);
  });

  it("holds at extreme frame shapes", () => {
    for (const aspect of [1 / 40, 1 / 3, 3, 40]) {
      const l = layout(FULL, aspect, 1_000_000);
      check(l, FULL);
      expect(l.order).toHaveLength(FULL.length);
    }
  });

  it("draws a nearly empty block as a small rectangle on the floor at the left, seen", () => {
    const only = [{ id: 0, vsize: 180, fee: 0, value: 1, coinbase: true }];
    const l = layout(only, 6 / 5, 1_000_000);
    check(l, only);
    expect(l.x[0]).toBe(0);
    expect((l.y[0] ?? 0) + (l.h[0] ?? 0)).toBeCloseTo(l.rows, 6);
    // A square of at least a few cells, not a sliver across the frame.
    expect(l.w[0]).toBeCloseTo(l.h[0] ?? 0, 6);
    expect(l.w[0]).toBeGreaterThanOrEqual(2);
    // Regtest's blocks: a coinbase and two small transactions, each big enough to point at.
    const few = [
      ...only,
      { id: 1, vsize: 150, fee: 300, value: 1 },
      { id: 2, vsize: 200, fee: 100, value: 1 },
    ];
    const k = layout(few, 6 / 5, 1_000_000);
    check(k, few);
    for (let r = 0; r < 3; r++)
      expect((k.w[r] ?? 0) * (k.h[r] ?? 0)).toBeGreaterThanOrEqual(MIN_AREA - 1e-9);
  });

  it("fits one enormous transaction beside thousands of small ones", () => {
    const txs = [...block(600_000, 5), { id: "big", vsize: 390_000, fee: 39_000, value: 1 }];
    const l = layout(txs, 6 / 5, 1_000_000);
    check(l, txs);
    expect(l.offset / l.rows).toBeCloseTo(0.01, 1);
  });

  it("scales everything down to fit when there is more than the capacity", () => {
    const over = block(1_500_000, 9);
    const l = layout(over, 6 / 5, 1_000_000);
    check(l, over);
    expect(l.offset).toBeCloseTo(0, 6);
  });

  it("draws transactions of no size as nothing, and nothing for no transactions", () => {
    const zero = [...block(100_000, 2), { id: "zero", vsize: 0, fee: 0, value: 0 }];
    check(layout(zero, 6 / 5, 1_000_000), zero);
    const l = layout([], 6 / 5, 1_000_000);
    expect(l.order).toHaveLength(0);
    expect(hitTest(l, 1, 1)).toBe(-1);
  });
});

describe("hitTest", () => {
  it("answers none outside the grid and above the rectangles", () => {
    const l = layout(block(100_000), 6 / 5, 1_000_000);
    expect(hitTest(l, -0.5, l.rows - 1)).toBe(-1);
    expect(hitTest(l, l.cols, l.rows - 1)).toBe(-1);
    expect(hitTest(l, 1, l.rows)).toBe(-1);
    expect(hitTest(l, 1, 0)).toBe(-1);
    expect(hitTest(l, Number.NaN, 1)).toBe(-1);
  });

  it("is fast on thousands of rectangles", () => {
    const l = layout(FULL, 6 / 5, 1_000_000);
    const found = budget(100, () => {
      let hits = 0;
      for (let i = 0; i < 100_000; i++)
        if (hitTest(l, (i * 7) % l.cols, (i * 13) % l.rows) !== -1) hits++;
      return hits;
    });
    expect(found).toBeGreaterThan(0);
  });
});

describe("gridSize", () => {
  it("keeps the grid when the frame changes by a pixel", () => {
    expect(gridSize(600 / 500)).toStrictEqual(gridSize(601 / 500));
    expect(gridSize(320 / 266)).toStrictEqual(gridSize(600 / 500));
  });
});

describe("rank and colors", () => {
  it("orders and colors by a given rate over fee / vsize, as a projected block's records need", () => {
    // A child paying little itself, mined in a chunk at 5 sat/vB with its parent.
    const child = { id: "child", vsize: 100, fee: 10, rate: 5 };
    const other = { id: "other", vsize: 100, fee: 300 };
    expect([...rank([other, child])]).toStrictEqual([1, 0]);
    expect(colorOf(child)).toBe(feeBand(5) - 1);
  });

  it("treats an omitted coinbase flag as false", () => {
    const txs: GridTx[] = [
      { id: 0, vsize: 100, fee: 1, value: 0 },
      { id: 1, vsize: 100, fee: 1000, value: 0, coinbase: false },
    ];
    expect([...rank(txs)]).toStrictEqual([1, 0]);
    // oxlint-disable-next-line unicorn/no-array-reverse -- reverses a copy; toReversed is newer than the browsers we build for
    expect([...rank([...txs].reverse())]).toStrictEqual([0, 1]);
  });

  it("breaks ties by id, numbers before strings", () => {
    const txs: GridTx[] = [
      { id: "b", vsize: 100, fee: 100, value: 0 },
      { id: 2, vsize: 100, fee: 100, value: 0 },
      { id: "a", vsize: 100, fee: 100, value: 0 },
    ];
    expect([...rank(txs)]).toStrictEqual([1, 2, 0]);
  });

  it("colors by the band of the rate as printed, as feeBand does", () => {
    for (const [fee, vsize] of [
      [1996, 10_000], // 0.1996 prints as 0.20: band 4
      [1994, 10_000],
      [9996, 1000], // 9.996 prints as 10.0: band 12
      [100, 1000],
      [0, 100],
    ] as const) {
      expect(colorOf({ id: 1, vsize, fee, value: 0 })).toBe(feeBand(fee / vsize) - 1);
    }
    expect(colorOf({ id: 0, vsize: 100, fee: 0, value: 0, coinbase: true })).toBe(COINBASE_COLOR);
    expect(colorOf({ id: 1, vsize: 10_000, fee: 1996, value: 0 })).toBe(3);
  });
});
