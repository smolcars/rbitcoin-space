// The goggles: kinds of transaction a reader can keep lit in a block's map, read from each
// transaction's flags (docs/API.md "Transaction flags"), and the pick, remembered for the visit
// (docs/FRONTEND.md "Goggles").
import { createSignal } from "solid-js";
import { WORD } from "./flags";
import { groupDigits } from "./format";

export type Group = "Common" | "Scripts" | "Other" | "Version and RBF" | "Signature hash";
export const GROUPS: readonly Group[] = [
  "Common",
  "Scripts",
  "Other",
  "Version and RBF",
  "Signature hash",
];

export interface Kind {
  /** Stored in the visit's memory. */
  key: string;
  /** On its chip, within its group. */
  label: string;
  /** Alone, as a picked tag: the label, unless it needs its group to make sense. */
  name: string;
  /** Bit N of the flags is the value 2^N. */
  bit: number;
  group: Group;
}

const kind = (key: string, label: string, bit: number, group: Group, name = label): Kind => ({
  key,
  label,
  name,
  bit,
  group,
});

/** Every kind the server sets, the common five first. */
export const KINDS: readonly Kind[] = [
  kind("taproot", "Taproot", 14, "Common"),
  kind("inscription", "Inscription", 26, "Common"),
  kind("op-return", "OP_RETURN", 24, "Common"),
  kind("consolidation", "Consolidation", 33, "Common"),
  kind("paid-by-child", "Paid by a child", 16, "Common"),
  kind("p2wpkh", "P2WPKH", 12, "Scripts"),
  kind("p2wsh", "P2WSH", 13, "Scripts"),
  kind("p2sh", "P2SH", 11, "Scripts"),
  kind("p2pkh", "P2PKH", 10, "Scripts"),
  kind("p2pk", "P2PK", 8, "Scripts"),
  kind("multisig", "Bare multisig", 9, "Scripts"),
  kind("pays-parent", "Pays for a parent", 17, "Other"),
  kind("replacement", "Replacement", 18, "Other"),
  kind("batch", "Batch payment", 34, "Other"),
  kind("fake-key", "Fake public key", 25, "Other"),
  kind("rbf", "Signals RBF", 0, "Version and RBF"),
  kind("no-rbf", "No RBF", 1, "Version and RBF"),
  kind("v1", "Version 1", 2, "Version and RBF"),
  kind("v2", "Version 2", 3, "Version and RBF"),
  kind("v3", "Version 3", 4, "Version and RBF"),
  kind("all", "All", 40, "Signature hash", "SIGHASH_ALL"),
  kind("none", "None", 41, "Signature hash", "SIGHASH_NONE"),
  kind("single", "Single", 42, "Signature hash", "SIGHASH_SINGLE"),
  kind("default", "Default", 43, "Signature hash", "SIGHASH_DEFAULT"),
  kind("acp", "Anyone can pay", 44, "Signature hash", "SIGHASH_ANYONECANPAY"),
];

/** Masks over both words: a set of bits tested in two `&`s. */
interface Mask {
  lo: number;
  hi: number;
}

function maskOf(kinds: readonly Kind[]): Mask {
  let lo = 0;
  let hi = 0;
  for (const k of kinds) {
    if (k.bit < 32) lo = (lo | (1 << k.bit)) >>> 0;
    else hi = (hi | (1 << (k.bit - 32))) >>> 0;
  }
  return { lo, hi };
}

// ---- Picks ----

export type Mode = "any" | "all";

export interface Pick {
  /** In the order picked. */
  kinds: readonly Kind[];
  mode: Mode;
}

export const NO_PICK: Pick = { kinds: [], mode: "any" };

/** Whether flags carry any (or all) of the picked kinds; undefined when nothing is picked. */
export function matcher(pick: Pick): ((flags: number) => boolean) | undefined {
  if (pick.kinds.length === 0) return undefined;
  const m = maskOf(pick.kinds);
  if (pick.mode === "any") {
    return (flags) => {
      const lo = flags % WORD;
      return ((lo & m.lo) | (((flags - lo) / WORD) & m.hi)) !== 0;
    };
  }
  return (flags) => {
    const lo = flags % WORD;
    return (lo & m.lo) >>> 0 === m.lo && (((flags - lo) / WORD) & m.hi) >>> 0 === m.hi;
  };
}

/** For a map: what the pick keeps lit, or undefined (everything lit) when nothing is picked. */
export function litOf(p: Pick): ((tx: Flagged) => boolean) | undefined {
  const test = matcher(p);
  return test && ((tx) => test(tx.flags ?? 0));
}

/** For a map's text alternative: " Highlighted: Taproot or Inscription.", or nothing. */
export const litLabel = (p: Pick): string =>
  p.kinds.length === 0 ? "" : ` Highlighted: ${pickName(p)}.`;

/** What the goggles count: anything with a size and flags (a transaction without flags has none). */
export interface Flagged {
  vsize: number;
  flags?: number;
}

