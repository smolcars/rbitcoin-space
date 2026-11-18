// Two versions of a replaced transaction side by side (`/app/tx/:txid/compare/:other`,
// docs/FRONTEND.md "A transaction's relatives and replacements"), and the pure matching of their
// outputs. Scripts and addresses are attacker-controlled text: they are only ever shown as text.

/** One output as the server kept it: a script in full (with its address), or a long one's hash. */
export interface KeptOutput {
  /** sats */
  value: number;
  /** Hex, for a script of at most 34 bytes. */
  script?: string;
  address?: string;
  /** A longer script: its length in bytes and the first 16 bytes of its SHA-256, hex. */
  scriptLen?: number;
  scriptHash?: string;
}

export type VersionOutputs =
  | { state: "kept"; list: KeptOutput[] }
  | { state: "too_many"; count: number }
  | { state: "not_recorded" };

export interface Version {
  txid: string;
  fee?: number;
  vsize?: number;
  value?: number;
  /** sat/vB */
  rate?: number;
  inputs?: number;
  outputs: VersionOutputs;
}

export interface Comparison {
  a: Version;
  b: Version;
  /** Inputs both spend, when one directly replaced the other. */
  sharedInputs?: number;
  /** The sizes' basis: `weight` when a side came from the node (weight over four, both sides). */
  vsizeBasis: "sigops" | "weight";
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isHex = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && v.length % 2 === 0 && /^[0-9a-f]*$/.test(v);
const opt = (v: unknown): number | undefined => (isCount(v) ? v : undefined);

function outputOf(v: unknown): KeptOutput | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!isCount(o["value"])) return undefined;
  if (isHex(o["script"], 68)) {
    const out: KeptOutput = { value: o["value"], script: o["script"] };
    // An address is the server's own encoding of the script; anything else is dropped.
    const a = o["address"];
    if (typeof a === "string" && a.length <= 100 && /^[0-9A-Za-z]+$/.test(a)) out.address = a;
    return out;
  }
  if (isCount(o["script_len"]) && isHex(o["script_hash"], 32) && o["script_hash"].length === 32) {
    return { value: o["value"], scriptLen: o["script_len"], scriptHash: o["script_hash"] };
  }
  return undefined;
}

function outputsOf(v: unknown): VersionOutputs | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  switch (o["state"]) {
    case "kept": {
      const list = o["list"];
      if (!Array.isArray(list) || list.length > MAX_OUTPUTS) return undefined;
      const out: KeptOutput[] = [];
      for (const x of list) {
        const k = outputOf(x);
        if (!k) return undefined;
        out.push(k);
      }
      return { state: "kept", list: out };
    }
    case "too_many": {
      return isCount(o["count"]) ? { state: "too_many", count: o["count"] } : undefined;
    }
    case "not_recorded": {
      return { state: "not_recorded" };
    }
    default: {
      return undefined;
    }
  }
}

/** The most outputs the server keeps for one version (`engine::outputs::MAX_OUTPUTS`). */
export const MAX_OUTPUTS = 32;

function versionOf(v: unknown): Version | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const txid = o["txid"];
  const outputs = outputsOf(o["outputs"]);
  if (typeof txid !== "string" || !/^[0-9a-f]{64}$/.test(txid) || !outputs) return undefined;
  const version: Version = { txid, outputs };
  const fields = {
    fee: opt(o["fee"]),
    vsize: opt(o["vsize"]),
    value: opt(o["value"]),
    rate: isCount(o["rate"]) ? o["rate"] / 1000 : undefined,
    inputs: opt(o["inputs"]),
  };
  for (const [k, value] of Object.entries(fields)) {
    if (value !== undefined) (version as unknown as Record<string, number>)[k] = value;
  }
  return version;
}

/** The route's answer, or undefined when it is not one. */
export function parseComparison(v: unknown): Comparison | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const a = versionOf(r["a"]);
  const b = versionOf(r["b"]);
  if (!a || !b) return undefined;
  const out: Comparison = { a, b, vsizeBasis: r["vsize_basis"] === "weight" ? "weight" : "sigops" };
  const shared = opt(r["shared_inputs"]);
  if (shared !== undefined) out.sharedInputs = shared;
  return out;
}

