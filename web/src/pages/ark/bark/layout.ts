// Where the exit path's picture puts things (docs/DESIGN.md "Ark"). The anchor sits on the Bitcoin
// line; the tree's transactions rise from it; transfers run sideways in rows, each row above the
// last and turning back at its end, as many to a row as the width holds.

import type { TxKind } from "./vtxo";

export interface Point {
  x: number;
  y: number;
}

export interface Placed extends Point {
  kind: TxKind;
  /** Which way its siblings' stub leaves it: left of a rising node, up from a row. */
  stub: "left" | "up";
  /** Room for the sibling's amount beside its stub. */
  label: boolean;
}

export interface Layout {
  width: number;
  height: number;
  /** The Bitcoin line. */
  baseline: number;
  anchor: Point;
  /** One per exit transaction, in broadcast order; the last holds the VTXO. */
  nodes: Placed[];
  /** One path per step: anchor to the first node, then node to node. */
  edges: string[];
  /** Where the line's lifetime axis runs, left to right. */
  axis: { from: number; to: number };
}

const PAD = 20;
// Room above the top row: siblings' amounts, and the VTXO's words when they go above it.
const TOP = 76;
const ROW_GAP = 76;
const RISE = 64;
const BELOW = 52;
const ARC = 22;
/** Room right of the last node for "This VTXO" and its amount. */
const TAIL = 96;

export const STEP_MIN = 56;
export const STEP_MAX = 96;

export function layout(kinds: readonly TxKind[], width: number): Layout {
  const w = Math.max(280, width);
  const tree = kinds.filter((k) => k !== "transfer").length;
  const transfers = kinds.length - tree;
  // Room left of the tree for its siblings' amounts.
  const anchorX = Math.round(Math.min(180, Math.max(116, w * 0.14)));
  const room = w - anchorX - PAD - TAIL;
  const step = Math.min(STEP_MAX, Math.max(STEP_MIN, room / Math.max(1, transfers)));
  const perRow = Math.max(2, Math.floor(room / step));
  const rows = transfers === 0 ? 0 : Math.ceil(transfers / perRow);
  const rowY = (r: number) => TOP + (rows - 1 - r) * ROW_GAP;
  const top = rows > 0 ? rowY(0) : TOP;
  const baseline = top + Math.max(RISE * 1.5, tree * RISE);
  const anchor = { x: anchorX, y: baseline };

  const nodes: Placed[] = [];
  let t = 0;
  let j = 0;
  for (const kind of kinds) {
    if (kind !== "transfer") {
      t += 1;
      nodes.push({
        kind,
        x: anchorX,
        y: baseline - ((baseline - top) * t) / tree,
        stub: "left",
        label: true,
      });
      continue;
    }
    const r = Math.floor(j / perRow);
    const c = j % perRow;
    const x = r % 2 === 0 ? anchorX + (c + 1) * step : anchorX + (perRow - c) * step;
    nodes.push({ kind, x, y: rowY(r), stub: "up", label: step >= 72 });
    j += 1;
  }

  const edges: string[] = [];
  let prev: Point = anchor;
  for (const n of nodes) {
    const f = (v: number) => Math.round(v * 10) / 10;
    if (n.y === prev.y && n.kind === "transfer") {
      edges.push(
        `M${f(prev.x)} ${f(n.y)}Q${f((prev.x + n.x) / 2)} ${f(n.y - ARC * 2)} ${f(n.x)} ${f(n.y)}`,
      );
    } else if (n.kind === "transfer" && n.x === prev.x) {
      // Up to the next row, bowing out past the end of the row.
      const out = n.x > anchorX + step ? ARC * 1.6 : -ARC * 1.6;
      edges.push(
        `M${f(prev.x)} ${f(prev.y)}C${f(prev.x + out)} ${f(prev.y)} ${f(n.x + out)} ${f(n.y)} ${f(n.x)} ${f(n.y)}`,
      );
    } else {
      edges.push(`M${f(prev.x)} ${f(prev.y)}L${f(n.x)} ${f(n.y)}`);
    }
    prev = n;
  }

  return {
    width: w,
    height: baseline + BELOW,
    baseline,
    anchor,
    nodes,
    edges,
    axis: { from: PAD, to: w - PAD },
  };
}

/** Where a height falls on the axis, the anchor's block at the anchor and expiry at the far end. */
export function axisX(l: Layout, height: number, anchorHeight: number, expiry: number): number {
  const end = l.axis.to - 4;
  if (expiry <= anchorHeight) return end;
  const at = l.anchor.x + ((height - anchorHeight) / (expiry - anchorHeight)) * (end - l.anchor.x);
  return Math.min(end, Math.max(l.anchor.x, at));
}
