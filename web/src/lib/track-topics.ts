// The `tx:<txid>` and `address:<address>` topics (docs/WS.md "Following a transaction or an
// address"). Each message is the topic's whole state, so a page keeps the last one. Rates arrive
// in sat per 1,000 vB and are turned into sat/vB here.
import type { Topic } from "./live";

/** Where the projected blocks put an unconfirmed transaction. */
export interface Position {
  /** The projected block, 0 for the next; `blocks - 1` holds everything beyond the others. */
  block: number;
  blocks: number;
  /** The rate of the chunk it will be mined in, sat/vB. */
  effectiveRate: number;
  aheadVsize: number;
  aheadTxs: number;
}

/** One replacement: `txid` was replaced by `by`. Figures are missing when the server lacks them. */
export interface ReplacementLink {
  txid: string;
  by: string;
  seen?: number;
  fee?: number;
  vsize?: number;
  /** sat/vB */
  rate?: number;
  byFee?: number;
  byVsize?: number;
  byRate?: number;
  /** Inputs both spend (the replacements route only); 0: a child that left with its parent. */
  shared?: number;
}

export type TxState =
  | {
      state: "mempool";
      time: number;
      fee: number;
      vsize: number;
      rate: number | null;
      position: Position | null;
    }
  | { state: "replaced"; chain: ReplacementLink[]; truncated: boolean }
  | { state: "confirmed"; height: number; hash: string }
  | { state: "evicted" }
  | { state: "unknown" };

/** A `tx:` message: a state with whether the server has lost its node, or a refusal. */
export type TxMessage =
  | ({ type: "tx"; stale: boolean } & TxState)
  | { type: "off" }
  | { type: "refused" };

export type AddressMessage =
  | { type: "watching"; status: string | null }
  | { type: "unavailable" }
  | { type: "refused"; reason: string }
  /** The server's own ledger keeps it, exact at `height`; a new height means a block changed it. */
  | { type: "ledger"; height: number };

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const isTxid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const opt = (v: unknown): number | undefined => (isCount(v) ? v : undefined);
const rate = (v: unknown): number | undefined => (isCount(v) ? v / 1000 : undefined);

function positionOf(v: unknown): Position | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  const { block, blocks, effective_rate: eff, ahead_vsize: vsize, ahead_txs: txs } = p;
  if (!isCount(block) || !isCount(blocks) || !isCount(eff) || !isCount(vsize) || !isCount(txs)) {
    return undefined;
  }
  return { block, blocks, effectiveRate: eff / 1000, aheadVsize: vsize, aheadTxs: txs };
}

/** A replacement link as the topic and the replacements route both send it. */
export function linkOf(v: unknown): ReplacementLink | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const l = v as Record<string, unknown>;
  if (!isTxid(l["txid"]) || !isTxid(l["by"])) return undefined;
  const link: ReplacementLink = { txid: l["txid"], by: l["by"] };
  const fields = {
    seen: opt(l["seen"]),
    fee: opt(l["fee"]),
    vsize: opt(l["vsize"]),
    rate: rate(l["rate"]),
    byFee: opt(l["by_fee"]),
    byVsize: opt(l["by_vsize"]),
    byRate: rate(l["by_rate"]),
    shared: opt(l["shared_inputs"]),
  };
  for (const [k, value] of Object.entries(fields)) {
    if (value !== undefined) (link as unknown as Record<string, number>)[k] = value;
  }
  return link;
}

/** A list of links, or undefined if any is malformed. */
export function linksOf(v: unknown): ReplacementLink[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ReplacementLink[] = [];
  for (const x of v) {
    const l = linkOf(x);
    if (!l) return undefined;
    out.push(l);
  }
  return out;
}

function stateOf(m: Record<string, unknown>): TxState | undefined {
  switch (m["state"]) {
    case "mempool": {
      const { time, fee, vsize } = m;
      const position = positionOf(m["position"]);
      if (!isCount(time) || !isCount(fee) || !isCount(vsize) || position === undefined) {
        return undefined;
      }
      return { state: "mempool", time, fee, vsize, rate: rate(m["rate"]) ?? null, position };
    }
    case "replaced": {
      const chain = linksOf(m["chain"]);
      return chain && chain.length > 0
        ? { state: "replaced", chain, truncated: m["truncated"] === true }
        : undefined;
    }
    case "confirmed": {
      return isCount(m["height"]) && isTxid(m["hash"])
        ? { state: "confirmed", height: m["height"], hash: m["hash"] }
        : undefined;
    }
    case "evicted":
    case "unknown": {
      return { state: m["state"] };
    }
    default: {
      return undefined;
    }
  }
}

/** The topic for one transaction. `txid` must already be lower-case hex. */
export function txTopic(txid: string): Topic<TxMessage> {
  return {
    name: `tx:${txid}`,
    parse(m) {
      if (m["type"] === "off") return { type: "off" };
      if (m["type"] === "refused") return { type: "refused" };
      if (m["type"] !== "tx" || typeof m["stale"] !== "boolean") return undefined;
      const s = stateOf(m);
      return s ? { type: "tx", stale: m["stale"], ...s } : undefined;
    },
  };
}

/** The topic name for an address: bech32 in lower case, as the server echoes it (docs/WS.md). */
export function addressTopicName(address: string): string {
  return `address:${/^(bc|tb|bcrt)1/i.test(address) ? address.toLowerCase() : address}`;
}

const reasonOf = (v: unknown): string => (typeof v === "string" ? v : "refused");

export function addressTopic(address: string): Topic<AddressMessage> {
  return {
    name: addressTopicName(address),
    parse(m) {
      if (m["type"] === "refused") return { type: "refused", reason: reasonOf(m["reason"]) };
      if (m["type"] !== "address") return undefined;
      if (m["state"] === "watching" && (m["status"] === null || typeof m["status"] === "string")) {
        return { type: "watching", status: m["status"] };
      }
      if (m["state"] === "unavailable") return { type: "unavailable" };
      if (m["state"] === "refused") return { type: "refused", reason: reasonOf(m["reason"]) };
      if (m["state"] === "ledger" && isCount(m["height"])) {
        return { type: "ledger", height: m["height"] };
      }
      return undefined;
    },
  };
}
