// What a transaction shows anyone who looks at it: the readings an observer makes from its shape,
// as data (docs/FRONTEND.md "Privacy check"). Pure, for the transaction, broadcast and decoder
// pages alike. No wording lives here: each finding carries the indexes and values a sentence needs.
// Addresses and scripts are attacker-controlled; they are only compared, as keys of a `Map`.
import type { ScriptType, Transaction, Vout } from "./esplora";

/** A round amount is a multiple of this many sats (0.0001 BTC)… */
export const ROUND_UNIT = 10_000;
/** …with at most this many significant digits. */
export const ROUND_DIGITS = 2;
/** The output beside a round one reads as not round when it is not a multiple of this. */
export const RAGGED_UNIT = 1_000;
/** A CoinJoin has at least this many outputs of one value… */
export const JOIN_COUNT = 3;
/** …each of at least this many sats. */
export const JOIN_MIN_VALUE = 5_000;

/** Pay to anchor: one fixed script anyone can spend, nobody's address. */
const ANCHOR = "51024e73";

/** Each check the module runs, for saying which did not run. */
export type PrivacyCheck =
  | "reuse"
  | "payback"
  | "round"
  | "script"
  | "unneeded"
  | "coinjoin"
  | "spent-together";

/** One address (one script) that appears more than once among the inputs and outputs. */
export interface ReusedAddress {
  /** Its address, or its script in hex when it has none. Attacker-controlled text. */
  address: string;
  /** `address` is an address; false when it is the script's hex (bare multisig, P2PK, others). */
  isAddress: boolean;
  /** Inputs that spend from it and outputs that pay it, by index in `vin` and `vout`. */
  inputs: number[];
  outputs: number[];
}

/** Why one output reads as change. */
export type ChangeReason =
  /**
   * It pays an address that these inputs spend from; no other output does. It outranks the other
   * readings: when it applies, the finding is change at its output, whatever they say.
   */
  | {
      kind: "payback";
      inputs: number[];
      /** The script paid back has an address; false for one without (bare multisig, P2PK). */
      isAddress: boolean;
    }
  /** The other output is round (`value`); this one is not. */
  | { kind: "round"; roundOutput: number; value: number }
  /** Every input and this output, and no other, are of `scriptType`. */
  | { kind: "script"; scriptType: ScriptType }
  /**
   * This output is less than `value`, the sum of `inputs` (the coins of the address whose inputs
   * add up to the least; one input when every input has its own address), and the other output is
   * not. That suggests which is the payment only if the wallet would not have added a coin it did
   * not need; it does not prove the other output needed every coin.
   */
  | {
      kind: "unneeded";
      inputs: number[];
      value: number;
      /** Every script the funding inputs spend from has an address, so "address" is the word. */
      allAddresses: boolean;
    };

/** One reading: which output it points at as change, and why. */
export interface ChangeReading {
  change: number;
  reason: ChangeReason;
}

export interface EqualOutputs {
  /** In sats. */
  value: number;
  /** Outputs paying exactly `value`, each to a different address none of the inputs spends from. */
  outputs: number[];
  /** Every one of those outputs pays a script with an address. */
  toAddresses: boolean;
}

export type PrivacyFinding =
  | {
      kind: "reuse";
      /** Every address that appears more than once in this transaction. */
      addresses: ReusedAddress[];
    }
  | {
      kind: "change";
      /** The output every reading points at. */
      change: number;
      /** The other output when there are exactly two, which then reads as the payment. */
      payment: number | undefined;
      readings: ChangeReading[];
    }
  | {
      /** The readings point at different outputs, so none is strong. */
      kind: "change-disputed";
      readings: ChangeReading[];
    }
  | {
      kind: "coinjoin";
      /** Groups of equal outputs, the largest first; the first decided the finding. */
      groups: EqualOutputs[];
      /** Distinct addresses (scripts) the funding inputs spend from. */
      senders: number;
      /** Every one of those scripts has an address. */
      sendersAreAddresses: boolean;
    }
  | {
      /** Several inputs spent in one transaction suggest one owner. Said only before it is sent. */
      kind: "spent-together";
      inputs: number[];
      /** Distinct addresses (scripts) among the funding inputs. */
      addresses: number;
      /** Every one of those scripts has an address. */
      allAddresses: boolean;
      /** One output and no change: all of the inputs went to one place. */
      noChange: boolean;
    };

