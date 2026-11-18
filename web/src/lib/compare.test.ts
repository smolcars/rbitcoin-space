import { describe, expect, it } from "vitest";
import {
  inputChange,
  type KeptOutput,
  matchOutputs,
  parseComparison,
  type VersionOutputs,
} from "./compare";

const pay = (tag: string, value: number): KeptOutput => ({
  value,
  script: `0014${tag.repeat(20)}`,
  address: `bcrt1q${tag}`,
});
const kept = (...list: KeptOutput[]): VersionOutputs => ({ state: "kept", list });

describe("matchOutputs", () => {
  it("marks each output kept, changed, added or removed", () => {
    const shop = pay("aa", 50_000);
    const change = pay("bb", 120_000);
    const gone = pay("cc", 9_000);
    const extra = pay("dd", 3_000);
    const m = matchOutputs(
      kept(shop, change, gone),
      kept({ ...change, value: 115_000 }, shop, extra),
    );
    expect(m).toStrictEqual({
      state: "matched",
      rows: [
        { kind: "changed", before: change, after: { ...change, value: 115_000 }, delta: -5_000 },
        { kind: "kept", before: shop, after: shop },
        { kind: "added", after: extra },
        { kind: "removed", before: gone },
      ],
    });
  });

  it("pairs a repeated destination's same amount first, then the rest in order", () => {
    // Two outputs to one script; the replacement keeps the 2,000 one and raises the other.
    const a = kept(pay("aa", 1_000), pay("aa", 2_000));
    const b = kept(pay("aa", 2_000), pay("aa", 1_500), pay("aa", 700));
    const m = matchOutputs(a, b);
    expect(
      m.state === "matched" && m.rows.map((r) => [r.kind, "delta" in r ? r.delta : 0]),
    ).toStrictEqual([
      ["kept", 0],
      ["changed", 500],
      ["added", 0],
    ]);
  });

  it("tells long scripts apart by length and hash", () => {
    const op = (hash: string): KeptOutput => ({ value: 0, scriptLen: 83, scriptHash: hash });
    const m = matchOutputs(kept(op("1".repeat(32))), kept(op("2".repeat(32))));
    expect(m.state === "matched" && m.rows.map((r) => r.kind)).toStrictEqual(["added", "removed"]);
    const same = matchOutputs(kept(op("1".repeat(32))), kept(op("1".repeat(32))));
    expect(same.state === "matched" && same.rows.map((r) => r.kind)).toStrictEqual(["kept"]);
  });

  it("says when either side has too many outputs or none recorded", () => {
    const many: VersionOutputs = { state: "too_many", count: 120 };
    expect(matchOutputs(kept(pay("aa", 1)), many)).toStrictEqual({
      state: "too_many",
      side: "b",
      counts: [1, 120],
    });
    expect(matchOutputs(many, many)).toMatchObject({ state: "too_many", side: "both" });
    const none: VersionOutputs = { state: "not_recorded" };
    expect(matchOutputs(none, kept())).toStrictEqual({ state: "not_recorded", side: "a" });
    // Not recorded wins: there is nothing to say about the other side's count.
    expect(matchOutputs(none, many)).toStrictEqual({ state: "not_recorded", side: "a" });
  });
});

describe("inputChange", () => {
  it("counts kept, dropped and added inputs only when the shared count is known", () => {
    const v = (inputs?: number) => ({
      txid: "0".repeat(64),
      outputs: { state: "not_recorded" } as const,
      ...(inputs === undefined ? {} : { inputs }),
    });
    expect(inputChange(v(3), v(2), 1)).toStrictEqual({ kept: 1, dropped: 2, added: 1 });
    expect(inputChange(v(3), v(2), undefined)).toBeUndefined();
    expect(inputChange(v(), v(2), 1)).toBeUndefined();
  });
});

describe("parseComparison", () => {
  const version = (txid: string, outputs: unknown) => ({
    txid,
    fee: 500,
    vsize: 200,
    weight: 800,
    value: 1000,
    rate: 2500,
    inputs: 2,
    from: "record",
    outputs,
  });
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  it("reads the route's answer, rates in sat/vB", () => {
    const c = parseComparison({
      a: version(A, { state: "kept", list: [{ value: 1, script: "0014aa", address: "bc1qx" }] }),
      b: version(B, { state: "too_many", count: 40 }),
      shared_inputs: 1,
    });
    expect(c?.a.rate).toBe(2.5);
    expect(c?.a.outputs).toStrictEqual({
      state: "kept",
      list: [{ value: 1, script: "0014aa", address: "bc1qx" }],
    });
    expect(c?.sharedInputs).toBe(1);
  });

  it("refuses what is not one, and drops an address that is not an address", () => {
    expect(
      parseComparison({ a: version(A, { state: "kept" }), b: version(B, {}) }),
    ).toBeUndefined();
    expect(
      parseComparison({
        a: version(A, { state: "kept", list: [{ value: 1, script: "zz" }] }),
        b: version(B, { state: "not_recorded" }),
      }),
    ).toBeUndefined();
    const c = parseComparison({
      a: version(A, { state: "kept", list: [{ value: 1, script: "00", address: "<b>x</b>" }] }),
      b: version(B, { state: "not_recorded" }),
      shared_inputs: null,
    });
    expect(c?.a.outputs).toStrictEqual({ state: "kept", list: [{ value: 1, script: "00" }] });
    expect(c && "sharedInputs" in c).toBe(false);
  });
});
