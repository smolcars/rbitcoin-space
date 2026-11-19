// What the address page found of a lookalike address, and how it hands one row's findings to the
// transaction page in the history entry's state, never in the URL (docs/FRONTEND.md "Lookalike
// addresses"). The rule itself lives with the address page (pages/address/lookalike.ts).
import { recognise } from "./address";
import type { Transaction } from "./esplora";

/** One address in a transaction that looks like another. */
export interface Lookalike {
  /** The address in this transaction. */
  here: string;
  /** The address it looks like: the page's own, or one elsewhere in the loaded history. */
  like: string;
  /** `like` is the page's own address. */
  own: boolean;
  /** How many characters after the type prefix agree, and how many at the end. */
  head: number;
  tail: number;
  /** The type prefix both share (`bc1q`, `1`), shown apart from the agreeing characters. */
  prefix: number;
}

/** A row's findings as the transaction page receives them. */
export interface Handover {
  /** The address whose history the reader came from. */
  from: string;
  /** At most HANDOVER_MAX, those of `from` first. */
  found: Lookalike[];
  /** The row had more than were carried (HANDOVER_MAX). */
  more: boolean;
}

/**
 * Findings carried per row. A poisoning transaction can name hundreds; each carried one is about
 * 200 bytes of state, written on the row's links, so 64 keep a page of 25 rows well under a megabyte.
 */
export const HANDOVER_MAX = 64;
/** The longest address carried: bech32's 90. Silent payment addresses never appear in a transaction. */
const ADDRESS_MAX = 90;
/** More than any history could hold; a count past it is not ours. */
const COUNT_MAX = 1_000_000;

/** The key in the history entry's state; the router adds keys of its own beside it. */
const KEY = "lookalike";

/** The state for a link from a row whose transaction names these lookalikes, as `Link` takes it. */
export function handoverState(from: string, found: readonly Lookalike[]): string {
  const carried = found.slice(0, HANDOVER_MAX).map((l) => ({
    here: l.here,
    like: l.like,
    own: l.own,
    head: l.head,
    tail: l.tail,
    prefix: l.prefix,
  }));
  return JSON.stringify({ [KEY]: { from, found: carried, count: found.length } });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const count = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;

/** An address of a kind the rule compares, or undefined. */
function address(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > ADDRESS_MAX) return undefined;
  const r = recognise(v);
  return r && r.type !== "sp" && r.type !== "p2a" ? v : undefined;
}

/** The type prefix's length: base58's version character, or bech32's hrp, `1` and version. */
function typePrefix(a: string): number {
  const t = recognise(a)?.type;
  return t === "p2pkh" || t === "p2sh" ? 1 : a.lastIndexOf("1") + 2;
}

/** Every address a transaction names, its inputs' previous outputs and its outputs. */
export function addressesOf(tx: Transaction): Set<string> {
  const seen = new Set<string>();
  for (const i of tx.vin ?? []) {
    const a = i.prevout?.scriptpubkey_address;
    if (a) seen.add(a);
  }
  for (const o of tx.vout ?? []) {
    const a = o.scriptpubkey_address;
    if (a) seen.add(a);
  }
  return seen;
}

/** One finding, if it is well formed and says what its two addresses really show. */
function finding(v: unknown, from: string, named: ReadonlySet<string>): Lookalike | undefined {
  if (!isRecord(v)) return undefined;
  const here = address(v["here"]);
  const like = address(v["like"]);
  const own = v["own"];
  const prefix = count(v["prefix"], 6);
  const head = count(v["head"], ADDRESS_MAX);
  const tail = count(v["tail"], ADDRESS_MAX);
  if (here === undefined || like === undefined || typeof own !== "boolean") return undefined;
  if (prefix === undefined || head === undefined || tail === undefined) return undefined;
  // Only an address this transaction names, never the reader's own, and `own` means just that.
  if (!named.has(here) || here === like || here === from || own !== (like === from)) {
    return undefined;
  }
  if (prefix !== typePrefix(here) || prefix !== typePrefix(like)) return undefined;
  // The marks must be true of both addresses: the ends they show agree, and fit inside each.
  const a = here.toLowerCase();
  const b = like.toLowerCase();
  // (Two base58 addresses that differ only in case agree end to end, so the ends may overlap.)
  const fits = Math.min(a.length, b.length);
  if (head < 1 || tail < 1 || prefix + head > fits || tail > fits) return undefined;
  if (a.slice(0, prefix + head) !== b.slice(0, prefix + head)) return undefined;
  if (a.slice(-tail) !== b.slice(-tail)) return undefined;
  return { here, like, own, head, tail, prefix };
}

/**
 * The findings a history entry's state carries for this transaction, or undefined. The state is
 * same-origin but still input: anything malformed, oversized or untrue of this transaction leaves
 * no trace. A finding is kept only if its address is among those this transaction names.
 */
export function readHandover(state: unknown, tx: Transaction): Handover | undefined {
  if (!isRecord(state)) return undefined;
  const h = state[KEY];
  if (!isRecord(h)) return undefined;
  const from = address(h["from"]);
  const list = h["found"];
  const total = count(h["count"], COUNT_MAX);
  if (from === undefined || !Array.isArray(list) || total === undefined) return undefined;
  if (list.length === 0 || list.length > HANDOVER_MAX || total < list.length) return undefined;
  const named = addressesOf(tx);
  const found: Lookalike[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const l = finding(v, from, named);
    if (!l || seen.has(l.here)) continue;
    seen.add(l.here);
    found.push(l);
  }
  if (found.length === 0) return undefined;
  // Those of the reader's address first, as the address page orders them.
  found.sort((x, y) => Number(y.own) - Number(x.own));
  return { from, found, more: total > list.length };
}