export type FindingKind = PrivacyFinding["kind"];

/** Findings that mean something only while the sender can still change the transaction. */
export const UNSENT_ONLY: ReadonlySet<FindingKind> = new Set(["spent-together"]);

export interface PrivacyReport {
  /** A coinbase has no sender to give away: nothing is checked. */
  coinbase: boolean;
  findings: PrivacyFinding[];
  /** Inputs whose previous output is not known: the node lacks it, or it was not looked up. */
  unknownInputs: number[];
  /** The transaction lists only some of its inputs, or none (below the node's prune point). */
  inputsMissing: boolean;
  /** Checks that did not run, because they need data this transaction lacks. */
  notRun: PrivacyCheck[];
  /**
   * Findings that may be incomplete or absent for want of data: what each reports is true of the
   * data that is there, but more could be missing (a reuse among the unknown inputs) or a check
   * it depends on did not run. Conservative: it never omits a kind the missing or invalid data
   * could change, and it may list one that data could not in fact change.
   */
  unreliable: FindingKind[];
  /**
   * False when an amount or a total failed the amount check (each a safe whole number of sats no
   * larger than the supply, the outputs and the known inputs each within it together, the inputs
   * covering the outputs when all are known), so the rules that read amounts were held back. True
   * otherwise, a coinbase included, which is not checked.
   */
  amountsValid: boolean;
}

/** Whether a value is a round amount (`ROUND_UNIT`, `ROUND_DIGITS`). */
export function isRound(sats: number): boolean {
  if (sats < ROUND_UNIT || sats % ROUND_UNIT !== 0) return false;
  let n = sats;
  while (n % 10 === 0) n /= 10;
  return n < 10 ** ROUND_DIGITS;
}

const isRagged = (sats: number) => sats % RAGGED_UNIT !== 0;
/** Every bitcoin there will ever be, in sats: no amount can be more. */
const MAX_SATS = 21_000_000 * 100_000_000;
/** A whole, non-negative number of sats no larger than the supply, exactly as a number holds it. */
const isAmount = (v: number) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_SATS;
/**
 * The total of valid amounts, or null once it passes the supply. Each is a safe integer no larger
 * than the supply, so the sum stays exact until it stops.
 */
function total(values: number[]): number | null {
  let sum = 0;
  for (const v of values) {
    sum += v;
    if (sum > MAX_SATS) return null;
  }
  return sum;
}
const isAnchor = (o: Vout) => o.scriptpubkey.toLowerCase() === ANCHOR;
/** An output that pays someone: not data, not an anchor for fee bumping. */
const pays = (o: Vout) => o.scriptpubkey_type !== "op_return" && !isAnchor(o);
/** One address is one script; hex is compared in lower case. */
const key = (o: Vout) => o.scriptpubkey.toLowerCase();
const named = (o: Vout) => o.scriptpubkey_address ?? o.scriptpubkey.toLowerCase();
/** Whether every one of these scripts has an address, for the words that name them. */
const allNamed = (os: Iterable<Item>) => {
  for (const { o } of os) if (o.scriptpubkey_address === undefined) return false;
  return true;
};

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const xs = m.get(k);
  if (xs) xs.push(v);
  else m.set(k, [v]);
}

const KINDS: FindingKind[] = ["reuse", "change", "change-disputed", "coinjoin", "spent-together"];

interface Item {
  i: number;
  o: Vout;
}

