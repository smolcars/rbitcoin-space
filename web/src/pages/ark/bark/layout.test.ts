import { describe, expect, it } from "vitest";
import { axisX, layout } from "./layout";

describe("layout", () => {
  it("raises the tree from the anchor and runs transfers sideways", () => {
    const l = layout(["branch", "leaf", "transfer", "transfer"], 1200);
    expect(l.nodes).toHaveLength(4);
    expect(l.edges).toHaveLength(4);
    const [b, leaf, t1, t2] = l.nodes;
    expect(b?.x).toBe(l.anchor.x);
    expect(leaf?.x).toBe(l.anchor.x);
    expect(leaf?.y ?? 0).toBeLessThan(b?.y ?? 0);
    expect(t1?.y).toBe(leaf?.y);
    expect(t2?.x ?? 0).toBeGreaterThan(t1?.x ?? 0);
    expect(l.height).toBeGreaterThan(l.baseline);
  });

  it("wraps transfers into rows on a narrow screen, everything inside the width", () => {
    const kinds = ["branch", ...Array.from({ length: 12 }, () => "transfer" as const)] as const;
    const l = layout(kinds, 340);
    const ys = new Set(l.nodes.slice(1).map((n) => n.y));
    expect(ys.size).toBeGreaterThan(1);
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(l.width);
      expect(n.y).toBeGreaterThan(0);
    }
    // Each row sits above the one before it.
    const rows = [...ys];
    expect(rows.slice(1).every((y, k) => y < (rows[k] ?? 0))).toBe(true);
  });

  it("draws a VTXO with no exit transactions as the anchor alone", () => {
    const l = layout([], 800);
    expect(l.nodes).toStrictEqual([]);
    expect(l.edges).toStrictEqual([]);
  });

  it("puts heights on the axis between the anchor and the far end", () => {
    const l = layout(["branch"], 1000);
    expect(axisX(l, 100, 100, 200)).toBe(l.anchor.x);
    expect(axisX(l, 200, 100, 200)).toBe(l.axis.to - 4);
    expect(axisX(l, 500, 100, 200)).toBe(l.axis.to - 4);
    expect(axisX(l, 150, 100, 200)).toBeCloseTo((l.anchor.x + l.axis.to - 4) / 2);
  });
});
