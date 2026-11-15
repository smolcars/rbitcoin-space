// An Arkade VTXO as `/app/ark/arkade/vtxo/:txid/:vout` answers it, read strictly, and what the
// page works out from it: the exit's broadcast order, its kinds, states and badges. Everything in
// the answer came from an Arkade server we do not control: it is checked here and shown as text.

export type Kind = "commitment" | "tree" | "checkpoint" | "ark" | "other";
export type OnChain =
  | { state: "off" }
  | { state: "mempool" }
  | { state: "confirmed"; height: number }
  | null;

export interface ChainTx {
  txid: string;
  kind: Kind;
  expires_at: number;
  spends: string[];
}

export interface TreeNode {
  txid: string;
  children: string[];
}

export interface Batch {
  commitment: string;
  vout: number;
  started_at: number;
  ended_at: number;
  expires_at: number;
  vtxos: number;
  amount: number;
  swept: boolean;
  /** Root first; null when the server's tree was too large to draw whole. */
  tree: TreeNode[] | null;
}

export interface Vtxo {
  txid: string;
  vout: number;
  amount: number;
  script: string;
  created_at: number;
  expires_at: number;
  preconfirmed: boolean;
  swept: boolean;
  unrolled: boolean;
  spent: boolean;
  spent_by: string | null;
  settled_by: string | null;
  ark_txid: string | null;
  commitment_txids: string[];
  depth: number;
}

export interface VtxoAnswer {
  vtxo: Vtxo;
  server: { signer_pubkey: string; exit_delay_secs: number };
  chain: ChainTx[];
  chain_complete: boolean;
  batches: Batch[];
  batches_omitted: number;
  /** Per chain transaction, where our node has it. */
  onchain: OnChain[];
}

/** The server's caps, so a hostile answer cannot make the page draw without bound. */
export const MAX_CHAIN = 128;
export const MAX_TREE_NODES = 512;
const MAX_SPENDS = 64;
const MAX_BATCHES = 2;

const TXID = /^[0-9a-f]{64}$/;
const isTxid = (v: unknown): v is string => typeof v === "string" && TXID.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTime = (v: unknown): v is number => Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const txids = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => isTxid(x));
const optTxid = (v: unknown): v is string | null => v === null || isTxid(v);
const KINDS: ReadonlySet<string> = new Set(["commitment", "tree", "checkpoint", "ark", "other"]);

function isVtxo(v: unknown): v is Vtxo {
  if (!isObject(v)) return false;
  return (
    isTxid(v["txid"]) &&
    isCount(v["vout"]) &&
    v["vout"] <= 0xffff_ffff &&
    isCount(v["amount"]) &&
    typeof v["script"] === "string" &&
    /^(?:[0-9a-f]{2}){0,10000}$/.test(v["script"]) &&
    isTime(v["created_at"]) &&
    isTime(v["expires_at"]) &&
    isBool(v["preconfirmed"]) &&
    isBool(v["swept"]) &&
    isBool(v["unrolled"]) &&
    isBool(v["spent"]) &&
    optTxid(v["spent_by"]) &&
    optTxid(v["settled_by"]) &&
    optTxid(v["ark_txid"]) &&
    txids(v["commitment_txids"], 16) &&
    isCount(v["depth"])
  );
}

function isChainTx(v: unknown): v is ChainTx {
  return (
    isObject(v) &&
    isTxid(v["txid"]) &&
    typeof v["kind"] === "string" &&
    KINDS.has(v["kind"]) &&
    isTime(v["expires_at"]) &&
    txids(v["spends"], MAX_SPENDS)
  );
}

function isNode(v: unknown): v is TreeNode {
  return isObject(v) && isTxid(v["txid"]) && txids(v["children"], 16);
}

function isBatch(v: unknown): v is Batch {
  if (!isObject(v)) return false;
  const tree = v["tree"];
  return (
    isTxid(v["commitment"]) &&
    isCount(v["vout"]) &&
    isTime(v["started_at"]) &&
    isTime(v["ended_at"]) &&
    isTime(v["expires_at"]) &&
    isCount(v["vtxos"]) &&
    isCount(v["amount"]) &&
    isBool(v["swept"]) &&
    (tree === null ||
      (Array.isArray(tree) && tree.length <= MAX_TREE_NODES && tree.every((x) => isNode(x))))
  );
}

function isOnChain(v: unknown): v is OnChain {
  if (v === null) return true;
  if (!isObject(v)) return false;
  if (v["state"] === "off" || v["state"] === "mempool") return true;
  return v["state"] === "confirmed" && isCount(v["height"]);
}

