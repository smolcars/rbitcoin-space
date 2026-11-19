// What the transaction page says about where a transaction is, as a pure model of two sources:
// the `tx:<txid>` topic and the HTTP status route. Neither alone is enough: the topic knows why a
// transaction left but nothing about one confirmed before anyone followed it (`unknown`), and the
// HTTP route knows confirmed or not but never why a transaction vanished. The newest word wins.
import type { TxStatus } from "../../lib/esplora";
import { formatFeeRate, formatSize, groupDigits } from "../../lib/format";
import type { LiveStatus } from "../../lib/live";
import type { Network } from "../../lib/network";
import {
  isTxid,
  linksOf,
  type Position,
  type ReplacementLink,
  type TxMessage,
  type TxState,
} from "../../lib/track-topics";

type Decisive = Exclude<TxState, { state: "unknown" }>;

export interface Model {
  /** The newest HTTP answer about its status: the transaction's own `status`, or a 404. */
  http: { status: TxStatus | "missing"; at: number; req: number } | undefined;
  /** The newest topic state that can decide: sent live, not stale, and not `unknown`. */
  word: { state: Decisive; at: number } | undefined;
  /** The topic's last message, whatever it said. */
  last: TxMessage | undefined;
  /** What the replacements route remembers replaced it, oldest link first. */
  record: { chain: ReplacementLink[]; truncated: boolean } | undefined;
  /** Orders the answers: each one gets the next number. */
  clock: number;
}

export const EMPTY: Model = {
  http: undefined,
  word: undefined,
  last: undefined,
  record: undefined,
  clock: 0,
};

/** A topic message, heard while the socket is `live` (a message cannot arrive otherwise). */
export function heard(m: Model, msg: TxMessage): Model {
  const clock = m.clock + 1;
  const decides = msg.type === "tx" && !msg.stale && msg.state !== "unknown";
  return {
    ...m,
    last: msg,
    word: decides ? { state: msg as Decisive, at: clock } : m.word,
    clock,
  };
}

/**
 * An HTTP answer: the status, or "missing" when the node answered 404. `asked` is the model's
 * clock when the request was sent: the answer is as of then, so a topic message heard while it was
 * in flight is newer and wins. `req` numbers the page's requests in the order they were sent: an
 * answer to an older one than the answer held changes nothing.
 */
export function answered(
  m: Model,
  status: TxStatus | "missing",
  asked = m.clock,
  req = (m.http?.req ?? 0) + 1,
): Model {
  if (m.http && req < m.http.req) return m;
  return { ...m, http: { status, at: asked + 0.5, req } };
}

/** What the replacements route said replaced it. An empty chain changes nothing. */
export function recorded(m: Model, chain: ReplacementLink[], truncated: boolean): Model {
  return chain.length > 0 ? { ...m, record: { chain, truncated } } : m;
}

/** What the page shows. */
export type Shown =
  | { kind: "loading" }
  | {
      kind: "mempool";
      /** Where the projection puts it; only while the topic speaks live. */
      position: Position | null;
      /** When the node accepted it, if the topic said. */
      time: number | undefined;
      /** Its own rate, sat/vB, if the topic said. */
      rate: number | null;
      /** True when this comes from the topic, so the position is current. */
      live: boolean;
    }
  | { kind: "confirmed"; height: number; hash: string; time: number | undefined }
  | { kind: "replaced"; chain: ReplacementLink[]; truncated: boolean }
  /** It left the mempool for a reason the node does not report (docs/MEMPOOL.md). */
  | { kind: "evicted" }
  /** The node no longer has it, and nothing says why. */
  | { kind: "gone" };

/**
 * What the page shows. `speaking` is whether the topic speaks live now (`liveness` is "live"):
 * without it a position is not shown, since nothing keeps it current.
 */
