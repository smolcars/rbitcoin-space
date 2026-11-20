// The address page as of a past block (`?at=<height>`): reading the parameter and what the reader
// types, and checking the block the height resolves to. Pure. docs/FRONTEND.md "An address as of
// a block".
import type { AddressStats } from "../../lib/esplora";
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

/** What the reader typed in the block field: a height, a date or moment, or neither. */
export type Typed =
  | { kind: "height"; height: number }
  | { kind: "date"; moment: Moment }
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
