import { describe, expect, it } from "vitest";
import { parseBezier, parseColor } from "./gl";
import { type GridTx, layout } from "./layout";
import { ease, type Motion, Scene, STRIDE } from "./scene";

const MOTION: Motion = {
  block: 900,
  slow: 520,
  base: 260,
  fade: 140,
  stagger: 45,
  settle: [0.3, 1.45, 0.6, 1],
  inOut: [0.65, 0, 0.35, 1],
};
const REDUCED: Motion = { ...MOTION, block: 0, slow: 0, base: 0 };

const tx = (id: number | string, vsize: number, rate: number): GridTx => ({
  id,
  vsize,
  fee: Math.round(rate * vsize),
  value: 1000,
});
const txs = [tx("a", 400, 5), tx("b", 200, 2), tx("c", 900, 0.5), tx("d", 150, 1)];
const at = (l: ReturnType<typeof layout>, list: readonly GridTx[], id: string) => {
  const r = [...l.order].findIndex((i) => list[i]?.id === id);
  return [l.x[r] ?? 0, l.y[r] ?? 0, l.w[r] ?? 0, l.h[r] ?? 0, 1];
};
const record = (s: Scene, id: string) => {
  const i = s.ids.indexOf(id);
  return [...s.data].slice(i * STRIDE, (i + 1) * STRIDE);
};
const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, k) => expect(v).toBeCloseTo(b[k] ?? Number.NaN, 4));

describe("Scene", () => {
  it("dims and lights squares where they stand, the lit ones growing back into place", () => {
    const l = layout(txs, 1.2, 100_000);
    const s = new Scene(0);
    s.update(l, txs, 0, "snap", MOTION, (t) => (t.id === "b" ? 1 : 0.16));
    expect(record(s, "a")[13]).toBeCloseTo(0.16);
    expect(record(s, "b")[13]).toBe(1);
    expect(s.lit).toBe(1);
    const targets = s.ids.map((id) => record(s, String(id)).slice(4, 8));
    s.relight((r) => (s.ids[r] === "a" ? 1 : 0.16), 1000, MOTION);
    // No square goes anywhere new: only alphas change.
    expect(s.ids.map((id) => record(s, String(id)).slice(4, 8))).toStrictEqual(targets);
    const a = record(s, "a");
    close(a.slice(4, 8), at(l, txs, "a").slice(0, 4));
    expect(a[12]).toBeCloseTo(0.16);
    expect(a[13]).toBe(1);
    expect(a[2] ?? 0).toBeLessThan(a[6] ?? 0); // grows from smaller
    const b = record(s, "b");
    close(b.slice(0, 4), b.slice(4, 8)); // fades where it is
    expect(b[13]).toBeCloseTo(0.16);
    expect(s.lit).toBe(1);
    // Unchanged squares keep their record.
    expect(record(s, "c")[9]).toBe(0);
    expect(s.end).toBeGreaterThan(1000);
    // Lit again with nothing to change: nothing restarts.
    const before = [...s.data];
    s.relight((r) => (s.ids[r] === "a" ? 1 : 0.16), 2000, MOTION);
    expect([...s.data]).toStrictEqual(before);
  });

  it("only fades dimmed squares to a new dim level, as a theme switch gives", () => {
    const l = layout(txs, 1.2, 100_000);
    const s = new Scene(0);
    s.update(l, txs, 0, "snap", MOTION, (t) => (t.id === "b" ? 1 : 0.14));
    s.relight((r) => (s.ids[r] === "b" ? 1 : 0.2), 1000, MOTION);
    const a = record(s, "a");
    close(a.slice(0, 4), a.slice(4, 8)); // where it stands, its size kept
    expect(a[12]).toBeCloseTo(0.14);
    expect(a[13]).toBeCloseTo(0.2);
    expect(a[10]).toBe(1); // in-out, not the settle a lit square grows with
  });

  it("relights with a fade alone under reduced motion", () => {
    const l = layout(txs, 1.2, 100_000);
    const s = new Scene(0);
    s.update(l, txs, 0, "snap", REDUCED, () => 0.2);
    s.relight(() => 1, 500, REDUCED);
    const a = record(s, "a");
    close(a.slice(0, 4), a.slice(4, 8));
    expect(a[9]).toBe(REDUCED.fade);
  });

  it("keeps each square's alpha through a change of layout", () => {
    const s = new Scene(0);
    const lit = (t: GridTx) => (t.id === "a" ? 1 : 0.2);
    s.update(layout(txs, 1.2, 100_000), txs, 0, "snap", MOTION, lit);
    const more = [...txs, tx("e", 300, 3)];
    s.update(layout(more, 1.2, 100_000), more, 100, "change", MOTION, lit);
    expect(record(s, "a")[13]).toBe(1);
    expect(record(s, "e")[13]).toBeCloseTo(0.2);
    expect(record(s, "c")[12]).toBeCloseTo(0.2); // from where it was
  });

  it("pours the squares in, cheapest first, each settling where the layout puts it", () => {
    const l = layout(txs, 1.2, 100_000);
    const s = new Scene(0);
    s.update(l, txs, 0, "pour", MOTION);
    expect(s.count).toBe(4);
    expect(s.live).toBe(4);
    expect(s.ids).toStrictEqual(["a", "b", "d", "c"]); // by rate, highest first
    const starts = s.ids.map((id) => record(s, String(id))[8] ?? 0);
    // The cheapest starts at once, the dearest last; the whole pour takes --dur-block.
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts a copy; toSorted is newer than the browsers we build for
    expect(starts).toStrictEqual([...starts].sort((p, q) => q - p));
    expect(starts.at(-1)).toBe(0);
    expect(s.end).toBe(MOTION.block);
    for (const id of ["a", "b", "c", "d"]) {
      const [x, y, w, h, alpha] = s.sample(s.ids.indexOf(id), 0, MOTION);
      const to = at(l, txs, id);
      close([x, w, h, alpha], [to[0] ?? 0, to[2] ?? 0, to[3] ?? 0, 0]);
      expect(y).toBeLessThan(to[1] ?? 0); // above, falling
      close(s.sample(s.ids.indexOf(id), 2000, MOTION), to);
    }
  });

  it("only fades under reduced motion", () => {
    const l = layout(txs, 1.2, 100_000);
    const s = new Scene(0);
    s.update(l, txs, 0, "pour", REDUCED);
    expect(s.end).toBe(REDUCED.fade);
    for (const id of ["a", "b", "c", "d"]) {
      const [x, y, w, h, alpha] = s.sample(s.ids.indexOf(id), 0, REDUCED);
      close([x, y, w, h, alpha], [...at(l, txs, id).slice(0, 4), 0]);
    }
  });

  it("adds, removes and moves squares when driven by changes", () => {
    const s = new Scene(0);
    const first = layout(txs, 1.2, 100_000);
    s.update(first, txs, 0, "snap", MOTION);
    expect(s.end).toBe(0);
    // "a" leaves, "e" enters at the top rate, "c" pays more and moves up.
    const next = [tx("b", 200, 2), tx("c", 900, 3), tx("d", 150, 1), tx("e", 300, 9)];
    const second = layout(next, 1.2, 100_000);
    s.update(second, next, 1000, "change", MOTION);
    expect(s.ids).toStrictEqual(["e", "c", "b", "d", "a"]);
    expect(s.live).toBe(4);
    // Moved: from where it was to where it goes, travelling.
    const c = s.ids.indexOf("c");
    close(s.sample(c, 1000, MOTION), at(first, txs, "c"));
    close(s.sample(c, 3000, MOTION), at(second, next, "c"));
    // Added: drops in from above, transparent at first.
    const e = s.ids.indexOf("e");
    expect(s.sample(e, 1000, MOTION)[4]).toBe(0);
    close(s.sample(e, 3000, MOTION), at(second, next, "e"));
    // Removed: fades and shrinks where it stood.
    const a = s.ids.indexOf("a");
    close(s.sample(a, 1000, MOTION), at(first, txs, "a"));
    expect(s.sample(a, 3000, MOTION)[4]).toBe(0);
    // Once faded, a later change forgets it.
    s.update(second, next, 5000, "change", MOTION);
    expect(s.ids).toStrictEqual(["e", "c", "b", "d"]);
    // Nothing changed this time, so nothing animates.
    expect(s.end).toBe(5000);
  });

  it("starts a change from where a moving square is now", () => {
    const s = new Scene(0);
    const one = layout(txs, 1.2, 100_000);
    s.update(one, txs, 0, "pour", MOTION);
    const mid = s.sample(s.ids.indexOf("c"), 300, MOTION);
    expect(mid[3]).toBeGreaterThan(0);
    const next = txs.filter((t) => t.id !== "a");
    s.update(layout(next, 1.2, 100_000), next, 300, "change", MOTION);
    close(s.sample(s.ids.indexOf("c"), 300, MOTION), mid);
  });

  it("finishes every animation at once, as when a hidden tab comes back", () => {
    const s = new Scene(0);
    const l = layout(txs, 1.2, 100_000);
    s.update(l, txs, 0, "pour", MOTION);
    s.finish();
    expect(s.end).toBe(0);
    close(s.sample(s.ids.indexOf("a"), 0, MOTION), at(l, txs, "a"));
  });
});