export function shown(m: Model, speaking = true): Shown {
  const { word, http, last } = m;
  // An HTTP "waiting" agrees with the topic's last word that it waits, and knows less.
  const agrees =
    http?.status !== "missing" &&
    http?.status.confirmed === false &&
    last?.type === "tx" &&
    !last.stale &&
    last.state === "mempool";
  if (word && (!http || word.at > http.at || agrees)) {
    const s = fromWord(word.state, http?.status);
    // A position is current only while the topic's last word is that live, unstale position.
    const current = last?.type === "tx" && !last.stale && last.state === "mempool";
    return s.kind === "mempool" && (!speaking || !current)
      ? { ...s, position: null, live: false }
      : s;
  }
  if (!http) return { kind: "loading" };
  if (http.status === "missing") {
    const chain = word?.state.state === "replaced" ? word.state : m.record;
    if (chain) return { kind: "replaced", chain: chain.chain, truncated: chain.truncated };
    return word?.state.state === "evicted" ? { kind: "evicted" } : { kind: "gone" };
  }
  const s = http.status;
  if (s.confirmed && s.block_height !== undefined && s.block_hash !== undefined) {
    return { kind: "confirmed", height: s.block_height, hash: s.block_hash, time: s.block_time };
  }
  // In the node's mempool, but the topic is not speaking for it now: no position to vouch for.
  const t = word?.state.state === "mempool" ? word.state : undefined;
  return { kind: "mempool", position: null, time: t?.time, rate: t?.rate ?? null, live: false };
}

function fromWord(s: Decisive, http: TxStatus | "missing" | undefined): Shown {
  if (s.state === "mempool") {
    return { kind: "mempool", position: s.position, time: s.time, rate: s.rate, live: true };
  }
  if (s.state === "confirmed") {
    // The block's time comes from HTTP, once it has heard of the same block.
    const same = http !== undefined && http !== "missing" && http.block_hash === s.hash;
    return {
      kind: "confirmed",
      height: s.height,
      hash: s.hash,
      time: same ? http.block_time : undefined,
    };
  }
  if (s.state === "replaced") return { kind: "replaced", chain: s.chain, truncated: s.truncated };
  return { kind: "evicted" };
}

/**
 * How live the page is. `live`: the topic speaks for the transaction. Everything else means the
 * page checks over HTTP (`polls`) and says so.
 */
export type Liveness = "live" | "connecting" | "silent" | "stale" | "off" | "refused" | "down";

/** `quiet`: the socket has been live a while and the topic has still said nothing. */
export function liveness(m: Model, socket: LiveStatus, quiet = false): Liveness {
  if (m.last?.type === "off") return "off";
  if (socket === "connecting" && m.last === undefined) return "connecting";
  if (socket !== "live") return "down";
  // The topic says nothing before the server's first complete mempool cycle (docs/WS.md).
  if (m.last === undefined) return quiet ? "silent" : "connecting";
  if (m.last.type === "refused") return "refused";
  return m.last.stale ? "stale" : "live";
}

export const polls = (l: Liveness): boolean => l !== "live" && l !== "connecting";

/** The newest transaction of a replacement chain: the one to follow. */
export const newest = (chain: readonly ReplacementLink[]): string | undefined => chain.at(-1)?.by;

/** Said of a child once the server says it left with a transaction it depended on. */
export const LEFT_WITH_PARENT =
  "Not replaced itself: it left the mempool with a transaction it depended on, which was replaced.";

/**
 * The sentence to announce once when the shown state changes, or undefined. `child`: the page
 * already knows its own link is a child's (docs/MEMPOOL.md, "Versions").
 */
export function announcement(before: Shown, after: Shown, child = false): string | undefined {
  if (before.kind === "loading") return undefined;
  if (after.kind === "mempool") {
    if (before.kind === "confirmed") {
      return `Unconfirmed again: block ${groupDigits(before.height)} left the chain, and the transaction is waiting to be mined again.`;
    }
    if (before.kind !== "mempool") return "Back in the mempool, waiting for a block.";
    const was = before.position?.block === 0;
    const is = after.position?.block === 0;
    // A first placement is not news; moving into the next block from a later one is.
    if (!was && is && before.position) return "Now projected for the next block.";
    if (was && after.position && !is) return "No longer projected for the next block.";
    return undefined;
  }
  if (after.kind === before.kind) {
    if (after.kind === "confirmed" && before.kind === "confirmed" && after.hash !== before.hash) {
      return `Now confirmed in block ${groupDigits(after.height)}, after a reorganisation.`;
    }
    if (
      after.kind === "replaced" &&
      before.kind === "replaced" &&
      newest(after.chain) !== newest(before.chain)
    ) {
      // A child left with a transaction it depended on: the line it is shown in can go on by a
      // new version or by another removal, and can come back shorter or with another end after a
      // reconnection: only that its newest end changed is known. Its length and that end are
      // said, so each change is a new sentence: the same one twice would not be announced again.
      return child
        ? `The line of transactions it left with changed: ${groupDigits(after.chain.length)} ${after.chain.length === 1 ? "link" : "links"} now, the newest ${(newest(after.chain) ?? "").slice(0, 8)}.`
        : "Its replacement was replaced too.";
    }
    return undefined;
  }
  if (after.kind === "confirmed") return `Confirmed in block ${groupDigits(after.height)}.`;
  if (after.kind === "replaced") {
    if (child) return LEFT_WITH_PARENT;
    const rate = after.chain.at(-1)?.byRate;
    return rate === undefined
      ? "Replaced by another transaction spending the same coins."
      : `Replaced by another transaction spending the same coins, at ${formatFeeRate(rate)} sat/vB.`;
  }
  if (after.kind === "evicted") return "Dropped from the mempool without being mined.";
  return after.kind === "gone" ? "No longer in the mempool." : undefined;
}

