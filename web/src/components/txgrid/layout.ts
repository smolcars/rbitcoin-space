// Packs a block's transactions into squares on a grid of cells (docs/FRONTEND.md "Transaction
// grid"). Pure and deterministic: the same transactions and frame shape give the same picture.

import { feeBand } from "../../lib/format";

/** One transaction as the grid needs it. */
export interface GridTx {
  /** Stable across changes: the index in the block for a mined block, the txid for a projected one. */
  id: number | string;
  /** Virtual size, vB. */
  vsize: number;
  /** sats; 0 for the coinbase. */
  fee: number;
  /** Total output value, sats, when known (a projected block's records do not carry it). */
  value?: number;
  /**
   * The fee rate to order and color by, sat/vB, when it is not fee over vsize: a projected
   * transaction's effective rate, the rate of the chunk it is mined in.
   */
  rate?: number;
  /** The transaction's flags (docs/API.md "Transaction flags"), bits 0 to 52; none when absent. */
  flags?: number;
  /** The coinbase pays no fee rate: it is drawn first, in a neutral color. */
  coinbase?: boolean;
}

/**
 * Rectangles placed on a `cols` × `rows` grid of cells, in fractions of a cell. Arrays are indexed
 * by rank: 0 is the top left.
 */
export interface Layout {
  cols: number;
  rows: number;
  /** vB per cell: a rectangle of `w × h` cells stands for `w × h × unit` vB. */
  unit: number;
  /** Rows left empty above the rectangles: the block's unused capacity. */
  offset: number;
  /** How wide the rectangles' area is, in cells: all of `cols` but for a nearly empty block. */
  width: number;
  /** Index in the input of the transaction at each rank. */
  order: Int32Array;
  /** Left edge, top edge (`offset` included), width and height of each rectangle, in cells. */
  x: Float64Array;
  y: Float64Array;
  w: Float64Array;
  h: Float64Array;
  /** The first rank of each run, in order, and one past the last rank at the end. */
  strips: Int32Array;
  /** Each run's box: x, y, width, height, and 1 for a column or 0 for a row. */
  boxes: Float64Array;
}

/** About this many cells in a frame: it sets the frame's shape steps, not the drawing's detail. */
export const GRID_CELLS = 160_000;
/**
 * The least area a transaction is drawn with, in cells (about 25 vB at a block's scale), so the
 * smallest can be seen and pointed at; no mainnet transaction is that small.
 */
export const MIN_AREA = 4;
/**
 * The least height, in cells, of the rectangle the transactions make. A nearly empty block is a
 * small rectangle on the floor at the left, as wide as tall up to this, rather than a sliver too
 * thin to see; the caption and the facts give its true fullness.
 */
export const MIN_ROWS = 10;

/** A fee rate in sat/vB, 0 when the size is not positive. */
export const rateOf = (tx: GridTx): number =>
  tx.rate !== undefined && Number.isFinite(tx.rate)
    ? tx.rate
    : tx.vsize > 0
      ? tx.fee / tx.vsize
      : 0;

const compareIds = (a: number | string, b: number | string): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Input indices in drawing order: the coinbase, then by fee band, dearest first; within a band, whose
 * squares share a colour, the largest first, which keeps the treemap's rectangles close to square;
 * then by fee rate, highest first, then by id.
 */
export function rank(txs: readonly GridTx[]): Int32Array {
  const rates = txs.map((tx) => rateOf(tx));
  const bands = rates.map((r) => feeBand(r));
  const order = [...txs.keys()];
  order.sort((i, j) => {
    const a = txs[i];
    const b = txs[j];
    if (!a || !b) return 0;
    const coinbase = a.coinbase === true;
    if (coinbase !== (b.coinbase === true)) return coinbase ? -1 : 1;
    return (
      (bands[j] ?? 0) - (bands[i] ?? 0) ||
      b.vsize - a.vsize ||
      (rates[j] ?? 0) - (rates[i] ?? 0) ||
      compareIds(a.id, b.id)
    );
  });
  return Int32Array.from(order);
}

/**
 * The grid for a frame of this shape (width over height). The shape is rounded to steps of about
 * 4%, so a frame that changes size by a pixel or two keeps its picture and is only rescaled.
 */
export function gridSize(aspect: number): { cols: number; rows: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const q = 2 ** (Math.round(Math.log2(Math.min(64, Math.max(1 / 64, a))) * 16) / 16);
  const cols = Math.max(1, Math.round(Math.sqrt(GRID_CELLS * q)));
  return { cols, rows: Math.max(1, Math.round(GRID_CELLS / cols)) };
}

/**
 * Lays `txs` out in a frame of shape `aspect` (width over height) that holds `capacity` vB, or the
 * transactions' total if that is more, as an ordered squarified treemap: in rank order, each run of
 * rectangles is laid along the shorter side of the space still free, a column down its left edge
 * or a row along its top, and the run grows while that makes its rectangles closer to square. Every
 * rectangle's area is its virtual size (at least {@link MIN_AREA}) and the runs tile the space
 * exactly, so the transactions make one clean rectangle on the floor of the frame, as high as the
 * block is full (at least {@link MIN_ROWS}, narrower then), the dearest at the top left; the empty
 * band above it is the capacity left unused.
 */