/** What every check reads, worked out once. */
interface Shape {
  /** Inputs that fund the transaction: known, and not an anchor spent to bump a fee. */
  funding: Item[];
  /** Outputs that pay someone. */
  outs: Item[];
  /** Funding inputs by script. */
  inputsBy: Map<string, number[]>;
  /** Every input's previous output is known. */
  complete: boolean;
  /** Every amount, inputs' and outputs', is valid (`isAmount`): the rules that read one may run. */
  amounts: boolean;
}

/** Every address that appears more than once among the funding inputs and paying outputs. */
function reuse(s: Shape): ReusedAddress[] {
  const outputsBy = new Map<string, number[]>();
  for (const { i, o } of s.outs) push(outputsBy, key(o), i);
  const names = new Map<string, Vout>();
  for (const { o } of [...s.funding, ...s.outs]) names.set(key(o), o);
  const reused: ReusedAddress[] = [];
  for (const [k, o] of names) {
    const inputs = s.inputsBy.get(k) ?? [];
    const outputs = outputsBy.get(k) ?? [];
    if (inputs.length + outputs.length > 1)
      reused.push({
        address: named(o),
        isAddress: o.scriptpubkey_address !== undefined,
        inputs,
        outputs,
      });
  }
  return reused;
}

/**
 * Equal outputs to fresh, distinct addresses, from at least as many senders, in a transaction that
 * repeats no address among its inputs, pays none of them back, has no more other outputs than
 * equal ones, and no fewer outputs than inputs. Needs every input.
 */
function coinjoin(s: Shape): PrivacyFinding | null {
  const repeatsInput = [...s.inputsBy.values()].some((xs) => xs.length > 1);
  const paysBack = s.outs.some(({ o }) => s.inputsBy.has(key(o)));
  if (repeatsInput || paysBack) return null;
  const byValue = new Map<number, Map<string, number>>();
  for (const { i, o } of s.outs) {
    if (o.value < JOIN_MIN_VALUE) continue;
    const to = byValue.get(o.value) ?? new Map<string, number>();
    if (!to.has(key(o))) to.set(key(o), i);
    byValue.set(o.value, to);
  }
  const groups: EqualOutputs[] = [];
  const byIndex = new Map(s.outs.map((x) => [x.i, x]));
  for (const [value, to] of byValue)
    if (to.size >= JOIN_COUNT) {
      const outputs = [...to.values()];
      const items = outputs.flatMap((i) => byIndex.get(i) ?? []);
      groups.push({ value, outputs, toAddresses: allNamed(items) });
    }
  groups.sort((a, b) => b.outputs.length - a.outputs.length || b.value - a.value);
  const first = groups[0];
  const senders = s.inputsBy.size;
  if (!first || senders < first.outputs.length) return null;
  // Each person in a CoinJoin takes at most one output besides the equal ones, and every one seen
  // pays at least as many outputs as it spends inputs: a payout from one owner's fresh addresses,
  // with few outputs from many inputs or many outputs beside a few equal ones, is neither.
  const equal = groups.reduce((n, g) => n + g.outputs.length, 0);
  if (s.outs.length - equal > equal || s.outs.length < s.funding.length) return null;
  return { kind: "coinjoin", groups, senders, sendersAreAddresses: allNamed(s.funding) };
}

/** The one output paying back to an input's address, when other outputs are paid. */
function payback(s: Shape): ChangeReading | null {
  const back = s.outs.filter(({ o }) => s.inputsBy.has(key(o)));
  const only = back[0];
  if (back.length !== 1 || !only || s.outs.length < 2) return null;
  return {
    change: only.i,
    reason: {
      kind: "payback",
      inputs: s.inputsBy.get(key(only.o)) ?? [],
      isAddress: only.o.scriptpubkey_address !== undefined,
    },
  };
}

/** One round amount beside one that is not even a multiple of `RAGGED_UNIT`. */
function round(a: Item, b: Item): ChangeReading | null {
  const [r, other] =
    isRound(a.o.value) && isRagged(b.o.value)
      ? [a, b]
      : isRound(b.o.value) && isRagged(a.o.value)
        ? [b, a]
        : [];
  if (!r || !other) return null;
  return { change: other.i, reason: { kind: "round", roundOutput: r.i, value: r.o.value } };
}