/** Average block interval in minutes; regtest has none (blocks come when someone mines one). */
const INTERVAL_MIN: Record<Network, number | undefined> = {
  mainnet: 10,
  signet: 10,
  testnet4: 10,
  testnet5: 10,
  regtest: undefined,
};

/** "40 minutes", "2 hours", "1 hour 10 minutes": whole blocks of ten minutes, so coarse already. */
export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 0 ? "" : `${h} hour${h === 1 ? "" : "s"}`;
  const mins = m === 0 ? "" : `${m} minutes`;
  return [hours, mins].filter(Boolean).join(" ");
}

export interface Place {
  /** "In the next block", "In about 3 blocks", "In more than 7 blocks". */
  where: string;
  /** The projected-block page's place in the queue, 1 for the next (`paths.projected`). */
  page: number;
  /** What is ahead of it. */
  ahead: string;
  /** What that means in time, no more exact than the projection allows. */
  when: string;
}

/**
 * The position in words (docs/WS.md "The position"): a statement about the projection now, never a
 * time to the minute. A block is on average ten minutes away whenever one looks, and one in seven
 * takes more than twenty (an exponential wait: e^-2).
 */
export function place(p: Position, network: Network): Place {
  const last = p.blocks > 1 && p.block >= p.blocks - 1;
  const n = p.block + 1;
  const where =
    p.block === 0
      ? "In the next block"
      : last
        ? `In more than ${p.blocks - 1} blocks`
        : `In about ${n} blocks`;
  const txs = `${groupDigits(p.aheadTxs)} transaction${p.aheadTxs === 1 ? "" : "s"}`;
  const ahead =
    p.aheadTxs === 0
      ? "Nothing is ahead of it: no waiting transaction would be mined before it."
      : `${txs} (${formatSize(p.aheadVsize)}) would be mined before it.`;
  const interval = INTERVAL_MIN[network];
  let when: string;
  if (interval === undefined) {
    when = "Regtest has no block schedule: it confirms when someone mines a block.";
  } else if (p.block === 0) {
    when = `If it stays there, it confirms with the next block found: on average ${interval} minutes away whenever you look, though about one in seven takes more than ${2 * interval}.`;
  } else if (last) {
    when = `Not soon: more than ${duration((p.blocks - 1) * interval)} at the usual pace, and only once what pays more ahead of it has been mined.`;
  } else {
    when = `Roughly ${duration(n * interval)} at the usual pace of a block every ${interval} minutes, if nothing that pays more arrives.`;
  }
  return { where, page: last ? p.blocks : n, ahead, when };
}

/** Blocks the summary's strip draws: six, the confirmations most services wait for. */
export const STRIP_BLOCKS = 6;

/**
 * The summary's block strip: projected blocks dashed to the left of the "now" line, mined blocks
 * solid to its right. `here` is the cell that holds the transaction, counted from the left across
 * both sides.
 */
export interface StripPlace {
  projected: number;
  mined: number;
  here: number;
}

/**
 * Where the transaction sits on the strip. Waiting, its projected block among the projection's
 * blocks, the next one beside the line and anything past the last in the last. Mined, it has
 * crossed the line: its block is the farthest right, the blocks found since between it and the
 * line, and the dashed slots left are the confirmations still to come, up to six.
 */
export function stripPlace(
  at: { position: Position } | { confirmations: number | undefined },
): StripPlace {
  if ("position" in at) {
    const projected = Math.max(1, at.position.blocks);
    const block = Math.min(Math.max(0, at.position.block), projected - 1);
    return { projected, mined: 0, here: projected - 1 - block };
  }
  const mined = Math.min(STRIP_BLOCKS, Math.max(1, at.confirmations ?? 1));
  const projected = STRIP_BLOCKS - mined;
  return { projected, mined, here: projected + mined - 1 };
}