/** The answer, or undefined if anything in it is not what the server sends. */
export function readAnswer(v: unknown): VtxoAnswer | undefined {
  if (!isObject(v)) return undefined;
  const server = v["server"];
  const chain = v["chain"];
  const batches = v["batches"];
  const onchain = v["onchain"];
  const ok =
    isVtxo(v["vtxo"]) &&
    isObject(server) &&
    typeof server["signer_pubkey"] === "string" &&
    /^[0-9a-f]{0,130}$/.test(server["signer_pubkey"]) &&
    isCount(server["exit_delay_secs"]) &&
    Array.isArray(chain) &&
    chain.length <= MAX_CHAIN &&
    chain.every((x) => isChainTx(x)) &&
    isBool(v["chain_complete"]) &&
    Array.isArray(batches) &&
    batches.length <= MAX_BATCHES &&
    batches.every((x) => isBatch(x)) &&
    isCount(v["batches_omitted"]) &&
    Array.isArray(onchain) &&
    onchain.length === chain.length &&
    onchain.every((x) => isOnChain(x));
  return ok ? (v as unknown as VtxoAnswer) : undefined;
}

/** A VTXO's outpoint, as the page's address and the entry box write it: `txid:vout`. */
export interface Outpoint {
  txid: string;
  vout: number;
}

/**
 * Reads `txid:vout` strictly: 64 hex digits (either case, read as lower), a colon and an output
 * index with no sign, padding or space. Anything else is not an outpoint.
 */
export function parseOutpoint(text: string): Outpoint | undefined {
  const m = /^([0-9a-fA-F]{64}):(0|[1-9][0-9]{0,9})$/.exec(text);
  if (!m?.[1] || !m[2]) return undefined;
  const vout = Number(m[2]);
  return vout <= 0xffff_ffff ? { txid: m[1].toLowerCase(), vout } : undefined;
}

/** A step of the exit: one transaction of the chain, with where it is and how it reads. */
export interface Step {
  txid: string;
  kind: Kind;
  /** What the page calls it: Commitment, Branch, Leaf, Checkpoint, Transfer or Other. */
  name: string;
  /** Arkade's own word for it, muted beside the name, when it differs. */
  term: string | undefined;
  /** 1 for the first to broadcast; 0 for a commitment, already on chain. */
  n: number;
  spends: string[];
  onchain: OnChain;
  /** The VTXO itself. */
  mine: boolean;
}

/**
 * The chain in broadcast order: commitments first (they are on chain already), then every other
 * transaction after all it spends, ties kept in the reverse of arkd's order (it lists the VTXO
 * first). A spend outside the chain is left out of the order.
 */
export function exitSteps(a: VtxoAnswer): Step[] {
  const index = new Map(a.chain.map((t, i) => [t.txid, i]));
  const leaves = leafSet(a);
  const done = new Set<string>();
  const order: number[] = [];
  // oxlint-disable-next-line unicorn/no-array-reverse -- reverses a new array; toReversed is newer than the browsers we build for
  const pending = a.chain.map((_, i) => i).reverse();
  // Commitments lead; then repeatedly take, in pending order, whatever has its inputs done.
  for (const i of pending) {
    const t = a.chain[i];
    if (t?.kind === "commitment") {
      order.push(i);
      done.add(t.txid);
    }
  }
  let rest = pending.filter((i) => a.chain[i]?.kind !== "commitment");
  while (rest.length > 0) {
    const ready = rest.filter((i) =>
      (a.chain[i]?.spends ?? []).every((s) => done.has(s) || !index.has(s)),
    );
    // A cycle, which a real chain cannot hold: take the rest as listed rather than loop.
    const take = ready.length > 0 ? ready : rest;
    for (const i of take) {
      const t = a.chain[i];
      if (t) done.add(t.txid);
    }
    order.push(...take);
    rest = rest.filter((i) => !take.includes(i));
  }
  let n = 0;
  return order.flatMap((i) => {
    const t = a.chain[i];
    if (!t) return [];
    const words = naming(t.kind, leaves.has(t.txid));
    return [
      {
        txid: t.txid,
        kind: t.kind,
        name: words[0],
        term: words[1],
        n: t.kind === "commitment" ? 0 : ++n,
        spends: t.spends,
        onchain: a.onchain[i] ?? null,
        mine: t.txid === a.vtxo.txid,
      },
    ];
  });
}

const NAMES: Record<Kind, [string, string | undefined]> = {
  commitment: ["Commitment", undefined],
  tree: ["Branch", "tree"],
  checkpoint: ["Checkpoint", undefined],
  ark: ["Transfer", "ark"],
  other: ["Other", undefined],
};

function naming(kind: Kind, leaf: boolean): [string, string | undefined] {
  return kind === "tree" && leaf ? ["Leaf", "tree"] : NAMES[kind];
}