/** Every input of one type, and exactly one of the two outputs of that type too. */
function script(s: Shape, a: Item, b: Item): ChangeReading | null {
  const type = s.funding[0]?.o.scriptpubkey_type;
  // "unknown" covers scripts of different kinds, so two of them are not known to match.
  if (type === undefined || type === "unknown") return null;
  if (!s.funding.every(({ o }) => o.scriptpubkey_type === type)) return null;
  const same = [a, b].filter(({ o }) => o.scriptpubkey_type === type);
  const match = same[0];
  if (same.length !== 1 || !match) return null;
  return { change: match.i, reason: { kind: "script", scriptType: type } };
}

/**
 * The smaller output is less than the smallest address's coins and the larger is not: smaller <
 * those coins <= larger. That is all it states; it does not prove the larger output needed every
 * coin. An address's inputs count as one coin, as a wallet that spends every coin of an address
 * together adds none it did not need.
 */
function unneeded(s: Shape, a: Item, b: Item): ChangeReading | null {
  if (s.inputsBy.size < 2) return null;
  const sums = new Map<string, number>();
  for (const { o } of s.funding) sums.set(key(o), (sums.get(key(o)) ?? 0) + o.value);
  let least: [string, number] | undefined;
  for (const e of sums) if (!least || e[1] < least[1]) least = e;
  const [lo, hi] = a.o.value <= b.o.value ? [a, b] : [b, a];
  if (!least || !(lo.o.value < least[1] && least[1] <= hi.o.value)) return null;
  const inputs = s.inputsBy.get(least[0]) ?? [];
  return {
    change: lo.i,
    reason: { kind: "unneeded", inputs, value: least[1], allAddresses: allNamed(s.funding) },
  };
}

/**
 * The change readings that apply and can run; those that could not are added to `notRun`. With
 * several outputs paying back to the inputs' addresses, none runs: those outputs go back to people
 * who signed, so no single sender's change is there to find.
 */
function changeReadings(s: Shape, notRun: PrivacyCheck[]): ChangeReading[] {
  if (s.outs.filter(({ o }) => s.inputsBy.has(key(o))).length > 1) return [];
  const found: (ChangeReading | null)[] = [];
  if (s.complete) found.push(payback(s));
  else notRun.push("payback");
  const [a, b] = s.outs.length === 2 ? s.outs : [];
  if (a && b) {
    if (s.amounts) found.push(round(a, b));
    else notRun.push("round");
    if (s.complete) found.push(script(s, a, b));
    else notRun.push("script");
    if (s.complete && s.amounts) found.push(unneeded(s, a, b));
    else notRun.push("unneeded");
  }
  return found.filter((r) => r !== null);
}

/**
 * What the transaction shows. At most n log n in its inputs and outputs: each check is one pass
 * with maps keyed by script or value, and the groups of equal outputs (at most a third of the
 * outputs) are sorted.
 */
