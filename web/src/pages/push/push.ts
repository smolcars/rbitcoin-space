// The broadcast page's logic (docs/FRONTEND.md "Broadcast"): what a pasted string is, the server's
// check of it read strictly, the warnings that ask for a second thought, and the broadcast itself.
import { ApiError, errorMessage } from "../../lib/api";
import type { Transaction, TxStatus, Vin, Vout } from "../../lib/esplora";
import { onNetwork, type Network } from "../../lib/network";
import { vsize } from "../tx/tx";

/** The largest transaction broadcast takes, in hex characters (docs/API.md "Broadcast"). */
export const MAX_HEX = 800_000;

/** What `POST /app/tx/check` answers (docs/API.md "Checking a transaction"). */
export interface Checked {
  tx: Transaction;
  /** The node's status when it already has the transaction. */
  known: TxStatus | null;
}

export type Pasted =
  | { kind: "empty" }
  | { kind: "bad"; why: string }
  | { kind: "hex"; hex: string };

/** The box's text as a raw transaction: whitespace anywhere is dropped, as when hex wraps. */
export function readPasted(text: string): Pasted {
  const hex = text.replaceAll(/\s+/g, "");
  if (hex === "") return { kind: "empty" };
  if (!/^[0-9a-fA-F]+$/.test(hex)) return { kind: "bad", why: "Not hex" };
  if (hex.length % 2 === 1) return { kind: "bad", why: "Odd number of hex digits" };
  if (hex.length > MAX_HEX) return { kind: "bad", why: "Larger than any standard transaction" };
  return { kind: "hex", hex: hex.toLowerCase() };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isText = (v: unknown): v is string => typeof v === "string";
const isHash = (v: unknown): v is string => isText(v) && /^[0-9a-f]{64}$/.test(v);

function readOutput(v: unknown): Vout | null {
  if (!isObject(v)) return null;
  const { scriptpubkey, scriptpubkey_asm, scriptpubkey_type, scriptpubkey_address, value } = v;
  if (!isText(scriptpubkey) || !isText(scriptpubkey_asm) || !isText(scriptpubkey_type)) return null;
  if (!isCount(value)) return null;
  if (scriptpubkey_address !== undefined && !isText(scriptpubkey_address)) return null;
  return v as unknown as Vout;
}

function readInput(v: unknown): Vin | null {
  if (!isObject(v)) return null;
  const { txid, vout, is_coinbase, sequence, scriptsig, witness, prevout } = v;
  if (!isHash(txid) || !isCount(vout) || typeof is_coinbase !== "boolean") return null;
  if (!isCount(sequence) || !isText(scriptsig)) return null;
  if (witness !== undefined && !(Array.isArray(witness) && witness.every((w) => isText(w))))
    return null;
  if (prevout !== undefined && prevout !== null && readOutput(prevout) === null) return null;
  return v as unknown as Vin;
}

function readStatus(v: unknown): TxStatus | null {
  if (!isObject(v) || typeof v["confirmed"] !== "boolean") return null;
  const { block_height, block_hash } = v;
  if (block_height !== undefined && !isCount(block_height)) return null;
  if (block_hash !== undefined && !isHash(block_hash)) return null;
  return v as unknown as TxStatus;
}

/** The check's answer, or null when it is not the shape the page draws. */
export function readChecked(body: unknown): Checked | null {
  if (!isObject(body) || !isObject(body["tx"])) return null;
  const t = body["tx"];
  const { txid, version, locktime, size, weight, fee, vin, vout } = t;
  if (!isHash(txid) || typeof version !== "number" || !isCount(locktime)) return null;
  if (!isCount(size) || !isCount(weight)) return null;
  if (fee !== undefined && !isCount(fee)) return null;
  if (!Array.isArray(vin) || !Array.isArray(vout)) return null;
  if (!vin.every((i) => readInput(i) !== null)) return null;
  if (!vout.every((o) => readOutput(o) !== null)) return null;
  const said = body["known"];
  const known = said === null ? null : readStatus(said);
  if (said !== null && known === null) return null;
  return { tx: t as unknown as Transaction, known };
}

/** A fee rate above this many times the next block's needs a second thought. */
export const RATE_TIMES = 10;
/** Never warn below this rate, however quiet the mempool. */
export const RATE_FLOOR = 100;

export interface Warnings {
  /** The fee rate, when it is above the line. */
  rate: number | null;
  /** Sats sent to outputs nobody can spend (`OP_RETURN`). */
  burn: number;
  /** Inputs whose output the node does not have. */
  missing: number;
  /** Inputs the server did not look up (past its cap), so the fee is not known. */
  unchecked: number;
}

/** The fee rate in sat/vB, when the fee is known. */
export function rateOf(tx: Transaction): number | undefined {
  const v = vsize(tx);
  return tx.fee === undefined || v === undefined || v === 0 ? undefined : tx.fee / v;
}

/**
 * What to say before broadcasting. `next` is the next block's fee rate when the mempool engine
 * gives one; without it, only the floor times ten counts as too high.
 */
export function warnings(tx: Transaction, next: number | undefined): Warnings {
  const rate = rateOf(tx);
  const line = Math.max(RATE_TIMES * (next ?? RATE_FLOOR), RATE_FLOOR);
  const vin = tx.vin ?? [];
  return {
    rate: rate !== undefined && rate > line ? rate : null,
    burn: tx.vout
      .filter((o) => o.scriptpubkey_type === "op_return")
      .reduce((a, o) => a + o.value, 0),
    missing: vin.filter((i) => i.prevout === null).length,
    unchecked: vin.filter((i) => !i.is_coinbase && i.prevout === undefined).length,
  };
}

/** Whether broadcasting should take a second, deliberate press. */
export const needsSecondThought = (w: Warnings): boolean => w.rate !== null || w.burn > 0;

/**
 * Sends the transaction (`POST /api/tx`) and gives its txid. Never retried by itself: a refusal is
 * shown, and the reader decides whether to press again.
 */
/** A reply to a broadcast that is not this transaction's txid. */
export const UNREADABLE = "The server sent a reply that could not be read.";

export async function broadcast(
  network: Network,
  hex: string,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${onNetwork(network, "")}/api/tx`, {
      method: "POST",
      headers: { accept: "text/plain" },
      body: hex,
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (signal?.aborted === true) throw e;
    throw new ApiError(0, "The server cannot be reached. Check your connection.");
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const after = Number(res.headers.get("retry-after") ?? Number.NaN);
    throw new ApiError(
      res.status,
      errorMessage(res.status, body),
      Number.isFinite(after) ? after : undefined,
    );
  }
  const txid = (await res.text()).trim();
  if (!isHash(txid)) throw new ApiError(res.status, UNREADABLE);
  return txid;
}

/** The line shown when a broadcast is refused. The node's reason is one of a fixed list. */
export function refusal(e: unknown): string {
  if (!(e instanceof ApiError)) return "It could not be sent.";
  if (e.status === 429) {
    const s = e.retryAfter ?? 10;
    return `Too many broadcasts from here. Wait ${s} seconds and try again.`;
  }
  if (e.status === 403) return "This server does not broadcast.";
  if (e.status === 400)
    return `The node refused it: ${e.message.replace(/\.$/, "").toLowerCase()}.`;
  return e.message;
}