/** Tree transactions that end a branch: no child in the drawn tree, or none in the chain. */
function leafSet(a: VtxoAnswer): Set<string> {
  const childless = new Set<string>();
  const known = new Set<string>();
  for (const b of a.batches) {
    for (const node of b.tree ?? []) {
      known.add(node.txid);
      if (node.children.length === 0) childless.add(node.txid);
    }
  }
  const spentByTree = new Set(a.chain.filter((t) => t.kind === "tree").flatMap((t) => t.spends));
  const leaves = new Set<string>();
  for (const t of a.chain) {
    if (t.kind !== "tree") continue;
    if (known.has(t.txid) ? childless.has(t.txid) : !spentByTree.has(t.txid)) leaves.add(t.txid);
  }
  return leaves;
}

/** How many of each kind the exit broadcasts: commitments are not counted, being on chain. */
export function exitCounts(steps: readonly Step[]): {
  total: number;
  tree: number;
  checkpoints: number;
  transfers: number;
  other: number;
  confirmed: number;
  mempool: number;
} {
  const exit = steps.filter((s) => s.kind !== "commitment");
  const count = (k: Kind) => exit.filter((s) => s.kind === k).length;
  return {
    total: exit.length,
    tree: count("tree"),
    checkpoints: count("checkpoint"),
    transfers: count("ark"),
    other: count("other"),
    confirmed: exit.filter((s) => s.onchain?.state === "confirmed").length,
    mempool: exit.filter((s) => s.onchain?.state === "mempool").length,
  };
}

/** "10 tree, 2 checkpoints, 1 transfer": the exit's make-up in a line. */
export function describeCounts(c: ReturnType<typeof exitCounts>): string {
  const parts = [
    c.tree > 0 ? `${c.tree} tree` : "",
    c.checkpoints > 0 ? plural(c.checkpoints, "checkpoint") : "",
    c.transfers > 0 ? plural(c.transfers, "transfer") : "",
    c.other > 0 ? `${c.other} other` : "",
  ];
  return parts.filter(Boolean).join(", ");
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Closer to expiry than this, the page warns: a week. */
export const NEAR_SECS = 7 * 24 * 3600;

export interface Badge {
  word: string;
  tone: "neutral" | "caution" | "negative";
  icon: "check" | "cross" | "arrow" | "dashed" | "clock" | "up";
}

/** The badges beside the title, as arkd reports the VTXO and as our node sees its exit. */
export function badges(a: VtxoAnswer, steps: readonly Step[], now: number): Badge[] {
  const v = a.vtxo;
  const out: Badge[] = [];
  if (v.spent) out.push({ word: "Spent", tone: "neutral", icon: "arrow" });
  else if (v.swept) out.push({ word: "Swept", tone: "negative", icon: "cross" });
  else out.push({ word: "Unspent", tone: "neutral", icon: "check" });
  if (exiting(a, steps)) out.push({ word: "Exiting", tone: "caution", icon: "up" });
  const live = !v.spent && !v.swept;
  if (live && v.preconfirmed)
    out.push({ word: "Not settled yet", tone: "caution", icon: "dashed" });
  const left = v.expires_at - now;
  if (live && left > 0 && left < NEAR_SECS) {
    out.push({ word: "Expires soon", tone: "caution", icon: "clock" });
  }
  return out;
}

/** Being taken on chain: arkd says so, or a transaction of its exit is on our chain. */
export function exiting(a: VtxoAnswer, steps: readonly Step[]): boolean {
  return (
    a.vtxo.unrolled ||
    steps.some((s) => s.kind !== "commitment" && s.onchain !== null && s.onchain.state !== "off")
  );
}

/** Time as a rough length: "~2 days", "~7 h", "~40 min". */
export function rough(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "–";
  const days = secs / 86_400;
  if (days >= 1.5) return `~${Math.round(days)} days`;
  if (days >= 0.75) return "~1 day";
  const hours = secs / 3600;
  if (hours >= 1) return `~${Math.round(hours)} h`;
  return `~${Math.max(1, Math.round(secs / 60))} min`;
}

/** Time left as a figure and its unit: [22, "days"], [5, "h"], [12, "min"]. */
export function timeLeft(secs: number): [number, string] {
  const days = Math.floor(secs / 86_400);
  if (days >= 2) return [days, "days"];
  if (days === 1) return [1, "day"];
  const hours = Math.floor(secs / 3600);
  if (hours >= 1) return [hours, "h"];
  return [Math.max(1, Math.floor(secs / 60)), "min"];
}

/**
 * The VTXO's lifetime on the Bitcoin line: from its batch's round (the first batch drawn, else
 * when it was created) to its expiry.
 */
export function lifetime(a: VtxoAnswer): { start: number; end: number } {
  const b = a.batches[0];
  const start = b ? b.ended_at || b.started_at || a.vtxo.created_at : a.vtxo.created_at;
  return { start, end: a.vtxo.expires_at };
}

/** Where `now` falls in the lifetime, 0 to 1. */
export function lifeShare(a: VtxoAnswer, now: number): number {
  const { start, end } = lifetime(a);
  if (!(end > start)) return 1;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}
