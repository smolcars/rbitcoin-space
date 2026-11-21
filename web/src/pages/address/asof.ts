// The address page as of a past block (`?at=<height>`): reading the parameter and what the reader
// types, and checking the block the height resolves to. Pure. docs/FRONTEND.md "An address as of
// a block".
import type { AddressStats, AddressStatsPart } from "../../lib/esplora";
import { readDate, type Moment } from "../../palette/match";
import { parseHeight } from "../block/chain";

/** What `?at=` asks for: nothing (the page is live), a height, or text that is not one. */
export type At =
  | { kind: "now" }
  | { kind: "height"; height: number }
  | { kind: "invalid"; text: string };

/** `?at=` as the router gives it. A height is decimal digits within u32, as the API takes. */
export function readAt(value: string | string[] | undefined): At {
  if (value === undefined) return { kind: "now" };
  const text = Array.isArray(value) ? (value[0] ?? "") : value;
  const height = parseHeight(text);
  return height === null ? { kind: "invalid", text } : { kind: "height", height };
}

const DAY = 86_400;

/** What the reader typed in the block field: a height, a date or moment, or neither. */
export type Typed =
  | { kind: "height"; height: number }
  | { kind: "date"; moment: Moment }
  | { kind: "future"; label: string }
  | { kind: "empty" }
  | { kind: "invalid" };

/**
 * A height in digits (spaces, the site's narrow group spaces, which `\s` matches, and commas
 * allowed between groups), or a date the palette reads.
 */
export function readTyped(input: string, now: number): Typed {
  const q = input.trim();
  if (q === "") return { kind: "empty" };
  const digits = q.replaceAll(/[\s,]/g, "");
  if (/^\d+$/.test(digits)) {
    const height = parseHeight(digits);
    return height === null ? { kind: "invalid" } : { kind: "height", height };
  }
  // Read once with no "now" to know a date of any year; then a day not begun yet (or a moment not
  // reached) has no block, however far ahead, and is said so rather than called no date.
  const any = readDate(q, Number.MAX_SAFE_INTEGER);
  if (any === null) return { kind: "invalid" };
  // The lookup's cutoff is the end of what was typed (its day, or its minute when no seconds were
  // given); "still to come" is decided from its start.
  const seconds = /\d:\d{2}:\d{2}$/.test(any.label);
  const begins = any.timed ? (seconds ? any.at : any.at - 59) : any.at - (DAY - 1);
  if (begins > now) return { kind: "future", label: any.label };
  const moment = readDate(q, now);
  return moment === null ? { kind: "invalid" } : { kind: "date", moment };
}

/** The block a height resolved to: its hash on the best chain and its time. */
export interface Pinned {
  hash: string;
  height: number;
  time: number;
}

/** `/block/:hash` for the hash `/block-height/:height` gave, checked to be that block. Untrusted. */
export function readPinned(hash: unknown, block: unknown, height: number): Pinned | undefined {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
  if (typeof block !== "object" || block === null) return undefined;
  const { id, height: h, timestamp } = block as Record<string, unknown>;
  if (id !== hash || h !== height) return undefined;
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0) return undefined;
  return { hash, height, time: timestamp as number };
}

/** A tip height as `/blocks/tip/height` gives it, or undefined. */
export function readTip(text: unknown): number | undefined {
  return typeof text === "string" ? (parseHeight(text.trim()) ?? undefined) : undefined;
}

/** `path` pinned to `hash` with `?asof=`; `path` carries no query of its own. */
export const pinnedPath = (path: string, hash: string): string => `${path}?asof=${hash}`;

/** The address had no confirmed transaction by the pinned block. */
export const unusedThen = (stats: AddressStats): boolean => stats.chain_stats.tx_count === 0;

/** Rows in a page of `/txs/chain` and of `/txs/summary`: the node's fixed page size. */
export const PAGE_ROWS = 25;

/**
 * Where a step from the page as of a block leads: the block of a change (the address after it),
 * its first use, the block before its first transaction, or nowhere (nothing changed since).
 */
export type Step =
  | { kind: "change"; height: number }
  | { kind: "first"; height: number }
  | { kind: "before-first"; height: number }
  | { kind: "none" };

/**
 * "Previous change": the address as it stood before its latest change by the block. `heights` are
 * the confirmed heights of the newest history page as of the block, newest first; `whole`, the
 * page is its whole history by then (a short page, or as many rows as the pinned totals count).
 * With no earlier change in a whole history, its first transaction is in the page, and the step
 * leads to the block before it; before block 0 there is none. Undefined when the page cannot say.
 */
export function previousChange(heights: readonly number[], whole: boolean): Step | undefined {
  const latest = heights[0];
  if (latest === undefined) return undefined;
  const earlier = heights.filter((h) => h < latest);
  if (earlier.length > 0) return { kind: "change", height: Math.max(...earlier) };
  if (!whole) return undefined;
  return latest === 0 ? { kind: "none" } : { kind: "before-first", height: latest - 1 };
}

/**
 * "Next change": the first block after `at` in which the address changed, from its newest history
 * now (`heights`, the confirmed rows' heights; `whole`, the rows reach its first transaction;
 * `since`, how many transactions came after `at`, when known). Known when the rows reach back to
 * `at`, are the whole history, or hold as many later rows as came since. `used`: the address had
 * confirmed history by `at`, so a change after none is its first use.
 */
export function nextChange(
  heights: readonly number[],
  whole: boolean,
  at: number,
  used: boolean,
  since?: number,
): Step | undefined {
  const later = heights.filter((h) => h > at);
  const all = whole || later.length === since;
  if (later.length === heights.length && !all) return undefined;
  if (later.length === 0) return { kind: "none" };
  return { kind: used ? "change" : "first", height: Math.min(...later) };
}

/** How the address stands now beside the block: later, the same, or not comparable. */
export type Since =
  | { kind: "later"; transactions: number; balance: number }
  | { kind: "same"; balance: number }
  | { kind: "unknown" };

/** A block as a height and the hash at it. */
export interface Stamp {
  height: number;
  hash: string;
}

const TOTALS = [
  "tx_count",
  "funded_txo_count",
  "funded_txo_sum",
  "spent_txo_count",
  "spent_txo_sum",
] as const;

/**
 * The one gate for comparing the present with block `at`: the confirmed totals now (`now`, with
 * `stamp`, the tip the reply says it is as of) beside those at the block (`then`). Compared only
 * when the stamp proves it can be: a tip above the block, where every total has only grown (each
 * total only grows along one chain); or the block itself, by hash, with every total the same.
 * Anything else (no stamp, a tip below the block, another block at its height, or totals no later
 * state of one chain could have) is not comparable, and the page then shows and asks nothing.
 */
export function compareNow(
  then: AddressStatsPart,
  now: AddressStatsPart,
  stamp: Stamp | undefined,
  at: Stamp,
): Since {
  const balance = now.funded_txo_sum - now.spent_txo_sum;
  const same = TOTALS.every((k) => now[k] === then[k]);
  if (stamp === undefined) return { kind: "unknown" };
  if (stamp.height === at.height && stamp.hash === at.hash) {
    return same ? { kind: "same", balance } : { kind: "unknown" };
  }
  if (stamp.height <= at.height || TOTALS.some((k) => now[k] < then[k])) {
    return { kind: "unknown" };
  }
  const transactions = now.tx_count - then.tx_count;
  if (transactions > 0) return { kind: "later", transactions, balance };
  return same ? { kind: "same", balance } : { kind: "unknown" };
}
