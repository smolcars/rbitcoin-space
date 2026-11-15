// Where everything in the exit picture goes: the batch trees grown up from their commitment
// transactions on the Bitcoin line, this VTXO's checkpoints and transfers above them, and the line
// itself as the VTXO's lifetime. Pure: an answer and a width in, positions and paths out.
import { type ChainTx, lifeShare, type Step, type VtxoAnswer } from "./vtxo";

export interface Dot {
  id: string;
  x: number;
  y: number;
  /** `anchor`: a commitment on the line. `mine`: a transaction of this VTXO's exit. */
  kind: "anchor" | "mine" | "other" | "leaf";
  step: Step | undefined;
}

export interface Link {
  d: string;
  mine: boolean;
  /** The broadcast number of the transaction it leads to: lit when an exit plays past it. */
  n: number;
}

export interface Scene {
  width: number;
  height: number;
  compact: boolean;
  lineY: number;
  dots: Dot[];
  links: Link[];
  /** This VTXO's own dot. */
  me: Dot | undefined;
  /** The commitment's place on the line, now, and the expiry. */
  axis: { commitment: number; now: number; end: number };
  /** Checkpoints to name beside their dot, on a wide picture. */
  checkpoints: Dot[];
}

/** Below this width the picture is a phone's: tighter, fewer words. */
export const COMPACT = 560;

interface Drawn {
  commitment: string;
  root: string;
  children: Map<string, string[]>;
  leaves: number;
}

const f1 = (n: number) => Math.round(n * 10) / 10;

/** A link with upright ends: from `a` below to `b` above, bending halfway. */
export function bend(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const my = (a.y + b.y) / 2;
  return `M${f1(a.x)} ${f1(a.y)}C${f1(a.x)} ${f1(my)} ${f1(b.x)} ${f1(my)} ${f1(b.x)} ${f1(b.y)}`;
}

/**
 * The trees to draw: each batch's whole tree when the server gave it, otherwise only the chain's
 * own branch of it (the rest of that batch is a count).
 */
function trees(a: VtxoAnswer): Drawn[] {
  const chainTree = a.chain.filter((t) => t.kind === "tree");
  const commitments =
    a.batches.length > 0
      ? a.batches.map((b) => ({ txid: b.commitment, tree: b.tree }))
      : a.chain.filter((t) => t.kind === "commitment").map((t) => ({ txid: t.txid, tree: null }));
  const out: Drawn[] = [];
  for (const c of commitments) {
    const { root, children } =
      c.tree && c.tree.length > 0
        ? {
            root: c.tree[0]?.txid,
            children: new Map(c.tree.map((n) => [n.txid, n.children])),
          }
        : branchOnly(chainTree, c.txid);
    if (!root) continue;
    out.push({ commitment: c.txid, root, children, leaves: countLeaves(root, children) });
  }
  return out;
}

/** Only the chain's own tree transactions under `commitment`, as a tree. */
function branchOnly(
  chainTree: readonly ChainTx[],
  commitment: string,
): { root: string | undefined; children: Map<string, string[]> } {
  const children = new Map<string, string[]>();
  for (const t of chainTree) {
    if (!children.has(t.txid)) children.set(t.txid, []);
    for (const s of t.spends.filter((x) => x !== commitment)) {
      children.set(s, [...(children.get(s) ?? []), t.txid]);
    }
  }
  return { root: chainTree.find((t) => t.spends.includes(commitment))?.txid, children };
}

/** Puts a tree's leaves evenly across its span and each parent over the middle of its children. */
function placeTree(
  t: Drawn,
  box: { left: number; span: number; rootY: number; rowH: number },
  depth: ReadonlyMap<string, number>,
  pos: Map<string, { x: number; y: number }>,
): void {
  let leafIndex = 0;
  const seen = new Set<string>();
  const place = (id: string): number => {
    seen.add(id);
    const kids = (t.children.get(id) ?? []).filter((k) => !seen.has(k));
    let x: number;
    if (kids.length > 0) {
      x = kids.map((k) => place(k)).reduce((p, q) => p + q, 0) / kids.length;
    } else if (t.leaves === 1) {
      x = box.left + box.span / 2;
    } else {
      x = box.left + ((leafIndex + 0.5) * box.span) / t.leaves;
      leafIndex += 1;
    }
    pos.set(id, { x, y: box.rootY - (depth.get(id) ?? 0) * box.rowH });
    return x;
  };
  place(t.root);
}

function countLeaves(root: string, children: Map<string, string[]>): number {
  let n = 0;
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const kids = children.get(id) ?? [];
    if (kids.length === 0) n++;
    stack.push(...kids);
  }
  return Math.max(1, n);
}