/** A block's make-up by kind, and what a pick lights. Arrays are indexed as {@link KINDS}. */
export interface Census {
  /** Transactions, and their virtual size. */
  count: number;
  size: number;
  /** Per kind: how many carry it, and their virtual size. */
  counts: Int32Array;
  sizes: Float64Array;
  /** What the pick lights; undefined when nothing is picked. */
  lit: { count: number; size: number } | undefined;
  /** In "all" mode, per kind: how many would stay lit with it added to the pick. */
  withPick: Int32Array | undefined;
}

// Each kind's word and mask, so the count is two `&`s per kind.
const TESTS = KINDS.map((k) =>
  k.bit < 32 ? { hi: false, mask: (1 << k.bit) >>> 0 } : { hi: true, mask: 1 << (k.bit - 32) },
);

/**
 * Counts every kind in one pass, and what the pick lights. A full block of 16 000 transactions
 * takes a few milliseconds: run it once per change of the block or the pick, never per frame.
 */
export function census(txs: Iterable<Flagged>, pick: Pick): Census {
  const n = KINDS.length;
  const counts = new Int32Array(n);
  const sizes = new Float64Array(n);
  const test = matcher(pick);
  const withPick = test && pick.mode === "all" ? new Int32Array(n) : undefined;
  let count = 0;
  let size = 0;
  let litCount = 0;
  let litSize = 0;
  for (const tx of txs) {
    count++;
    size += tx.vsize;
    const flags = tx.flags ?? 0;
    const lo = flags % WORD;
    const hi = (flags - lo) / WORD;
    const on = test?.(flags) === true;
    if (on) {
      litCount++;
      litSize += tx.vsize;
    }
    for (let k = 0; k < n; k++) {
      const t = TESTS[k];
      if (!t || ((t.hi ? hi : lo) & t.mask) === 0) continue;
      counts[k] = (counts[k] ?? 0) + 1;
      sizes[k] = (sizes[k] ?? 0) + tx.vsize;
      if (on && withPick) withPick[k] = (withPick[k] ?? 0) + 1;
    }
  }
  return {
    count,
    size,
    counts,
    sizes,
    lit: test ? { count: litCount, size: litSize } : undefined,
    withPick,
  };
}

/** A share as the goggles print it: `0`, `<0.1%`, one decimal under 10%, whole above, `100%`. */
export function formatShare(share: number): string {
  if (!(share > 0)) return "0";
  if (share >= 1) return "100%";
  if (share < 0.0005) return "<0.1%";
  if (share < 0.0995) return `${(share * 100).toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.min(99, Math.round(share * 100))}%`;
}

/** What a pick lights, in one line: "9 of 3 862 · 0.2% of the block". */
export function resultLine(c: Census): string {
  const total = groupDigits(c.count);
  if (!c.lit) return `${total} ${c.count === 1 ? "transaction" : "transactions"}`;
  if (c.lit.count === 0) return `None of ${total}`;
  const share = c.size > 0 ? c.lit.size / c.size : 0;
  return `${groupDigits(c.lit.count)} of ${total} · ${formatShare(share)} of the block`;
}

/** The pick in words: "Taproot or Inscription". */
export const pickName = (p: Pick): string =>
  p.kinds.map((k) => k.name).join(p.mode === "any" ? " or " : " and ");

// ---- Memory ----
// For the visit, in this tab: the same kinds stay lit from block to block and page to page. Not in
// the URL, and a new visit starts plain.

const MEMORY = "goggles";

/** The pick a stored value names; anything unexpected reads as nothing picked. */
export function readPick(stored: string | null): Pick {
  let v: unknown;
  try {
    v = JSON.parse(stored ?? "null");
  } catch {
    return NO_PICK;
  }
  if (typeof v !== "object" || v === null) return NO_PICK;
  const keys: unknown = Reflect.get(v, "kinds");
  const mode: unknown = Reflect.get(v, "mode");
  const kinds = Array.isArray(keys)
    ? keys.flatMap((key) => KINDS.find((k) => k.key === key) ?? [])
    : [];
  return { kinds: [...new Set(kinds)], mode: mode === "all" ? "all" : "any" };
}

function load(): Pick {
  try {
    return readPick(sessionStorage.getItem(MEMORY));
  } catch {
    // No storage (blocked): the pick lasts the page.
    return NO_PICK;
  }
}

const [pick, setPickSignal] = createSignal<Pick>(load());

/** The reader's pick, shared by every map on the page and remembered for the visit. */
export { pick };

export function setPick(next: Pick): void {
  setPickSignal(next);
  try {
    sessionStorage.setItem(
      MEMORY,
      JSON.stringify({ kinds: next.kinds.map((k) => k.key), mode: next.mode }),
    );
  } catch {
    // As above.
  }
}

/** The pick with `k` added, or taken out if it was in. */
export function toggled(p: Pick, k: Kind): Pick {
  return {
    ...p,
    kinds: p.kinds.includes(k) ? p.kinds.filter((x) => x !== k) : [...p.kinds, k],
  };
}