export function checkPrivacy(tx: Transaction): PrivacyReport {
  const vin = tx.vin ?? [];
  const report: PrivacyReport = {
    coinbase: false,
    findings: [],
    unknownInputs: [],
    // Decided from the data, not the node's `pruned` flag: rbitcoin v0.9.2 sets that when the
    // scripts and witnesses are gone, and then lists every input or none.
    inputsMissing: vin.length === 0,
    notRun: [],
    unreliable: [],
    amountsValid: true,
  };
  if (vin[0]?.is_coinbase === true) return { ...report, coinbase: true, inputsMissing: false };

  const funding: Item[] = [];
  vin.forEach((input, i) => {
    const p = input.prevout;
    if (p === undefined || p === null) report.unknownInputs.push(i);
    else if (!isAnchor(p)) funding.push({ i, o: p });
  });
  const outs: Item[] = [];
  tx.vout.forEach((o, i) => {
    if (pays(o)) outs.push({ i, o });
  });
  const inputsBy = new Map<string, number[]>();
  for (const { i, o } of funding) push(inputsBy, key(o), i);
  const complete = !report.inputsMissing && report.unknownInputs.length === 0;
  // Every amount valid alone, the outputs and the known inputs each within the supply together,
  // and, when every input's value is known (anchors included), the inputs covering the outputs.
  const known = vin.flatMap((input) => (input.prevout ? [input.prevout.value] : []));
  const outValues = tx.vout.map((o) => o.value);
  let amounts = outValues.every((v) => isAmount(v)) && known.every((v) => isAmount(v));
  const outTotal = amounts ? total(outValues) : null;
  const inTotal = amounts ? total(known) : null;
  if (outTotal === null || inTotal === null) amounts = false;
  else if (complete && inTotal < outTotal) amounts = false;
  report.amountsValid = amounts;
  const s: Shape = { funding, outs, inputsBy, complete, amounts };
  const { findings, notRun } = report;

  const reused = reuse(s);
  if (reused.length > 0) findings.push({ kind: "reuse", addresses: reused });

  const join = complete && amounts ? coinjoin(s) : null;
  if (!complete || !amounts) notRun.push("coinjoin");
  if (join) findings.push(join);

  // A CoinJoin has no single sender, so which output is change does not apply.
  const all = join ? [] : changeReadings(s, notRun);
  // Pay-back outranks the rest: that output goes to someone who signed for an input, where the
  // others guess at a wallet's habits. Readings that point elsewhere are dropped, not disputed.
  const back = all.find((r) => r.reason.kind === "payback");
  const readings = back ? all.filter((r) => r.change === back.change) : all;
  const pointed = new Set(readings.map((r) => r.change));
  const [change] = pointed;
  if (pointed.size === 1 && change !== undefined) {
    const other = outs.length === 2 ? outs.find(({ i }) => i !== change) : undefined;
    findings.push({ kind: "change", change, payment: other?.i, readings });
  } else if (pointed.size > 1) findings.push({ kind: "change-disputed", readings });

  // Several inputs spent together, counting only inputs seen to fund it: an unknown one may be an
  // anchor, so it never makes up the number.
  const unknown = report.unknownInputs.length;
  if (report.inputsMissing) notRun.push("spent-together");
  else if (!join && funding.length > 1)
    findings.push({
      kind: "spent-together",
      inputs: funding.map(({ i }) => i),
      addresses: inputsBy.size,
      allAddresses: allNamed(funding),
      noChange: outs.length === 1,
    });
  else if (!join && unknown > 0 && funding.length + unknown > 1) notRun.push("spent-together");

  // Unreliable: only what the missing or invalid data could change. Two known pay-backs, or one
  // pay-back with every input known, settle the change question; a CoinJoin is ruled out by a
  // repeated input address, a known pay-back or fewer paying outputs than it needs.
  const knownBack = outs.filter(({ o }) => inputsBy.has(key(o))).length;
  const changeSettled = knownBack > 1 || (complete && knownBack === 1 && outs.length > 1);
  const joinSettled =
    outs.length < JOIN_COUNT || knownBack > 0 || [...inputsBy.values()].some((xs) => xs.length > 1);
  const joinOpen = (!complete || !amounts) && !joinSettled;
  const unreliable = new Set<FindingKind>();
  if (!complete) unreliable.add("reuse");
  const changeOpen = (!complete && outs.length > 1) || (!amounts && outs.length === 2);
  if (changeOpen && !changeSettled) {
    unreliable.add("change");
    unreliable.add("change-disputed");
  }
  if (joinOpen) unreliable.add("coinjoin");
  const togetherShown = findings.some((f) => f.kind === "spent-together");
  if (notRun.includes("spent-together") || (togetherShown && joinOpen))
    unreliable.add("spent-together");
  report.unreliable = KINDS.filter((k) => unreliable.has(k));
  return report;
}
