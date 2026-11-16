import { describe, expect, it } from "vitest";
import { history, point, T0 } from "../mempool/testdata";
import { incoming } from "./incoming";

describe("the incoming rate", () => {
  it("is what entered each minute, in vB a second, over the whole period", () => {
    const h = history({
      first: T0 - 86_400,
      points: [point(T0, { in_vsize: 6000 }), point(T0 + 60, { in_vsize: 90 })],
    });
    expect(incoming(h)).toStrictEqual({
      x: [T0, T0 + 60],
      values: [100, 1.5],
      domain: [T0, T0 + 7200],
    });
  });

  it("starts at the first record when recording began inside the period", () => {
    const h = history({ first: T0 + 3630, points: [point(T0 + 3600)] });
    expect(incoming(h).domain).toStrictEqual([T0 + 3600, T0 + 7200]);
  });

  it("draws nothing when nothing is stored", () => {
    expect(incoming(history({ first: null, points: [] }))).toStrictEqual({
      x: [],
      values: [],
      domain: [T0, T0 + 7200],
    });
  });
});