describe("ease", () => {
  it("runs from 0 to 1, overshooting only for things that land", () => {
    for (const c of [MOTION.settle, MOTION.inOut]) {
      expect(ease(c, 0)).toBe(0);
      expect(ease(c, 1)).toBe(1);
    }
    expect(ease(MOTION.inOut, 0.5)).toBeCloseTo(0.5, 3);
    const settle = Array.from({ length: 99 }, (_, i) => ease(MOTION.settle, (i + 1) / 100));
    expect(Math.max(...settle)).toBeGreaterThan(1);
  });
});

describe("token parsing", () => {
  it("reads colors as the tokens and browsers write them", () => {
    expect(parseColor("#4f6dcc")).toStrictEqual([0x4f / 255, 0x6d / 255, 0xcc / 255]);
    expect(parseColor(" #fff ")).toStrictEqual([1, 1, 1]);
    expect(parseColor("rgb(255, 0, 51)")).toStrictEqual([1, 0, 0.2]);
    expect(parseColor("rgb(255 0 51 / 50%)")).toStrictEqual([1, 0, 0.2]);
    expect(parseColor("oklch(0.5 0.1 200)")).toBeUndefined();
  });

  it("reads cubic-bezier curves", () => {
    expect(parseBezier(" cubic-bezier(0.3, 1.45, 0.6, 1)")).toStrictEqual([0.3, 1.45, 0.6, 1]);
    expect(parseBezier("ease")).toBeUndefined();
    expect(parseBezier("cubic-bezier(1, 2)")).toBeUndefined();
  });
});
