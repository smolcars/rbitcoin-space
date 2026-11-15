// The squares in motion: where each one comes from, goes to and when, as one instance record each
// for the GPU. Pure, so changes can be tested without a browser.
import { FEE_BANDS, feeBand } from "../../lib/format";
import { type GridTx, type Layout, rateOf } from "./layout";

/** A CSS `cubic-bezier(x1, y1, x2, y2)`. */
export type Bezier = readonly [number, number, number, number];

/** Durations in ms and curves, read from the design tokens so reduced motion applies here too. */
export interface Motion {
  /** `--dur-block`: the whole pour on load. */
  block: number;
  /** `--dur-slow`: one square settling or moving. */
  slow: number;
  /** `--dur-base`: one square leaving. */
  base: number;
  /** `--dur-fade`: the fade that remains under reduced motion. */
  fade: number;
  /** `--stagger` */
  stagger: number;
  /** `--ease-settle`: things that land. */
  settle: Bezier;
  /** `--ease-in-out`: things that travel. */
  inOut: Bezier;
}

/**
 * Floats per rectangle: from (x, y, w, h), to (x, y, w, h), start, duration, curve, color, then
 * alpha from and to.
 */
export const STRIDE = 14;
/** Color slot of the coinbase, after the ten fee bands. */
export const COINBASE_COLOR = FEE_BANDS;
const SETTLE = 0;
const IN_OUT = 1;

/** How a new set of squares arrives. */
export type Arrival = "pour" | "change" | "snap";

/** y of a cubic Bézier easing at progress x, by Newton's method; the shader does the same. */
export function ease(c: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = c;
  const at = (a: number, b: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  let t = x;
  for (let i = 0; i < 8; i++) {
    const u = 1 - t;
    const slope = 3 * u * u * x1 + 6 * u * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(slope) < 1e-6) break;
    t = Math.min(1, Math.max(0, t - (at(x1, x2, t) - x) / slope));
  }
  return at(y1, y2, t);
}

// Banding formats the rate, the dearest step of an update; a transaction's band never changes.
const colors = new WeakMap<GridTx, number>();

/** The color slot of a transaction: its fee band (0–9) as printed, or the coinbase's. */
export function colorOf(tx: GridTx): number {
  let c = colors.get(tx);
  if (c === undefined) {
    c = tx.coinbase === true ? COINBASE_COLOR : feeBand(rateOf(tx)) - 1;
    colors.set(tx, c);
  }
  return c;
}

/**
 * Every square drawn, live ones first in rank order (so a square's instance is its rank), then
 * those still fading out. Times are ms after the scene's `epoch`.
 */
export class Scene {
  data = new Float32Array(0);
  ids: (number | string)[] = [];
  /** Live squares; the rest are leaving. */
  live = 0;
  /** When the last animation ends, ms after the epoch. */
  end = 0;
  readonly epoch: number;

  constructor(epoch: number) {
    this.epoch = epoch;
  }

  /** Where rectangle `i` is at `now` (ms after the epoch): x, y, w, h, alpha. */
  sample(i: number, now: number, motion: Motion): [number, number, number, number, number] {
    const o = i * STRIDE;
    const d = this.data;
    const dur = d[o + 9] ?? 0;
    const p = dur > 0 ? Math.min(1, Math.max(0, (now - (d[o + 8] ?? 0)) / dur)) : 1;
    const e = ease(d[o + 10] === IN_OUT ? motion.inOut : motion.settle, p);
    const fadeP = Math.min(1, p * 1.6);
    const mix = (k: number, w: number) =>
      (d[o + k] ?? 0) + ((d[o + 4 + k] ?? 0) - (d[o + k] ?? 0)) * w;
    const alpha = (d[o + 12] ?? 0) + ((d[o + 13] ?? 0) - (d[o + 12] ?? 0)) * fadeP;
    return [mix(0, e), mix(1, e), mix(2, e), mix(3, e), alpha];
  }