export function layout(a: VtxoAnswer, steps: readonly Step[], width: number, now: number): Scene {
  const compact = width < COMPACT;
  const stepOf = new Map(steps.map((s) => [s.txid, s]));
  const drawn = trees(a);
  const pad = compact ? 14 : 28;
  const top = compact ? 46 : 54;
  const bottom = compact ? 54 : 58;
  const stem = compact ? 30 : 38;

  // Depths from each root, and the levels of what sits above the trees (checkpoints, transfers).
  const depth = new Map<string, number>();
  for (const t of drawn) {
    const queue: [string, number][] = [[t.root, 0]];
    while (queue.length > 0) {
      const [id, d] = queue.shift() ?? ["", 0];
      if (depth.has(id)) continue;
      depth.set(id, d);
      for (const k of t.children.get(id) ?? []) queue.push([k, d + 1]);
    }
  }
  const maxDepth = Math.max(1, ...depth.values());
  const level = new Map<string, number>();
  for (const s of steps) {
    if (s.kind === "commitment" || depth.has(s.txid)) continue;
    const below = s.spends.map((p) => (depth.has(p) ? 0 : (level.get(p) ?? 0)));
    level.set(s.txid, 1 + Math.max(0, ...below));
  }
  const levels = Math.max(0, ...level.values());

  const height = (compact ? 380 : 440) + Math.min(levels, 4) * (compact ? 18 : 22);
  const lineY = height - bottom;
  const rootY = lineY - stem;
  const room = rootY - top;
  const gap = levels > 0 ? Math.min(compact ? 40 : 48, (room * 0.4) / levels) : 0;
  const rowH = Math.min(64, (room - levels * gap) / maxDepth);
  const leafTop = rootY - maxDepth * rowH;

  // Leaves share the width in proportion to each tree's leaves.
  const totalLeaves = drawn.reduce((n, t) => n + t.leaves, 0);
  const treeGap = compact ? 18 : 36;
  const usable = width - 2 * pad - treeGap * Math.max(0, drawn.length - 1);
  const pos = new Map<string, { x: number; y: number }>();
  const dots: Dot[] = [];
  const links: Link[] = [];
  const anchors: number[] = [];
  let left = pad;
  for (const t of drawn) {
    const span = totalLeaves > 0 ? (usable * t.leaves) / totalLeaves : usable;
    placeTree(t, { left, span, rootY, rowH }, depth, pos);
    left += span + treeGap;
    const rootP = pos.get(t.root) ?? { x: width / 2, y: rootY };
    const anchor = { x: rootP.x, y: lineY };
    anchors.push(anchor.x);
    dots.push({
      id: `anchor:${t.commitment}`,
      ...anchor,
      kind: "anchor",
      step: stepOf.get(t.commitment),
    });
    links.push({ d: bend(anchor, rootP), mine: stepOf.has(t.root), n: stepOf.get(t.root)?.n ?? 0 });
    // Children before parents' dots, so a parent's dot is drawn over its links.
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = pos.get(id);
      if (!p) return;
      const kids = t.children.get(id) ?? [];
      for (const k of kids) {
        const q = pos.get(k);
        if (!q) continue;
        links.push({
          d: bend(p, q),
          mine: stepOf.has(id) && stepOf.has(k),
          n: stepOf.get(k)?.n ?? 0,
        });
        walk(k);
      }
      const step = stepOf.get(id);
      dots.push({ id, ...p, kind: step ? "mine" : kids.length > 0 ? "other" : "leaf", step });
    };
    walk(t.root);
  }

  // Checkpoints and transfers, each above what it spends.
  const above = steps.filter((s) => level.has(s.txid));
  for (const s of above) {
    const under = s.spends.map((p) => pos.get(p)).filter((p) => p !== undefined);
    const x = under.length > 0 ? under.reduce((n, p) => n + p.x, 0) / under.length : width / 2;
    const p = { x, y: leafTop - (level.get(s.txid) ?? 1) * gap };
    pos.set(s.txid, p);
    for (const q of under) links.push({ d: bend(q, p), mine: true, n: s.n });
    dots.push({ id: s.txid, ...p, kind: "mine", step: s });
  }
  // Mine last, so the lit path is drawn over the quiet ink.
  links.sort((x, y) => Number(x.mine) - Number(y.mine));
  dots.sort((x, y) => Number(x.kind === "mine") - Number(y.kind === "mine"));

  const end = width - pad;
  const commitment = anchors[0] ?? width / 2;
  return {
    width,
    height,
    compact,
    lineY,
    dots,
    links,
    me: dots.find((d) => d.step?.mine === true),
    axis: { commitment, now: commitment + lifeShare(a, now) * (end - commitment), end },
    checkpoints: dots.filter((d) => d.step?.kind === "checkpoint"),
  };
}