export function layout(txs: readonly GridTx[], aspect: number, capacity: number): Layout {
  const n = txs.length;
  const { cols, rows } = gridSize(aspect);
  const order = rank(txs);
  const size = (r: number) => {
    const v = txs[order[r] ?? 0]?.vsize ?? 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  let total = 0;
  for (let r = 0; r < n; r++) total += size(r);
  const unit = Math.max(capacity, total) / (cols * rows) || 1;
  // Areas in cells, each at least MIN_AREA.
  const areas = Float64Array.from({ length: n }, (_, r) => {
    const a = size(r) / unit;
    return a > 0 ? Math.max(MIN_AREA, a) : 0;
  });
  const packed = Math.min(
    cols * rows,
    areas.reduce((sum, a) => sum + a, 0),
  );
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const w = new Float64Array(n);
  const h = new Float64Array(n);
  // As high as the block is full; a nearly empty one keeps at least a small square's height.
  const tall = Math.min(rows, Math.max(packed / cols, Math.min(Math.sqrt(packed), MIN_ROWS)));
  const offset = rows - tall;
  const strips: number[] = [];
  const boxes: number[] = [];
  // The space still free.
  let fx = 0;
  let fy = offset;
  const width = tall > 0 ? packed / tall : 0;
  let fw = width;
  let fh = tall;
  // Areas shrink in proportion when the minimum sizes overrun the frame.
  const fit =
    packed /
      Math.max(
        packed,
        areas.reduce((sum, a) => sum + a, 0),
      ) || 1;
  let start = 0;
  while (start < n) {
    const column = fw >= fh;
    const side = column ? fh : fw;
    // Grow the run while its worst rectangle gets closer to square. A run of area A along a side
    // of length L is A / L thick; its least square rectangle is its largest or its smallest.
    let area = 0;
    let big = 0;
    let small = Number.POSITIVE_INFINITY;
    let worst = Number.POSITIVE_INFINITY;
    let end = start;
    while (end < n) {
      const a = (areas[end] ?? 0) * fit;
      const nextBig = Math.max(big, a);
      const nextSmall = a > 0 ? Math.min(small, a) : small;
      const t = (area + a) / side;
      const ratio =
        t > 0 && nextSmall < Number.POSITIVE_INFINITY
          ? Math.max(nextBig / (t * t), (t * t) / nextSmall)
          : 0;
      if (end > start && area > 0 && ratio > worst) break;
      area += a;
      big = nextBig;
      small = nextSmall;
      worst = ratio;
      end++;
    }
    const thick = side > 0 ? area / side : 0;
    let along = 0;
    for (let r = start; r < end; r++) {
      const length = thick > 0 ? ((areas[r] ?? 0) * fit) / thick : 0;
      x[r] = column ? fx : fx + along;
      y[r] = column ? fy + along : fy;
      w[r] = column ? thick : length;
      h[r] = column ? length : thick;
      along += length;
    }
    strips.push(start);
    boxes.push(fx, fy, column ? thick : fw, column ? fh : thick, column ? 1 : 0);
    if (column) {
      fx += thick;
      fw -= thick;
    } else {
      fy += thick;
      fh -= thick;
    }
    start = end;
  }
  strips.push(n);
  return {
    cols,
    rows,
    unit,
    offset,
    width,
    order,
    x,
    y,
    w,
    h,
    strips: Int32Array.from(strips),
    boxes: Float64Array.from(boxes),
  };
}

/** The rank of the rectangle under a point given in cells, or -1 for none. */
export function hitTest(l: Layout, cx: number, cy: number): number {
  if (!(cx >= 0 && cx < l.width && cy >= l.offset && cy < l.rows)) return -1;
  // The runs tile the area in order, so the first whose box holds the point is the one.
  for (let k = 0; k + 1 < l.strips.length; k++) {
    const o = k * 5;
    const bx = l.boxes[o] ?? 0;
    const by = l.boxes[o + 1] ?? 0;
    if (cx < bx || cy < by || cx >= bx + (l.boxes[o + 2] ?? 0) || cy >= by + (l.boxes[o + 3] ?? 0))
      continue;
    const column = l.boxes[o + 4] === 1;
    const at = column ? l.y : l.x;
    const v = column ? cy : cx;
    let lo = l.strips[k] ?? 0;
    let hi = (l.strips[k + 1] ?? lo) - 1;
    // The last rectangle in the run starting at or before the point.
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((at[mid] ?? 0) <= v) lo = mid;
      else hi = mid - 1;
    }
    const r = lo;
    const inside = cx < (l.x[r] ?? 0) + (l.w[r] ?? 0) && cy < (l.y[r] ?? 0) + (l.h[r] ?? 0);
    return inside ? r : -1;
  }
  return -1;
}
