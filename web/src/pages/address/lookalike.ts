// Address poisoning: someone grinds an address whose ends agree with one the reader uses, then puts
// it into the reader's history with a small payment, hoping it is copied from there later. The rule,
// its thresholds and their arithmetic are in docs/FRONTEND.md ("Lookalike addresses").
import type { Transaction } from "../../lib/esplora";
import {
  addressesOf,
  agreeHead,
  agreeTail,
  type Form,
  form,
  type Lookalike,
} from "../../lib/lookalike";

export type { Lookalike } from "../../lib/lookalike";
export { OWN_HEAD, PAIR_HEAD, TAIL } from "../../lib/lookalike";

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

  // A few addresses of each bucket stand for all of it, so a bucket of thousands (a transaction's
  // dust outputs ground to one pair of ends) costs no more per address than a pair: two that appear
  // in more than one transaction, and two from each of the first three transactions its addresses
  // were first met in. If any address of the bucket other than a given one appears outside a given
  // transaction, one of these does: one of two that appear in several, the one or other of its own
  // transaction's two, or, past three transactions, one of two others' first.
  const standIns = (bucket: readonly string[]): string[] => {
    const multis: string[] = [];
    const byTx = new Map<number, string[]>();
    for (const b of bucket) {
      if (multi.has(b) && multis.length < 2) multis.push(b);
      const t = firstTx.get(b) ?? -1;
      const met = byTx.get(t);
      if (met) {
        if (met.length < 2) met.push(b);
      } else if (byTx.size < 3) byTx.set(t, [b]);
    }
    return [...multis, ...[...byTx.values()].flat()];
  };
  const stood = new Map<string, string[]>();

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
  // What an address in transaction `t` resembles: the page's own address first, else another
  // address of its bucket that appears in a transaction other than `t`, so "elsewhere" is true of
  // the row it is said under. Never the page's own address itself: it is in every row.
  const resembles = (a: string, t: number): Lookalike | undefined => {
    const f = forms.get(a);
    if (!f || a === own) return undefined;
    if (ownKey === f.ownKey) return describe(a, own, f, true);
    const bucket = buckets.get(f.pairKey);
    if (!bucket || bucket.length < 2) return undefined;
    let ins = stood.get(f.pairKey);
    if (!ins) {
      ins = standIns(bucket);
      stood.set(f.pairKey, ins);
    }
    const like = ins.find((b) => b !== a && (multi.has(b) || firstTx.get(b) !== t));
    return like === undefined ? undefined : describe(a, like, f, false);
  };

  const out = new Map<string, Lookalike[]>();
  for (const [t, [txid, list]] of perTx.entries()) {
    // Those of the page's own address first: the warning's headline is theirs, and it shows few.
    const mine: Lookalike[] = [];
    const others: Lookalike[] = [];
    for (const a of list) {
      const l = resembles(a, t);
      if (l) (l.own ? mine : others).push(l);
    }
    if (mine.length + others.length > 0) out.set(txid, [...mine, ...others]);
  }
  return out;
}

/** What the page's notice says of a loaded history's lookalikes. */
export interface LookalikeSummary {
  /** Transactions that name a lookalike, and those that name one of the page's own address. */
  txs: number;
  ownTxs: number;
  /** The first such transaction in the list (the newest), where the notice takes the reader. */
  first: string;
  /** The first lookalike of the page's own address, and how many different ones there are. */
  own: Lookalike | undefined;
  ownAddresses: number;
}

/** The summary of `lookalikes`' answer, or undefined when it found none. In list order. */
export function summarize(
  found: ReadonlyMap<string, readonly Lookalike[]>,
): LookalikeSummary | undefined {
  let first: string | undefined;
  let ownTxs = 0;
  const own = new Map<string, Lookalike>();
  for (const [txid, list] of found) {
    first ??= txid;
    let mine = false;
    for (const l of list) {
      if (!l.own) continue;
      mine = true;
      if (!own.has(l.here)) own.set(l.here, l);
    }
    if (mine) ownTxs++;
  }
  if (first === undefined) return undefined;
  return {
    txs: found.size,
    ownTxs,
    first,
    own: own.values().next().value,
    ownAddresses: own.size,
  };
}