/** One output of the newer version against the older. */
export type OutputChange =
  | { kind: "kept"; before: KeptOutput; after: KeptOutput }
  | { kind: "changed"; before: KeptOutput; after: KeptOutput; delta: number }
  | { kind: "added"; after: KeptOutput }
  | { kind: "removed"; before: KeptOutput };

/** Why two versions' outputs cannot be matched. */
export type Unmatched =
  | { state: "too_many"; side: "a" | "b" | "both"; counts: [number | null, number | null] }
  | { state: "not_recorded"; side: "a" | "b" | "both" };

export type Matched = { state: "matched"; rows: OutputChange[] } | Unmatched;

/** Two outputs pay the same destination when their scripts are the same bytes. */
export function keyOf(o: KeptOutput): string {
  return o.script === undefined ? `h:${o.scriptLen ?? 0}:${o.scriptHash ?? ""}` : `s:${o.script}`;
}

/**
 * Matches `b`'s outputs against `a`'s by destination. For each destination, outputs of the same
 * amount pair first (kept); the rest pair in order (changed, with the difference); what is left
 * was added (only in `b`) or removed (only in `a`). Rows follow `b`'s order, removed ones after,
 * in `a`'s order.
 */
export function matchOutputs(a: VersionOutputs, b: VersionOutputs): Matched {
  const side = (x: boolean, y: boolean) => (x && y ? "both" : x ? "a" : "b");
  const missingA = a.state === "not_recorded";
  const missingB = b.state === "not_recorded";
  if (missingA || missingB) return { state: "not_recorded", side: side(missingA, missingB) };
  if (a.state === "too_many" || b.state === "too_many") {
    return {
      state: "too_many",
      side: side(a.state === "too_many", b.state === "too_many"),
      counts: [
        a.state === "too_many" ? a.count : a.list.length,
        b.state === "too_many" ? b.count : b.list.length,
      ],
    };
  }
  // Each of a's outputs by destination, in order, not yet paired.
  const free = new Map<string, number[]>();
  a.list.forEach((o, i) => {
    const k = keyOf(o);
    free.set(k, [...(free.get(k) ?? []), i]);
  });
  const pairedWith: (number | undefined)[] = b.list.map(() => undefined);
  const take = (k: string, i: number) => {
    const list = free.get(k) ?? [];
    free.set(
      k,
      list.filter((x) => x !== i),
    );
  };
  // Same destination and amount first, so a duplicate destination pairs its unchanged one.
  b.list.forEach((o, j) => {
    const k = keyOf(o);
    const i = (free.get(k) ?? []).find((x) => a.list[x]?.value === o.value);
    if (i !== undefined) {
      pairedWith[j] = i;
      take(k, i);
    }
  });
  b.list.forEach((o, j) => {
    if (pairedWith[j] !== undefined) return;
    const k = keyOf(o);
    const i = (free.get(k) ?? [])[0];
    if (i !== undefined) {
      pairedWith[j] = i;
      take(k, i);
    }
  });
  const rows: OutputChange[] = [];
  b.list.forEach((after, j) => {
    const i = pairedWith[j];
    const before = i === undefined ? undefined : a.list[i];
    if (!before) rows.push({ kind: "added", after });
    else if (before.value === after.value) rows.push({ kind: "kept", before, after });
    else rows.push({ kind: "changed", before, after, delta: after.value - before.value });
  });
  const paired = new Set(pairedWith);
  a.list.forEach((before, i) => {
    if (!paired.has(i)) rows.push({ kind: "removed", before });
  });
  return { state: "matched", rows };
}

/** How many inputs `b` kept, dropped and added against `a`, when they share a known number. */
export function inputChange(
  a: Version,
  b: Version,
  shared: number | undefined,
): { kept: number; dropped: number; added: number } | undefined {
  if (shared === undefined || a.inputs === undefined || b.inputs === undefined) return undefined;
  return {
    kept: shared,
    dropped: Math.max(0, a.inputs - shared),
    added: Math.max(0, b.inputs - shared),
  };
}
