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

// The rule's own pieces, shared with the transaction page, which holds a handed-over finding to them.
/** Characters after the type prefix that must agree with the page's own address. */
export const OWN_HEAD = 2;
/** Characters after the type prefix that must agree between two other addresses in the history. */
export const PAIR_HEAD = 3;
/** Last characters that must agree, for either. Every short form on the site keeps the last eight. */
export const TAIL = 4;

/** Keys start with the kind: type, network prefix and, for bech32, length. Only one kind compares. */
export interface Form {
  /** The type prefix's length: base58's version character, bech32's hrp, `1` and version. */
  prefix: number;
  /** Lower case. Bech32 has one case; base58 is compared without it, as a glance reads it. */
  folded: string;
  /**
   * The address itself, as one compares for identity: bech32 in lower case, as its two cases are
   * one address; base58 as written, as two that differ only in case are two addresses.
   */
  id: string;
  /** The ends the page's own address is compared on, and the ends two others are. */
  ownKey: string;
  pairKey: string;
}

export function form(address: string): Form | undefined {
  const r = recognise(address);
  // Pay to anchor is one fixed address; silent payments never appear in a transaction.
  if (!r || r.type === "p2a" || r.type === "sp") return undefined;
  const folded = address.toLowerCase();
  const bech32 = r.type !== "p2pkh" && r.type !== "p2sh";
  const prefix = bech32 ? folded.lastIndexOf("1") + 2 : 1;
  if (folded.length < prefix + PAIR_HEAD + TAIL) return undefined;
  const kind = `${r.type}:${folded.slice(0, prefix)}${bech32 ? `:${folded.length}` : ""}`;
  const tail = folded.slice(-TAIL);
  const head = folded.slice(prefix, prefix + PAIR_HEAD);
  return {
    prefix,
    folded,
    id: bech32 ? folded : address,
    ownKey: `${kind}|${head.slice(0, OWN_HEAD)}|${tail}`,
    pairKey: `${kind}|${head}|${tail}`,
  };
}

/** Characters two folded strings share from `from` forwards, or from the end backwards. */
export function agreeHead(a: string, b: string, from: number): number {
  let n = 0;
  while (from + n < a.length && a[from + n] === b[from + n]) n++;
  return n;
}
export function agreeTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
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

/**
 * The state for a link from a row whose transaction names these lookalikes, as `Link` takes it. It
 * names the transaction and network it was made for, so it says nothing on any other.
 */
export function handoverState(
  from: string,
  found: readonly Lookalike[],
  txid: string,
  network: string,
): string {
  const carried = found.slice(0, HANDOVER_MAX).map((l) => ({
    here: l.here,
    like: l.like,
    own: l.own,
    head: l.head,
    tail: l.tail,
    prefix: l.prefix,
  }));
  return JSON.stringify({ [KEY]: { txid, network, from, found: carried, count: found.length } });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const count = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;

/** An address of a kind the rule compares, with its form, or undefined. */
function addressOf(v: unknown): [string, Form] | undefined {
  if (typeof v !== "string" || v.length > ADDRESS_MAX) return undefined;
  const f = form(v);
  return f && [v, f];
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

/**
 * One finding, if it is well formed and the rule would have made it: the two addresses are of one
 * kind and agree on the ends the rule asks of its sort (the reader's own, or another), and its marks
 * are exactly where they agree.
 */
function finding(v: unknown, from: Form, named: ReadonlySet<string>): Lookalike | undefined {
  if (!isRecord(v)) return undefined;
  const h = addressOf(v["here"]);
  const l = addressOf(v["like"]);
  const own = v["own"];
  if (h === undefined || l === undefined || typeof own !== "boolean") return undefined;
  const [here, fh] = h;
  const [like, fl] = l;
  // Only an address this transaction names, never the reader's own nor itself in another case,
  // and `own` means exactly that it resembles the reader's address.
  if (!named.has(here) || fh.id === fl.id || fh.id === from.id || own !== (fl.id === from.id)) {
    return undefined;
  }
  if (own ? fh.ownKey !== fl.ownKey : fh.pairKey !== fl.pairKey) return undefined;
  // One that resembles the reader's own address is said to: the address page puts that first, and
  // a finding naming another address instead would hide what matters most.
  if (!own && fh.ownKey === from.ownKey) return undefined;
  const found: Lookalike = {
    here,
    like,
    own,
    head: agreeHead(fh.folded, fl.folded, fh.prefix),
    tail: agreeTail(fh.folded, fl.folded),
    prefix: fh.prefix,
  };
  const same = v["head"] === found.head && v["tail"] === found.tail && v["prefix"] === found.prefix;
  return same ? found : undefined;
}

/**
 * The findings a history entry's state carries for this transaction on this network, or undefined.
 * The state is same-origin but still input: anything malformed, oversized, made for another
 * transaction or network, or untrue of this one leaves no trace. A finding is kept only if its
 * address is among those this transaction names and the rule would have made it.
 */
export function readHandover(
  state: unknown,
  tx: Transaction,
  network: string,
): Handover | undefined {
  if (!isRecord(state)) return undefined;
  const h = state[KEY];
  if (!isRecord(h) || h["txid"] !== tx.txid || h["network"] !== network) return undefined;
  const from = addressOf(h["from"]);
  const list = h["found"];
  const total = count(h["count"], COUNT_MAX);
  if (from === undefined || !Array.isArray(list) || total === undefined) return undefined;
  if (list.length === 0 || list.length > HANDOVER_MAX || total < list.length) return undefined;
  // The writer leaves findings out only once the list is full.
  if (total > list.length && list.length < HANDOVER_MAX) return undefined;
  const named = addressesOf(tx);
  const found: Lookalike[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const l = finding(v, from[1], named);
    if (!l) continue;
    // A row names each lookalike address once: the same one twice is no row's writing.
    if (seen.has(l.here)) return undefined;
    seen.add(l.here);
    found.push(l);
  }
  if (found.length === 0) return undefined;
  // Those of the reader's address first, as the address page orders them.
  found.sort((x, y) => Number(y.own) - Number(x.own));
  // More were left out only of a full list, every one of which holds.
  return { from: from[0], found, more: total > list.length && found.length === HANDOVER_MAX };
}
