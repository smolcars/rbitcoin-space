// Address poisoning: someone grinds an address whose ends agree with one the reader uses, then puts
// it into the reader's history with a small payment, hoping it is copied from there later. The rule,
// its thresholds and their arithmetic are in docs/FRONTEND.md ("Lookalike addresses").
import { recognise } from "../../lib/address";
import type { Transaction } from "../../lib/esplora";

/** Characters after the type prefix that must agree with the page's own address. */
export const OWN_HEAD = 2;
/** Characters after the type prefix that must agree between two other addresses in the history. */
export const PAIR_HEAD = 3;
/** Last characters that must agree, for either. Every short form on the site keeps the last eight. */
export const TAIL = 4;

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

/** Keys start with the kind: type, network prefix and, for bech32, length. Only one kind compares. */
interface Form {
  /** The type prefix's length: base58's version character, bech32's hrp, `1` and version. */
  prefix: number;
  /** Lower case. Bech32 has one case; base58 is compared without it, as a glance reads it. */
  folded: string;
  /** The ends the page's own address is compared on, and the ends two others are. */
  ownKey: string;
  pairKey: string;
}

function form(address: string): Form | undefined {
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
    ownKey: `${kind}|${head.slice(0, OWN_HEAD)}|${tail}`,
    pairKey: `${kind}|${head}|${tail}`,
  };
}

/** Characters two folded strings share from `from` forwards, or from the end backwards. */
function agreeHead(a: string, b: string, from: number): number {
  let n = 0;
  while (from + n < a.length && a[from + n] === b[from + n]) n++;
  return n;
}
function agreeTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Every address a transaction names, its inputs' previous outputs and its outputs, once each. */
function addressesOf(tx: Transaction): Set<string> {
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
 * The lookalikes in a loaded history, by txid; a transaction with none is absent. Linear in the
 * addresses the transactions name: each address is read once and bucketed by its agreeing ends.
 *
 * Two addresses other than the page's own count only when they appear in different transactions:
 * the attack imitates an address paid elsewhere. A batch of vanity addresses ground to resemble
 * one another inside one transaction (seen on mainnet) says nothing about the reader's addresses.
 */
export function lookalikes(own: string, txs: readonly Transaction[]): Map<string, Lookalike[]> {
  const ownForm = form(own);
  const ownKey = ownForm?.ownKey;
  const forms = new Map<string, Form | undefined>();
  // The first transaction each address appears in, by position, and whether it appears in more.
  const firstTx = new Map<string, number>();
  const multi = new Set<string>();
  const perTx: [string, Set<string>][] = [];
  // Addresses that agree on the pair rule's ends, in the order they were first met.
  const buckets = new Map<string, string[]>();
  for (const [t, tx] of txs.entries()) {
    const list = addressesOf(tx);
    perTx.push([tx.txid, list]);
    for (const a of list) {
      if (forms.has(a)) {
        multi.add(a);
        continue;
      }
      const f = form(a);
      forms.set(a, f);
      firstTx.set(a, t);
      // The page's own address is compared on its own rule, never paired as another address.
      if (!f || a === own) continue;
      const bucket = buckets.get(f.pairKey);
      if (bucket) bucket.push(a);
      else buckets.set(f.pairKey, [a]);
    }
  }

  // Whether two addresses of one bucket appear in different transactions.
  const apart = (a: string, b: string) =>
    multi.has(a) || multi.has(b) || firstTx.get(a) !== firstTx.get(b);
  // A few addresses of each bucket stand for all of it, so a bucket of thousands (a transaction's
  // dust outputs ground to one pair of ends) costs no more per address than a pair: if any address
  // of the bucket is apart from a given one, one of these is.
  const standIns = (bucket: readonly string[]): string[] => {
    const [first, second] = bucket;
    const firstT = first === undefined ? undefined : firstTx.get(first);
    const other = bucket.find((b) => firstTx.get(b) !== firstT);
    const multis = [];
    for (const b of bucket) {
      if (!multi.has(b)) continue;
      multis.push(b);
      if (multis.length === 2) break;
    }
    return [first, second, other, ...multis].filter((b) => b !== undefined);
  };
  const stood = new Map<string, string[]>();

  // What each lookalike address resembles: the page's own address first, else another address of
  // its bucket from another transaction. Never the page's own address itself: it is in every row.
  const resembles = new Map<string, Lookalike>();
  const describe = (here: string, like: string, f: Form, isOwn: boolean): Lookalike => {
    const g = forms.get(like) ?? form(like);
    const other = g?.folded ?? like.toLowerCase();
    return {
      here,
      like,
      own: isOwn,
      head: agreeHead(f.folded, other, f.prefix),
      tail: agreeTail(f.folded, other),
      prefix: f.prefix,
    };
  };
  for (const [a, f] of forms) {
    if (!f || a === own) continue;
    if (ownKey === f.ownKey) {
      resembles.set(a, describe(a, own, f, true));
      continue;
    }
    const bucket = buckets.get(f.pairKey);
    if (!bucket || bucket.length < 2) continue;
    let ins = stood.get(f.pairKey);
    if (!ins) {
      ins = standIns(bucket);
      stood.set(f.pairKey, ins);
    }
    const like = ins.find((b) => b !== a && apart(a, b));
    if (like !== undefined) resembles.set(a, describe(a, like, f, false));
  }

  const out = new Map<string, Lookalike[]>();
  if (resembles.size === 0) return out;
  for (const [txid, list] of perTx) {
    const found: Lookalike[] = [];
    for (const a of list) {
      const l = resembles.get(a);
      if (l) found.push(l);
    }
    if (found.length > 0) out.set(txid, found);
  }
  return out;
}