/** The projected block in a few words, for the summary: "Next block", "~3 blocks", "7+ blocks". */
export function placeShort(p: Position): string {
  if (p.block === 0) return "Next block";
  if (p.blocks > 1 && p.block >= p.blocks - 1) return `${groupDigits(p.blocks - 1)}+ blocks`;
  return `~${groupDigits(p.block + 1)} blocks`;
}

/** Whether two rates print differently, so an effective rate is worth showing. */
export const ratesDiffer = (a: number, b: number): boolean => formatFeeRate(a) !== formatFeeRate(b);

/** `GET /app/tx/:txid/relatives`, read for what the page shows. Rates in sat/vB. */
export interface Relatives {
  chunk: number;
  chunks: { fee: number; vsize: number; rate: number; txs: string[] }[];
  txs: { txid: string; fee: number | null; vsize: number | null }[];
  parents: string[];
  children: string[];
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const txids = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => isTxid(x)) ? v : undefined;

export function parseRelatives(v: unknown): Relatives | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const parents = txids(r["parents"]);
  const children = txids(r["children"]);
  if (!isCount(r["chunk"]) || !parents || !children) return undefined;
  if (!Array.isArray(r["chunks"]) || !Array.isArray(r["txs"])) return undefined;
  const chunks: Relatives["chunks"] = [];
  for (const c of r["chunks"] as unknown[]) {
    if (typeof c !== "object" || c === null) return undefined;
    const { fee, vsize, rate } = c as Record<string, unknown>;
    const members = txids((c as Record<string, unknown>)["txs"]);
    if (!isCount(fee) || !isCount(vsize) || !isCount(rate) || !members) return undefined;
    chunks.push({ fee, vsize, rate: rate / 1000, txs: members });
  }
  const txs: Relatives["txs"] = [];
  for (const t of r["txs"] as unknown[]) {
    if (typeof t !== "object" || t === null) return undefined;
    const { txid, fee, vsize } = t as Record<string, unknown>;
    if (!isTxid(txid)) return undefined;
    txs.push({ txid, fee: isCount(fee) ? fee : null, vsize: isCount(vsize) ? vsize : null });
  }
  return { chunk: r["chunk"], chunks, txs, parents, children };
}

export interface Member {
  txid: string;
  /** Its own rate, sat/vB, when known. */
  rate: number | undefined;
  relation: "this" | "parent" | "child" | "related";
}

/**
 * Who it is mined with (its chunk, in mining order), and its unconfirmed parents and children
 * that are not in that group: parents must be mined first, children wait for it.
 */
export function group(
  r: Relatives,
  self: string,
): {
  together: Member[];
  rate: number | undefined;
  before: string[];
  after: string[];
} {
  const chunk = r.chunks[r.chunk];
  const own = new Map(r.txs.map((t) => [t.txid, t]));
  const relation = (id: string): Member["relation"] =>
    id === self
      ? "this"
      : r.parents.includes(id)
        ? "parent"
        : r.children.includes(id)
          ? "child"
          : "related";
  const together = (chunk?.txs ?? []).map((txid) => {
    const t = own.get(txid);
    const rate =
      t?.fee !== null && t?.fee !== undefined && t.vsize !== null && t.vsize > 0
        ? t.fee / t.vsize
        : undefined;
    return { txid, rate, relation: relation(txid) };
  });
  const inChunk = new Set(chunk?.txs);
  return {
    together,
    rate: chunk?.rate,
    before: r.parents.filter((p) => !inChunk.has(p)),
    after: r.children.filter((c) => !inChunk.has(c)),
  };
}

/** `GET /app/tx/:txid/replacements`: what replaced it, forward, and what it replaced, backward. */
export interface Replacements {
  replacedBy: ReplacementLink[];
  replaces: ReplacementLink[];
  truncated: boolean;
  /** Its line of versions, oldest first, joined by version links only (docs/MEMPOOL.md). */
  versions: string[];
}

export function parseReplacements(v: unknown): Replacements | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const replacedBy = linksOf(r["replaced_by"]);
  const replaces = linksOf(r["replaces"]);
  const line = r["versions"];
  // At most 33 from the server; a list that is not one of txids is read as none.
  const versions =
    Array.isArray(line) && line.length <= 64 && line.every((x) => isTxid(x)) ? line : [];
  return replacedBy && replaces
    ? { replacedBy, replaces, truncated: r["truncated"] === true, versions }
    : undefined;
}