  /**
   * Moves to a new layout at `now` (ms after the epoch). Squares are matched by id: a square that
   * stays travels from wherever it is now, a new one drops in, and one that went fades out.
   */
  update(
    l: Layout,
    txs: readonly GridTx[],
    now: number,
    arrival: Arrival,
    motion: Motion,
    alphaOf: (tx: GridTx) => number = () => 1,
  ): void {
    const reduced = motion.slow === 0;
    const was = new Map<number | string, number>();
    for (const [i, id] of this.ids.entries()) was.set(id, i);
    const n = l.order.length;
    const out = new Float32Array((n + was.size) * STRIDE);
    const ids: (number | string)[] = [];
    let end = now;
    const push = (
      id: number | string,
      from: readonly number[],
      to: readonly number[],
      start: number,
      dur: number,
      curve: number,
      color: number,
    ) => {
      const o = ids.length * STRIDE;
      ids.push(id);
      out.set(from.slice(0, 4), o);
      out.set(to.slice(0, 4), o + 4);
      out[o + 12] = from[4] ?? 1;
      out[o + 13] = to[4] ?? 1;
      out[o + 8] = start;
      out[o + 9] = dur;
      out[o + 10] = curve;
      out[o + 11] = color;
      end = Math.max(end, start + dur);
    };
    const drop = Math.max(2, l.rows * (arrival === "pour" ? 0.08 : 0.03));
    for (let r = 0; r < n; r++) {
      const tx = txs[l.order[r] ?? 0];
      if (!tx) continue;
      const to = [l.x[r] ?? 0, l.y[r] ?? 0, l.w[r] ?? 0, l.h[r] ?? 0, alphaOf(tx)];
      const color = colorOf(tx);
      const old = was.get(tx.id);
      if (old !== undefined) was.delete(tx.id);
      if (arrival === "snap") {
        push(tx.id, to, to, now, 0, SETTLE, color);
        continue;
      }
      // Cheapest first on load, like sediment; leaders first when things shift.
      const lag =
        arrival === "pour"
          ? reduced
            ? 0
            : ((n - 1 - r) / Math.max(1, n - 1)) * Math.max(0, motion.block - motion.slow)
          : reduced
            ? 0
            : (r / Math.max(1, n)) * motion.stagger * 4;
      if (old === undefined || arrival === "pour") {
        const from = reduced
          ? [to[0] ?? 0, to[1] ?? 0, to[2] ?? 0, to[3] ?? 0, 0]
          : [to[0] ?? 0, (to[1] ?? 0) - drop, to[2] ?? 0, to[3] ?? 0, 0];
        push(tx.id, from, to, now + lag, reduced ? motion.fade : motion.slow, SETTLE, color);
        continue;
      }
      const from = this.sample(old, now, motion);
      const still = from.every((v, k) => Math.abs(v - (to[k] ?? 0)) < 1e-3);
      if (still || reduced) push(tx.id, to, to, now, 0, IN_OUT, color);
      else push(tx.id, from, to, now + lag, motion.slow, IN_OUT, color);
    }
    const live = ids.length;
    // Gone: fade and shrink where they are. Those already faded are dropped.
    for (const [id, i] of was) {
      const from = this.sample(i, now, motion);
      if (from[4] <= 0.001 || arrival === "snap") continue;
      const [x, y, w, h] = from;
      const to = reduced ? [x, y, w, h, 0] : [x + w * 0.25, y + h * 0.25, w * 0.5, h * 0.5, 0];
      push(
        id,
        from,
        to,
        now,
        reduced ? motion.fade : motion.base,
        IN_OUT,
        this.data[i * STRIDE + 11] ?? 0,
      );
    }
    this.data = out.slice(0, ids.length * STRIDE);
    this.ids = ids;
    this.live = live;
    this.end = end;
  }

  /**
   * Fades live squares to the alpha `alphaOf(rank)` gives, where they stand, with no new layout. A
   * square coming up to full alpha also grows into place, leaders first, so a few lit squares
   * catch the eye; under reduced motion it only fades.
   */
  relight(alphaOf: (rank: number) => number, now: number, motion: Motion): void {
    const reduced = motion.slow === 0;
    const d = this.data;
    for (let r = 0; r < this.live; r++) {
      const a = alphaOf(r);
      const o = r * STRIDE;
      // Squares already heading to this alpha keep their animation, the pour included.
      if (Math.abs((d[o + 13] ?? 1) - a) < 1e-3) continue;
      const [x, y, w, h, alpha] = this.sample(r, now, motion);
      const [tx, ty, tw, th] = [d[o + 4] ?? 0, d[o + 5] ?? 0, d[o + 6] ?? 0, d[o + 7] ?? 0];
      // Only a square coming fully lit grows; a new dim level (a theme switch) only fades.
      const pop = a > 0.999 && a > alpha && !reduced;
      d.set(pop ? [tx + tw * 0.3, ty + th * 0.3, tw * 0.4, th * 0.4] : [x, y, w, h], o);
      d[o + 8] = now + (pop ? (r / Math.max(1, this.live)) * motion.stagger * 4 : 0);
      d[o + 9] = reduced ? motion.fade : pop ? motion.slow : motion.base;
      d[o + 10] = pop ? SETTLE : IN_OUT;
      d[o + 12] = alpha;
      d[o + 13] = a;
      this.end = Math.max(this.end, (d[o + 8] ?? 0) + (d[o + 9] ?? 0));
    }
  }

  /** Live squares at full alpha once their animations end: the lit ones while some are dimmed. */
  get lit(): number {
    let n = 0;
    for (let r = 0; r < this.live; r++) if ((this.data[r * STRIDE + 13] ?? 1) > 0.999) n++;
    return n;
  }

  /** Ends every animation now: what a hidden tab comes back to. */
  finish(): void {
    const d = this.data;
    for (let o = 0; o < d.length; o += STRIDE) d[o + 9] = 0;
    this.end = 0;
  }

  /** Squares drawn, leaving ones included. */
  get count(): number {
    return this.ids.length;
  }
}
