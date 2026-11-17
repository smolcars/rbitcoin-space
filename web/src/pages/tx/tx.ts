// What a transaction's fields mean, as plain sentences and numbers. Pure; the page renders the results.
import type { Transaction, Vin, Vout } from "../../lib/esplora";
import { formatUtc, groupDigits, vsizeFromWeight } from "../../lib/format";

/** Inputs and outputs shown at first, and how many more each press of "Show more" adds. */
export const FIRST_SHOWN = 10;
export const MORE_STEP = 100;
/** Hex, assembly and text show this many characters before "Show all". */
export const PREVIEW_CHARS = 512;
/** Past this many characters a value is offered as a copy only, never laid out on the page. */
export const SHOW_ALL_MAX = 128 * 1024;

/** How many of `total` items to show after `presses` presses of "Show more". */
export function shownCount(total: number, presses: number): number {
  return Math.min(total, FIRST_SHOWN + presses * MORE_STEP);
}

export const isTxid = (s: string): boolean => /^[0-9a-fA-F]{64}$/.test(s);

const FINAL = 0xffffffff;
const LOCKTIME_THRESHOLD = 500_000_000;

export interface Meaning {
  value: string;
  detail: string;
}

/** What a transaction's lock time means, given its inputs' sequences. */
export function lockTimeMeaning(locktime: number, vin: Vin[] | undefined): Meaning {
  const enforced = (vin ?? []).some((i) => i.sequence !== undefined && i.sequence !== FINAL);
  if (locktime === 0) return { value: "None", detail: "Could be mined in any block." };
  const value =
    locktime < LOCKTIME_THRESHOLD ? `Block ${groupDigits(locktime)}` : formatUtc(locktime);
  if (vin && vin.length > 0 && !enforced)
    return { value, detail: "Not enforced: every input's sequence is final." };
  const detail =
    locktime < LOCKTIME_THRESHOLD
      ? `Could not be mined before block ${groupDigits(locktime + 1)}.`
      : "Could not be mined before this time, by the chain's median time.";
  return { value, detail };
}

/** A relative lock of `units` 512-second units, in days, hours and minutes. */
function duration(units: number): string {
  const total = Math.round((units * 512) / 60);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return [d && `${d} d`, h && `${h} h`, (m || (!d && !h)) && `${m} min`].filter(Boolean).join(" ");
}

/** What an input's sequence number means (BIP68 relative locks from version 2). */
export function sequenceMeaning(sequence: number, version: number): string {
  if (sequence === FINAL) return "Final: this input does not enable the lock time.";
  if (version >= 2 && (sequence & 0x80000000) === 0) {
    const value = sequence & 0xffff;
    const lock =
      sequence & 0x400000
        ? `${duration(value)} after the spent output confirmed`
        : `${groupDigits(value)} block${value === 1 ? "" : "s"} after the spent output confirmed`;
    return value === 0 ? "No relative lock; enables the lock time." : `Relative lock: ${lock}.`;
  }
  return "Enables the lock time; no relative lock.";
}

export const formatSequence = (sequence: number): string =>
  `0x${(sequence >>> 0).toString(16).padStart(8, "0")}`;

/** Witness kinds the transaction uses. */
export function features(tx: Transaction): string {
  const vin = tx.vin ?? [];
  const segwit = vin.some((i) => (i.witness?.length ?? 0) > 0);
  const taproot = vin.some((i) => i.prevout?.scriptpubkey_type === "v1_p2tr");
  if (taproot) return "SegWit, Taproot";
  return segwit ? "SegWit" : "Legacy, no witness";
}

export const isCoinbase = (tx: Transaction): boolean => tx.vin?.[0]?.is_coinbase === true;

/** Consensus limit on a script's size; a longer locking script can never be satisfied. */
const MAX_SCRIPT_BYTES = 10_000;

/**
 * Why an output can never be spent, or null when it can. The node calls these "unspent", but none
 * is in the set of coins that can be spent: an OP_RETURN or oversized script (as Bitcoin Core's
 * `IsUnspendable`), and the genesis block's coinbase, which was never added to that set.
 */
export function whyUnspendable(tx: Transaction, out: Vout): string | null {
  if (out.scriptpubkey.startsWith("6a")) return "an OP_RETURN output can never be spent";
  if (out.scriptpubkey.length > MAX_SCRIPT_BYTES * 2) {
    return "its script is longer than any script that can be run";
  }
  if (isCoinbase(tx) && tx.status.block_height === 0) {
    return "the genesis block's reward was never added to the coins that can be spent";
  }
  return null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Value entering the transaction. A coinbase creates what it pays out. */
export function totalIn(tx: Transaction): number {
  if (isCoinbase(tx)) return totalOut(tx);
  return sum((tx.vin ?? []).map((i) => i.prevout?.value ?? 0));
}

export const totalOut = (tx: Transaction): number => sum(tx.vout.map((o) => o.value));

export function vsize(tx: Transaction): number | undefined {
  return tx.weight === undefined ? undefined : vsizeFromWeight(tx.weight);
}

/** Confirmations at a tip height; at least one once confirmed. */
export function confirmations(
  blockHeight: number | undefined,
  tip: number | undefined,
): number | undefined {
  if (blockHeight === undefined || tip === undefined) return undefined;
  return Math.max(1, tip - blockHeight + 1);
}

/**
 * The BIP34 height pushed at the start of a coinbase scriptSig, when it is the block's own height.
 * Before BIP34 the first push is anything (the genesis block's is its difficulty bits).
 */
export function coinbaseHeight(
  scriptsig: string | undefined,
  height: number | undefined,
): number | undefined {
  if (!scriptsig || height === undefined) return undefined;
  const len = Number.parseInt(scriptsig.slice(0, 2), 16);
  if (!(len >= 1 && len <= 8) || scriptsig.length < 2 + len * 2) return undefined;
  let n = 0;
  for (let k = len - 1; k >= 0; k--)
    n = n * 256 + Number.parseInt(scriptsig.slice(2 + k * 2, 4 + k * 2), 16);
  return n === height ? n : undefined;
}

/** A duration token in milliseconds, whether the token is written in `s` or `ms`. */
export function cssMs(value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return /\ds\s*$/.test(value.trim()) ? n * 1000 : n;
}
