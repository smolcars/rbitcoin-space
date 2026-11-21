import { describe, expect, it } from "vitest";
import { cost } from "./cost";
import type { ScriptType, Transaction, Vin, Vout } from "./esplora";
import {
  type ChangeReading,
  checkPrivacy,
  type FindingKind,
  isRound,
  JOIN_COUNT,
  JOIN_MIN_VALUE,
  type PrivacyFinding,
  type PrivacyReport,
  RAGGED_UNIT,
  ROUND_UNIT,
  UNSENT_ONLY,
} from "./privacy";

// Mainnet transactions trimmed to what the rules read (fixtures/privacy/README.md).
const RECORDED = import.meta.glob<Transaction[]>("../../../fixtures/privacy/*.json", {
  eager: true,
  import: "default",
});
const MAINNET = RECORDED["../../../fixtures/privacy/mainnet.json"] ?? [];
const SIGNET = RECORDED["../../../fixtures/privacy/signet.json"] ?? [];

/** A recorded transaction by the start of its txid. */
function recorded(prefix: string): Transaction {
  const t = [...MAINNET, ...SIGNET].find((x) => x.txid.startsWith(prefix));
  if (!t) throw new Error(`no fixture ${prefix}`);
  return t;
}

function finding<K extends FindingKind>(
  r: PrivacyReport,
  kind: K,
): Extract<PrivacyFinding, { kind: K }> | undefined {
  return r.findings.find((f): f is Extract<PrivacyFinding, { kind: K }> => f.kind === kind);
}

const kinds = (r: PrivacyReport) => r.findings.map((f) => f.kind);
/** The reading kinds behind a change finding, agreeing or disputed. */
function reasons(r: PrivacyReport): string[] {
  const f = finding(r, "change") ?? finding(r, "change-disputed");
  return (f?.readings ?? []).map((x: ChangeReading) => `${x.reason.kind}>${x.change}`);
}
/** What a sent transaction shows: everything but the findings for an unsent one. */
const sentKinds = (r: PrivacyReport) => kinds(r).filter((k) => !UNSENT_ONLY.has(k));

// ---- Synthetic transactions for the boundaries: each address is a distinct P2WPKH script. ----

interface Coin {
  value: number;
  /** A label standing for an address: equal labels are one address. */
  to: string;
  type?: ScriptType;
}

const SCRIPT_PREFIX: Partial<Record<ScriptType, string>> = {
  v0_p2wpkh: "0014",
  v1_p2tr: "5120",
  p2sh: "a914",
  p2pkh: "76a914",
};

function out(c: Coin): Vout {
  const type = c.type ?? "v0_p2wpkh";
  const body = Array.from(c.to, (ch) =>
    (ch.codePointAt(0) ?? 0).toString(16).padStart(2, "0"),
  ).join("");
  return {
    scriptpubkey: `${SCRIPT_PREFIX[type] ?? "00"}${body.padEnd(40, "0")}`,
    scriptpubkey_asm: "",
    scriptpubkey_type: type,
    scriptpubkey_address: `addr-${type}-${c.to}`,
    value: c.value,
  };
}

const ANCHOR_OUT: Vout = {
  scriptpubkey: "51024e73",
  scriptpubkey_asm: "",
  scriptpubkey_type: "unknown",
  scriptpubkey_address: "bc1pfeessrawgf",
  value: 240,
};
const OP_RETURN: Vout = {
  scriptpubkey: "6a0568656c6c6f",
  scriptpubkey_asm: "",
  scriptpubkey_type: "op_return",
  value: 0,
};

let parent = 0;
function input(prevout: Vout | null | undefined): Vin {
  parent += 1;
  return {
    txid: parent.toString(16).padStart(64, "0"),
    vout: 0,
    is_coinbase: false,
    ...(prevout === undefined ? {} : { prevout }),
  };
}

function tx(ins: (Coin | Vout | null | undefined)[], outs: (Coin | Vout)[]): Transaction {
  const asVout = (c: Coin | Vout) => ("scriptpubkey" in c ? c : out(c));
  return {
    txid: "f".repeat(64),
    version: 2,
    locktime: 0,
    status: { confirmed: false },
    vin: ins.map((c) => input(c === null || c === undefined ? c : asVout(c))),
    vout: outs.map((o) => asVout(o)),
  };
}

/** `t` with input `k`'s previous output replaced: `null` (the node lacks it) or absent (not looked up). */
function withInput(t: Transaction, k: number, prevout: null | undefined): Transaction {
  const vin = [...(t.vin ?? [])];
  const was = vin[k];
  if (was) {
    const { prevout: _, ...rest } = was;
    vin[k] = prevout === null ? { ...rest, prevout: null } : rest;
  }
  return { ...t, vin };
}

/** Two outputs from one input of `inValue`, the rest of which is fee. */
const pair = (a: number, b: number, inValue = a + b + 500) =>
  tx(
    [{ value: inValue, to: "me" }],
    [
      { value: a, to: "x" },
      { value: b, to: "y" },
    ],
  );

/** `n` equal outputs of `value` to fresh addresses, from `senders` inputs at distinct addresses. */
function join(n: number, value: number, senders = n) {
  const ins = Array.from({ length: senders }, (_, k) => ({ value: value + 10_000, to: `in${k}` }));
  const outs = Array.from({ length: n }, (_, k) => ({ value, to: `out${k}` }));
  return tx(ins, outs);
}

describe("fixtures", () => {
  it("every recorded transaction is there", () => {
    expect(MAINNET).toHaveLength(29);
    expect(SIGNET).toHaveLength(1);
  });
});

describe("address reuse", () => {
  it("fires when an output pays the address its input spends from (c6772727)", () => {
    const r = checkPrivacy(recorded("c6772727"));
    expect(finding(r, "reuse")?.addresses.map((a) => [a.inputs, a.outputs])).toStrictEqual([
      [[0], [1]],
    ]);
  });
  it("fires when four inputs spend from one address (838a60b0)", () => {
    const r = checkPrivacy(recorded("838a60b0"));
    expect(finding(r, "reuse")?.addresses).toStrictEqual([
      expect.objectContaining({ inputs: [0, 1, 2, 3], outputs: [] }),
    ]);
  });
  it("fires when two outputs pay one address", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 50_000, to: "a" }],
        [
          { value: 20_000, to: "b" },
          { value: 20_000, to: "b" },
        ],
      ),
    );
    expect(finding(r, "reuse")?.addresses).toStrictEqual([
      expect.objectContaining({ inputs: [], outputs: [0, 1] }),
    ]);
  });
  it("does not fire on two inputs from one parent at different addresses (1a52e9c6)", () => {
    const t = recorded("1a52e9c6");
    expect(t.vin?.[0]?.txid).toBe(t.vin?.[1]?.txid);
    expect(kinds(checkPrivacy(t))).not.toContain("reuse");
  });
  it("names the address it found, and the script when there is no address", () => {
    const bare: Vout = { ...out({ value: 30_000, to: "k" }), scriptpubkey_type: "p2pk" };
    delete bare.scriptpubkey_address;
    const r = checkPrivacy(tx([bare], [bare, { value: 10_000, to: "z" }]));
    expect(finding(r, "reuse")?.addresses[0]?.address).toBe(bare.scriptpubkey);
    // Said by the rules, never guessed from the string's shape.
    expect(finding(r, "reuse")?.addresses[0]?.isAddress).toBe(false);
    // A pay-back to it says the same of the script paid back.
    expect(finding(r, "change")?.readings[0]?.reason).toMatchObject({
      kind: "payback",
      isAddress: false,
    });
  });
  it("says an address is one, even when it is all lower-case hex (a real P2PKH form)", () => {
    const hexLike: Vout = {
      ...out({ value: 30_000, to: "h" }),
      scriptpubkey_type: "p2pkh",
      scriptpubkey_address: "1646e6df533667199e41221ee21315b14f",
    };
    const r = checkPrivacy(tx([hexLike], [hexLike, { value: 10_000, to: "z" }]));
    expect(finding(r, "reuse")?.addresses[0]).toMatchObject({
      address: "1646e6df533667199e41221ee21315b14f",
      isAddress: true,
    });
  });
  it("does not fire on OP_RETURN outputs or anchors that repeat", () => {
    const r = checkPrivacy(
      tx(
        [ANCHOR_OUT, { value: 50_000, to: "a" }],
        [OP_RETURN, OP_RETURN, ANCHOR_OUT, { value: 40_000, to: "b" }],
      ),
    );
    expect(kinds(r)).not.toContain("reuse");
  });
  it("an attacker's address that names an object's own key is only a key", () => {
    const evil = (name: string): Vout => ({
      ...out({ value: 20_000, to: name }),
      scriptpubkey_address: name,
    });
    const r = checkPrivacy(
      tx([evil("__proto__"), evil("constructor")], [evil("__proto__"), evil("toString")]),
    );
    expect(finding(r, "reuse")?.addresses.map((a) => a.address)).toStrictEqual(["__proto__"]);
  });
});

describe("change: pays back to an input's address", () => {
  it("fires on the one output paying back (c6772727)", () => {
    const r = checkPrivacy(recorded("c6772727"));
    expect(finding(r, "change")).toMatchObject({ change: 1, payment: 0 });
    expect(reasons(r)).toStrictEqual(["payback>1"]);
  });
  it("fires beside other outputs, with no payment named when there are more than two (aa213508)", () => {
    const r = checkPrivacy(recorded("aa213508"));
    expect(finding(r, "change")).toMatchObject({ change: 4, payment: undefined });
    expect(finding(r, "change")?.readings[0]?.reason).toStrictEqual({
      kind: "payback",
      inputs: [0, 3, 4],
      isAddress: true,
    });
  });
  it("does not call multi-party pay-backs change (a3582ef2)", () => {
    const r = checkPrivacy(recorded("a3582ef2"));
    expect(kinds(r)).toContain("reuse");
    expect(kinds(r)).not.toContain("change");
    expect(kinds(r)).not.toContain("change-disputed");
  });
  it("does not fire when the only paying output pays back (a Runes mint, cbd57624)", () => {
    const r = checkPrivacy(recorded("cbd57624"));
    expect(kinds(r)).toStrictEqual(["reuse"]);
  });
});

describe("change: pay-back outranks the other readings", () => {
  it("reads as change by pay-back where unnecessary input pointed the other way (e19de13c, signet)", () => {
    const r = checkPrivacy(recorded("e19de13c"));
    expect(kinds(r)).not.toContain("change-disputed");
    expect(finding(r, "change")).toMatchObject({ change: 1, payment: 0 });
    // Script type agrees and stays as a further reason; unnecessary input pointed at 0 and is dropped.
    expect(reasons(r)).toStrictEqual(["payback>1", "script>1"]);
  });
  it("reads as change by pay-back from one address's four coins (5ef71273)", () => {
    const r = checkPrivacy(recorded("5ef71273"));
    expect(kinds(r)).not.toContain("change-disputed");
    expect(finding(r, "change")).toMatchObject({ change: 1, payment: 0 });
    expect(reasons(r)).toStrictEqual(["payback>1"]);
  });
  it("lists another reading that agrees with pay-back (43c76933)", () => {
    expect(reasons(checkPrivacy(recorded("43c76933")))).toStrictEqual(["payback>1", "round>1"]);
  });
  it("drops a reading that points away from the pay-back", () => {
    // Output 1 pays back; output 1 is also round, so the round reading points at 0, and is dropped.
    const r = checkPrivacy(
      tx(
        [{ value: 1_000_000, to: "me" }],
        [
          { value: 123_457, to: "x" },
          { value: 500_000, to: "me" },
        ],
      ),
    );
    expect(finding(r, "change")).toMatchObject({ change: 1, payment: 0 });
    expect(reasons(r)).toStrictEqual(["payback>1"]);
  });
  it("with no pay-back, readings that disagree stay disputed (b9b5d886)", () => {
    const r = checkPrivacy(recorded("b9b5d886"));
    expect(kinds(r)).toContain("change-disputed");
    expect(reasons(r)).toStrictEqual(["round>0", "script>1", "unneeded>1"]);
  });
  it("with two outputs paying back, no change reading runs at all (R1)", () => {
    // Round would point at output 1, but both outputs go back to someone who signed for an input.
    const r = checkPrivacy(
      tx(
        [
          { value: 800_000, to: "a" },
          { value: 300_000, to: "b" },
        ],
        [
          { value: 500_000, to: "a" },
          { value: 578_901, to: "b" },
        ],
      ),
    );
    expect(kinds(r)).toStrictEqual(["reuse", "spent-together"]);
    expect(reasons(r)).toStrictEqual([]);
  });
});

describe("change: round amount", () => {
  it("fires on 1 BTC beside an uneven amount (cc0f8bc1)", () => {
    const r = checkPrivacy(recorded("cc0f8bc1"));
    expect(finding(r, "change")).toMatchObject({ change: 1, payment: 0 });
    expect(finding(r, "change")?.readings[0]?.reason).toStrictEqual({
      kind: "round",
      roundOutput: 0,
      value: 100_000_000,
    });
  });
  it("fires on 2 BTC beside an uneven amount (4d8128a5)", () => {
    expect(reasons(checkPrivacy(recorded("4d8128a5")))).toStrictEqual(["round>1"]);
  });
  it("does not fire when both outputs are round (88d604b6)", () => {
    expect(reasons(checkPrivacy(recorded("88d604b6")))).not.toContain("round>0");
    expect(reasons(checkPrivacy(recorded("88d604b6")))).not.toContain("round>1");
  });
  it("does not fire when the other output is a multiple of 1,000 sats (5b5b2925)", () => {
    expect(kinds(checkPrivacy(recorded("5b5b2925")))).not.toContain("change");
  });
  it("boundary: 9,999 sats is not round, 10,000 is", () => {
    expect(isRound(ROUND_UNIT - 1)).toBe(false);
    expect(isRound(ROUND_UNIT)).toBe(true);
    expect(reasons(checkPrivacy(pair(9_999, 123_457)))).toStrictEqual([]);
    expect(reasons(checkPrivacy(pair(10_000, 123_457)))).toStrictEqual(["round>1"]);
  });
  it("boundary: two significant digits are round, three are not", () => {
    expect(isRound(1_200_000)).toBe(true);
    expect(isRound(1_230_000)).toBe(false);
    expect(reasons(checkPrivacy(pair(1_200_000, 123_457)))).toStrictEqual(["round>1"]);
    expect(reasons(checkPrivacy(pair(1_230_000, 123_457)))).toStrictEqual([]);
  });
  it("boundary: an other output ending in 999 sats reads as not round, one ending in 000 does not", () => {
    expect(reasons(checkPrivacy(pair(500_000, 100_999)))).toStrictEqual(["round>1"]);
    expect(reasons(checkPrivacy(pair(500_000, 100 * RAGGED_UNIT + RAGGED_UNIT)))).toStrictEqual([]);
  });
  it("does not fire with three paying outputs", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 1_000_000, to: "me" }],
        [
          { value: 500_000, to: "a" },
          { value: 123_457, to: "b" },
          { value: 100_001, to: "c" },
        ],
      ),
    );
    expect(reasons(r)).toStrictEqual([]);
  });
  it("leaves an OP_RETURN out: two paying outputs beside it still count as two", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 1_000_000, to: "me" }],
        [OP_RETURN, { value: 500_000, to: "a" }, { value: 123_457, to: "b" }],
      ),
    );
    expect(reasons(r)).toStrictEqual(["round>2"]);
  });
});

describe("change: script type", () => {
  it("fires when only one output is Taproot like the input (6029f593)", () => {
    const r = checkPrivacy(recorded("6029f593"));
    expect(finding(r, "change")?.readings[0]?.reason).toStrictEqual({
      kind: "script",
      scriptType: "v1_p2tr",
    });
    expect(reasons(r)).toStrictEqual(["script>1"]);
  });
  it("fires when only one output is P2SH like the input (21707bf9)", () => {
    expect(reasons(checkPrivacy(recorded("21707bf9")))).toStrictEqual(["script>1"]);
  });
  it("does not fire when the inputs are of mixed types (75ebacb6)", () => {
    expect(kinds(checkPrivacy(recorded("75ebacb6")))).not.toContain("change");
  });
  it("does not fire when both outputs match the inputs' type", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 300_000, to: "me", type: "v1_p2tr" }],
        [
          { value: 123_456, to: "a", type: "v1_p2tr" },
          { value: 165_432, to: "b", type: "v1_p2tr" },
        ],
      ),
    );
    expect(reasons(r)).toStrictEqual([]);
  });
  it("does not take two scripts of unknown type as one type", () => {
    const unknown = (to: string, value: number): Vout => ({
      ...out({ value, to }),
      scriptpubkey_type: "unknown",
    });
    const r = checkPrivacy(
      tx([unknown("me", 300_000)], [unknown("a", 123_456), { value: 165_432, to: "b" }]),
    );
    expect(reasons(r)).toStrictEqual([]);
  });
});

describe("change: unnecessary input", () => {
  it("fires when the smaller output did not need the smallest input (b1a68e4c)", () => {
    const r = checkPrivacy(recorded("b1a68e4c"));
    expect(finding(r, "change")?.readings[0]?.reason).toStrictEqual({
      kind: "unneeded",
      inputs: [1],
      value: 11_748_854,
      allAddresses: true,
    });
    expect(reasons(r)).toStrictEqual(["unneeded>0"]);
  });
  it("fires on four inputs (205128fe)", () => {
    expect(reasons(checkPrivacy(recorded("205128fe")))).toStrictEqual(["unneeded>1"]);
  });
  it("does not fire when the smaller output is larger than the smallest input (b7081832)", () => {
    expect(kinds(checkPrivacy(recorded("b7081832")))).not.toContain("change");
  });
  it("boundary: smaller output one sat below the smallest input fires; equal to it does not", () => {
    const ins = (smaller: number) =>
      tx(
        [
          { value: 200_003, to: "i0" },
          { value: 1_000_001, to: "i1" },
        ],
        [
          { value: smaller, to: "a" },
          { value: 900_001, to: "b" },
        ],
      );
    expect(reasons(checkPrivacy(ins(200_002)))).toStrictEqual(["unneeded>0"]);
    expect(reasons(checkPrivacy(ins(200_003)))).toStrictEqual([]);
  });
  it("does not fire when every input spends from one address: they are spent together (43c76933)", () => {
    expect(reasons(checkPrivacy(recorded("43c76933")))).not.toContain("unneeded>1");
  });
  it("counts an address's inputs as one coin", () => {
    // The smallest input, 150,001, shares its address with 900,001: together they were needed.
    const ins = [
      { value: 150_001, to: "a" },
      { value: 900_001, to: "a" },
      { value: 400_003, to: "b" },
    ];
    const outs = [
      { value: 100_001, to: "x" },
      { value: 1_349_003, to: "y" },
    ];
    expect(finding(checkPrivacy(tx(ins, outs)), "change")?.readings[0]?.reason).toStrictEqual({
      kind: "unneeded",
      inputs: [2],
      value: 400_003,
      allAddresses: true,
    });
  });
  it("does not fire on one input", () => {
    expect(reasons(checkPrivacy(pair(123_457, 654_321)))).toStrictEqual([]);
  });
  it("boundary: smallest input equal to the larger output fires; one sat more does not", () => {
    const ins = (least: number) =>
      tx(
        [
          { value: least, to: "i0" },
          { value: 1_000_001, to: "i1" },
        ],
        [
          { value: 100_001, to: "a" },
          { value: 300_001, to: "b" },
        ],
      );
    expect(reasons(checkPrivacy(ins(300_001)))).toStrictEqual(["unneeded>0"]);
    expect(reasons(checkPrivacy(ins(300_002)))).toStrictEqual([]);
  });
  it("leaves out an anchor spent to bump the fee", () => {
    const r = checkPrivacy(
      tx(
        [ANCHOR_OUT, { value: 1_000_000, to: "me" }],
        [
          { value: 123_457, to: "a" },
          { value: 765_431, to: "b" },
        ],
      ),
    );
    expect(reasons(r)).toStrictEqual([]);
    expect(kinds(r)).not.toContain("spent-together");
  });
});

describe("change: several readings", () => {
  it("two readings agree on output 1 beside a reused address (43c76933)", () => {
    const r = checkPrivacy(recorded("43c76933"));
    expect(finding(r, "change")).toMatchObject({ change: 1, payment: 0 });
    expect(reasons(r)).toStrictEqual(["payback>1", "round>1"]);
    expect(sentKinds(r)).toStrictEqual(["reuse", "change"]);
  });
  it("round, script and unneeded agree on output 0 (2a0a2891)", () => {
    expect(reasons(checkPrivacy(recorded("2a0a2891")))).toStrictEqual([
      "round>0",
      "script>0",
      "unneeded>0",
    ]);
  });
  it("readings that disagree are a disputed finding, never a change (b9b5d886)", () => {
    const r = checkPrivacy(recorded("b9b5d886"));
    expect(kinds(r)).toContain("change-disputed");
    expect(kinds(r)).not.toContain("change");
    expect(reasons(r)).toStrictEqual(["round>0", "script>1", "unneeded>1"]);
  });
});

describe("CoinJoin", () => {
  it("fires on nine outputs of 0.01 BTC from twelve addresses (cd47d71f)", () => {
    const r = checkPrivacy(recorded("cd47d71f"));
    const f = finding(r, "coinjoin");
    expect(f?.senders).toBe(12);
    expect(f?.groups.map((g) => [g.value, g.outputs.length])).toStrictEqual([[1_000_000, 9]]);
  });
  it("fires on two groups of eight, the larger value first (d84201d1)", () => {
    const f = finding(checkPrivacy(recorded("d84201d1")), "coinjoin");
    expect(f?.groups.map((g) => [g.value, g.outputs.length])).toStrictEqual([
      [50_000_000, 8],
      [14_348_907, 8],
    ]);
  });
  it("switches the change readings off", () => {
    const r = checkPrivacy(recorded("cd47d71f"));
    expect(kinds(r)).toStrictEqual(["coinjoin"]);
  });
  it("does not fire on a custodial split from reused addresses (aa213508)", () => {
    expect(kinds(checkPrivacy(recorded("aa213508")))).not.toContain("coinjoin");
  });
  it("does not fire on a marketplace trade paying sellers back (a3582ef2)", () => {
    expect(kinds(checkPrivacy(recorded("a3582ef2")))).not.toContain("coinjoin");
  });
  it("boundary: two equal outputs are not enough, three are", () => {
    expect(kinds(checkPrivacy(join(JOIN_COUNT - 1, 100_000)))).not.toContain("coinjoin");
    expect(kinds(checkPrivacy(join(JOIN_COUNT, 100_000)))).toContain("coinjoin");
  });
  it("boundary: 4,999 sats is too small, 5,000 is enough", () => {
    expect(kinds(checkPrivacy(join(3, JOIN_MIN_VALUE - 1)))).not.toContain("coinjoin");
    expect(kinds(checkPrivacy(join(3, JOIN_MIN_VALUE)))).toContain("coinjoin");
  });
  it("does not fire with fewer senders than equal outputs", () => {
    expect(kinds(checkPrivacy(join(3, 100_000, 2)))).not.toContain("coinjoin");
  });
  it("does not fire when the equal outputs pay one address (a split)", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 400_000, to: "a" },
          { value: 400_000, to: "b" },
          { value: 400_000, to: "c" },
        ],
        [
          { value: 100_000, to: "s" },
          { value: 100_000, to: "s" },
          { value: 100_000, to: "s" },
        ],
      ),
    );
    expect(kinds(r)).not.toContain("coinjoin");
  });
  it("does not fire on a payout of five equal outputs and one change from 24 inputs (a96fd879)", () => {
    expect(kinds(checkPrivacy(recorded("a96fd879")))).not.toContain("coinjoin");
  });
  it("does not fire on three equal outputs among 132 from four inputs (d8aaa9f4)", () => {
    expect(kinds(checkPrivacy(recorded("d8aaa9f4")))).not.toContain("coinjoin");
  });
  it("boundary: as many other outputs as equal ones fires; one more does not", () => {
    const base = join(3, 100_000, 3);
    const others = (n: number) =>
      Array.from({ length: n }, (_, k) => out({ value: 12_345 + k, to: `change${k}` }));
    const withOthers = (n: number) => ({
      ...base,
      vin: [
        ...(base.vin ?? []),
        ...Array.from({ length: n }, (_, k) => input(out({ value: 50_000, to: `more${k}` }))),
      ],
      vout: [...base.vout, ...others(n)],
    });
    expect(kinds(checkPrivacy(withOthers(3)))).toContain("coinjoin");
    expect(kinds(checkPrivacy(withOthers(4)))).not.toContain("coinjoin");
  });
  it("boundary: as many outputs as inputs fires; one input more does not", () => {
    const base = join(3, 100_000, 3);
    const extra = input(out({ value: 50_000, to: "extra" }));
    expect(kinds(checkPrivacy(base))).toContain("coinjoin");
    expect(kinds(checkPrivacy({ ...base, vin: [...(base.vin ?? []), extra] }))).not.toContain(
      "coinjoin",
    );
  });
  it("does not fire when an output pays back to an input's address", () => {
    const t = join(3, 100_000);
    const r = checkPrivacy({ ...t, vout: [...t.vout, out({ value: 7_777, to: "in0" })] });
    expect(kinds(r)).not.toContain("coinjoin");
  });
  it("cannot meet a change reading: three paying outputs and no pay-back leave none to make", () => {
    // Why switching the change readings off is a guard, not a test of its own: the CoinJoin's
    // conditions already exclude every change reading (docs/FRONTEND.md "Privacy check").
    const joins = MAINNET.map((t) => kinds(checkPrivacy(t))).filter((k) => k.includes("coinjoin"));
    expect(joins).toHaveLength(2);
    expect(joins.filter((k) => k.includes("change"))).toStrictEqual([]);
  });
  it("does not fire when one input address is repeated", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 400_000, to: "a" },
          { value: 400_000, to: "b" },
          { value: 400_000, to: "c" },
          { value: 400_000, to: "c" },
        ],
        [
          { value: 100_000, to: "x" },
          { value: 100_000, to: "y" },
          { value: 100_000, to: "z" },
          { value: 1_087_654, to: "w" },
        ],
      ),
    );
    expect(kinds(r)).not.toContain("coinjoin");
  });
});

describe("spent together (unsent only)", () => {
  it("is marked for an unsent transaction only", () => {
    expect([...UNSENT_ONLY]).toStrictEqual(["spent-together"]);
  });
  it("fires on four inputs to one output, with no change (838a60b0)", () => {
    expect(finding(checkPrivacy(recorded("838a60b0")), "spent-together")).toStrictEqual({
      kind: "spent-together",
      inputs: [0, 1, 2, 3],
      addresses: 1,
      allAddresses: true,
      noChange: true,
    });
  });
  it("fires on three inputs at three addresses (96ecc06d)", () => {
    expect(finding(checkPrivacy(recorded("96ecc06d")), "spent-together")).toMatchObject({
      addresses: 3,
      noChange: true,
    });
  });
  it("does not fire on one input to one output: the dropped self-transfer (b4a9233c)", () => {
    expect(kinds(checkPrivacy(recorded("b4a9233c")))).toStrictEqual([]);
  });
  it("does not fire on a CoinJoin, whose inputs have many owners", () => {
    expect(kinds(checkPrivacy(recorded("d84201d1")))).not.toContain("spent-together");
  });
});

describe("clean transactions", () => {
  it.each(["7e70bd69", "51969dc9", "a55e7fba"])("%s shows nothing", (prefix) => {
    const r = checkPrivacy(recorded(prefix));
    expect(r.findings).toStrictEqual([]);
    expect(r.notRun).toStrictEqual([]);
    expect(r.unreliable).toStrictEqual([]);
  });
});

describe("coinbase", () => {
  it("is not checked", () => {
    const cb: Transaction = {
      ...tx(
        [],
        [
          { value: 312_500_000, to: "pool" },
          { value: 312_500_000, to: "pool" },
        ],
      ),
      vin: [{ txid: "0".repeat(64), vout: 0xffffffff, is_coinbase: true }],
    };
    expect(checkPrivacy(cb)).toStrictEqual({
      coinbase: true,
      findings: [],
      unknownInputs: [],
      inputsMissing: false,
      notRun: [],
      unreliable: [],
      amountsValid: true,
    });
  });
});

describe("partly checked", () => {
  /** 2a0a2891 with its second input's previous output missing: `null` or not looked up. */
  const without = (prevout: null | undefined) => withInput(recorded("2a0a2891"), 1, prevout);
  it.each([
    ["the node does not have it", null],
    ["it was past the lookup limit", undefined],
  ] as const)(
    "an input whose previous output is unknown (%s) stops the checks that need it",
    (_, p) => {
      const r = checkPrivacy(without(p));
      expect(r.unknownInputs).toStrictEqual([1]);
      expect(r.notRun).toStrictEqual(["coinjoin", "payback", "script", "unneeded"]);
      // Round needs only the outputs, so it still runs, and says only what it saw.
      expect(reasons(r)).toStrictEqual(["round>0"]);
      expect(r.unreliable).toContain("change");
      expect(r.unreliable).toContain("reuse");
    },
  );
  it("no finding is made from a missing input", () => {
    // Reuse found among known inputs is real; nothing is said about the unknown one.
    const r = checkPrivacy(
      tx(
        [{ value: 50_000, to: "a" }, null, { value: 50_000, to: "a" }],
        [{ value: 30_000, to: "b" }],
      ),
    );
    expect(finding(r, "reuse")?.addresses).toStrictEqual([
      expect.objectContaining({ inputs: [0, 2], outputs: [] }),
    ]);
    // Only the inputs seen are counted: the unknown one may be an anchor (R2).
    expect(finding(r, "spent-together")).toMatchObject({ inputs: [0, 2], addresses: 1 });
    // One paying output can be no CoinJoin, so the unknown input cannot undo it (R9).
    expect(r.unreliable).toStrictEqual(["reuse"]);
  });
  it("a CoinJoin with an unknown input is not called one, nor ruled out", () => {
    const t = join(3, 100_000);
    const r = checkPrivacy(withInput(t, 0, null));
    expect(kinds(r)).not.toContain("coinjoin");
    expect(r.notRun).toContain("coinjoin");
    expect(r.unreliable).toContain("coinjoin");
  });
  it("a pruned transaction whose inputs all carry their previous outputs is checked in full (R3)", () => {
    // rbitcoin v0.9.2 marks a transaction pruned when its scripts and witnesses are gone; its
    // input list is then whole or absent, never partial.
    const r = checkPrivacy({ ...recorded("2a0a2891"), pruned: true });
    expect(r.inputsMissing).toBe(false);
    expect(r.notRun).toStrictEqual([]);
    expect(r.unreliable).toStrictEqual([]);
    expect(reasons(r)).toStrictEqual(["round>0", "script>0", "unneeded>0"]);
  });
  it("a transaction with no input list at all runs only what its outputs show", () => {
    const { vin: _, ...t } = recorded("cc0f8bc1");
    const r = checkPrivacy({ ...t, pruned: true });
    expect(r.inputsMissing).toBe(true);
    expect(r.notRun).toStrictEqual(["coinjoin", "payback", "script", "unneeded", "spent-together"]);
    expect(reasons(r)).toStrictEqual(["round>1"]);
  });
  it("a transaction listing no inputs runs only what its outputs show", () => {
    const t = recorded("cc0f8bc1");
    const r = checkPrivacy({ ...t, vin: [] });
    expect(r.inputsMissing).toBe(true);
    expect(r.notRun).toStrictEqual(["coinjoin", "payback", "script", "unneeded", "spent-together"]);
    expect(reasons(r)).toStrictEqual(["round>1"]);
  });
  it("a fully known transaction runs everything", () => {
    const r = checkPrivacy(recorded("2a0a2891"));
    expect(r.amountsValid).toBe(true);
    expect(r.notRun).toStrictEqual([]);
    expect(r.unreliable).toStrictEqual([]);
  });
});

describe("spent together with inputs it cannot see (R2)", () => {
  it.each([
    ["null", null],
    ["absent", undefined],
  ] as const)("one known input and one %s is not enough to say, so it does not run", (_, p) => {
    const r = checkPrivacy(tx([{ value: 50_000, to: "a" }, p], [{ value: 40_000, to: "b" }]));
    expect(kinds(r)).not.toContain("spent-together");
    expect(r.notRun).toContain("spent-together");
    expect(r.unreliable).toContain("spent-together");
  });
  it("an anchor and one ordinary input are not spent together", () => {
    const r = checkPrivacy(
      tx([ANCHOR_OUT, { value: 50_000, to: "a" }], [{ value: 40_000, to: "b" }]),
    );
    expect(kinds(r)).not.toContain("spent-together");
    expect(r.notRun).not.toContain("spent-together");
  });
  it("two known inputs beside an unknown one are reported, and only the known ones", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 50_000, to: "a" }, null, { value: 60_000, to: "c" }],
        [{ value: 40_000, to: "b" }],
      ),
    );
    expect(finding(r, "spent-together")).toMatchObject({ inputs: [0, 2], addresses: 2 });
    // One paying output can be no CoinJoin, so the unknown input cannot undo it (R9).
    expect(r.unreliable).toStrictEqual(["reuse"]);
  });
});

describe("unreliable names only what missing data could change (R9)", () => {
  it("is conservative: with an unknown input it may list kinds the data could not change", () => {
    // Three unequal outputs can be neither disputed nor a CoinJoin, yet both are listed. Listing
    // once too often is the safe side; never narrow this into omitting a kind data could change.
    const r = checkPrivacy(
      tx(
        [{ value: 400_000, to: "i0" }, { value: 300_000, to: "i1" }, null],
        [
          { value: 100_001, to: "a" },
          { value: 200_002, to: "b" },
          { value: 300_003, to: "c" },
        ],
      ),
    );
    expect(r.unreliable).toStrictEqual([
      "reuse",
      "change",
      "change-disputed",
      "coinjoin",
      "spent-together",
    ]);
  });
  it("two known pay-backs settle the change question, whatever the unknown input holds", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 800_000, to: "a" }, { value: 300_000, to: "b" }, null],
        [
          { value: 500_000, to: "a" },
          { value: 578_901, to: "b" },
        ],
      ),
    );
    expect(r.notRun).toStrictEqual(["coinjoin"]);
    expect(r.unreliable).toStrictEqual(["reuse"]);
  });
  it("two known pay-backs settle it beside an invalid amount, with every input known", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 800_000, to: "a" },
          { value: 300_000, to: "b" },
        ],
        [
          { value: -1, to: "a" },
          { value: 578_901, to: "b" },
        ],
      ),
    );
    expect(r.amountsValid).toBe(false);
    expect(r.notRun).toStrictEqual(["coinjoin"]);
    expect(r.unreliable).toStrictEqual([]);
  });
  it("an unknown input leaves change unreliable when no pay-back is known", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 800_000, to: "a" }, null],
        [
          { value: 500_000, to: "x" },
          { value: 278_901, to: "y" },
        ],
      ),
    );
    // Two paying outputs can never be a CoinJoin, so that is not unreliable.
    expect(r.unreliable).toStrictEqual(["reuse", "change", "change-disputed", "spent-together"]);
  });
});

describe("amounts that are not valid (R4, R8)", () => {
  const SUPPLY = 21_000_000 * 100_000_000;
  const AMOUNT_RULES = ["coinjoin", "round", "unneeded"];
  it("known inputs adding up to one sat over the supply stop the amount rules, beside an unknown input (R10)", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 1_050_000_000_000_000, to: "i0" },
          { value: 1_050_000_000_000_001, to: "i1" },
          null,
        ],
        [
          { value: 500_000, to: "a" },
          { value: 123_457, to: "b" },
        ],
      ),
    );
    expect(r.amountsValid).toBe(false);
    expect(reasons(r)).toStrictEqual([]);
    expect(r.notRun).toContain("round");
  });
  /** Three outputs whose values claim to be equal, from three senders, with one reused address. */
  const claimed = (values: number[]) =>
    tx(
      [
        { value: 100_000, to: "i0" },
        { value: 100_000, to: "i1" },
        { value: 100_000, to: "i2" },
      ],
      values.map((value, k) => ({ value, to: `o${k}` })),
    );
  it("2^53 and 2^53 + 1, read as one number, are no CoinJoin", () => {
    const r = checkPrivacy(claimed([2 ** 53, 2 ** 53 + 1, 2 ** 53]));
    expect(r.amountsValid).toBe(false);
    expect(kinds(r)).not.toContain("coinjoin");
    // Three outputs: round and unnecessary input do not apply, so only the CoinJoin is held back.
    expect(r.notRun).toStrictEqual(["coinjoin"]);
    expect(r.unreliable).toContain("coinjoin");
  });
  it.each([
    ["negative", -1],
    ["fractional", 123_456.5],
    ["not a number", Number.NaN],
    ["over 21 million BTC", 21_000_000 * 100_000_000 + 1],
  ])("a %s output is no ragged side of a round pair", (_, bad) => {
    const r = checkPrivacy(pair(500_000, bad));
    expect(r.amountsValid).toBe(false);
    expect(reasons(r)).toStrictEqual([]);
    expect(r.notRun).toStrictEqual(expect.arrayContaining(AMOUNT_RULES));
    expect(r.unreliable).toContain("change");
  });
  it("21 million BTC exactly, in and out, is valid", () => {
    // The outputs add up to the whole supply and the fee is zero.
    const r = checkPrivacy(pair(500_000, SUPPLY - 500_000, SUPPLY));
    expect(r.amountsValid).toBe(true);
    expect(r.notRun).toStrictEqual([]);
    expect(r.unreliable).toStrictEqual([]);
  });
  it("outputs adding up to one sat over the supply are no CoinJoin (R8)", () => {
    const r = checkPrivacy(
      claimed([700_000_000_000_001, 700_000_000_000_001, 700_000_000_000_001]),
    );
    expect(r.amountsValid).toBe(false);
    expect(kinds(r)).not.toContain("coinjoin");
    expect(r.notRun).toStrictEqual(["coinjoin"]);
    expect(r.unreliable).toContain("coinjoin");
  });
  it("a round pair over the supply gives no round reading, with an input unknown (R8)", () => {
    const r = checkPrivacy(
      tx(
        [null],
        [
          { value: 2_000_000_000_000_000, to: "a" },
          { value: 100_000_000_000_001, to: "b" },
        ],
      ),
    );
    expect(r.amountsValid).toBe(false);
    expect(reasons(r)).toStrictEqual([]);
    expect(r.notRun).toContain("round");
    expect(r.unreliable).toContain("change");
  });
  it("known inputs that do not cover the outputs are no CoinJoin (R8)", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 10_000, to: "i0" },
          { value: 10_000, to: "i1" },
          { value: 10_000, to: "i2" },
        ],
        [
          { value: 11_000, to: "o0" },
          { value: 11_000, to: "o1" },
          { value: 11_000, to: "o2" },
        ],
      ),
    );
    expect(r.amountsValid).toBe(false);
    expect(kinds(r)).not.toContain("coinjoin");
    expect(r.notRun).toStrictEqual(["coinjoin"]);
  });
  it("a transaction paying exactly what its inputs hold, fee zero, is valid (R8)", () => {
    const r = checkPrivacy(pair(500_000, 123_457, 623_457));
    expect(r.amountsValid).toBe(true);
    expect(r.notRun).toStrictEqual([]);
    expect(reasons(r)).toStrictEqual(["round>1"]);
  });
  it("a zero-value output is a valid amount", () => {
    const r = checkPrivacy(pair(500_000, 0, 600_000));
    expect(r.amountsValid).toBe(true);
    expect(r.notRun).toStrictEqual([]);
  });
  it("a bad input amount stops the amount rules too", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: -5, to: "i0" },
          { value: 1_000_001, to: "i1" },
        ],
        [
          { value: 100_001, to: "a" },
          { value: 300_001, to: "b" },
        ],
      ),
    );
    expect(r.amountsValid).toBe(false);
    expect(reasons(r)).toStrictEqual([]);
    expect(r.notRun).toStrictEqual(expect.arrayContaining(AMOUNT_RULES));
  });
  it("rules that read only addresses still run", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 50_000, to: "me" }],
        [
          { value: -7, to: "x" },
          { value: 40_000, to: "me" },
        ],
      ),
    );
    expect(r.amountsValid).toBe(false);
    expect(kinds(r)).toContain("reuse");
    expect(finding(r, "change")).toMatchObject({ change: 1 });
    expect(reasons(r)).toStrictEqual(["payback>1"]);
  });
});

describe("unnecessary input states an inequality, not a proof (R5)", () => {
  it("fires on 103,000 and 302,000 in, 100,001 and 300,001 out, though 302,000 alone pays 300,001", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 103_000, to: "i0" },
          { value: 302_000, to: "i1" },
        ],
        [
          { value: 100_001, to: "a" },
          { value: 300_001, to: "b" },
        ],
      ),
    );
    expect(finding(r, "change")?.readings[0]?.reason).toStrictEqual({
      kind: "unneeded",
      inputs: [0],
      value: 103_000,
      allAddresses: true,
    });
  });
});

/** The app's types leave Node out; the speed limits are asked for through the environment. */
declare const process: { env: Record<string, string | undefined> };
/**
 * The suite checks what the rules answer for three large shapes. How fast they answer is a time
 * budget, and a time budget runs on request (docs/CI.md "Rules for tests"): on a slow runner one
 * of these took 54 ms of processor time against a 4 ms norm, with nothing wrong in the code.
 * From `web/`: `PRIVACY_BENCH=1 bunx vitest run src/lib/privacy.test.ts`
 */
const BENCH = process.env["PRIVACY_BENCH"] === "1";

/** 5,000 equal outputs from 5,000 addresses: one group of every output. */
const allEqual = (): Transaction => join(5_000, 100_000, 5_000);
/** 5,000 outputs in 1,666 groups of three equal values: the most groups there can be to sort (R6). */
const manyGroups = (): Transaction =>
  tx(
    Array.from({ length: 5_000 }, (_, k) => ({ value: 10_000_000, to: `in${k}` })),
    Array.from({ length: 5_000 }, (_, k) => ({ value: 10_000 + Math.floor(k / 3), to: `out${k}` })),
  );
/** 5,000 inputs from one address to 5,000 outputs paying it back. */
const oneAddress = (): Transaction =>
  tx(
    Array.from({ length: 5_000 }, () => ({ value: 20_000, to: "same" })),
    Array.from({ length: 5_000 }, () => ({ value: 10_000, to: "same" })),
  );

describe("large transactions", () => {
  it("5,000 outputs, all equal, are one group", () => {
    const r = checkPrivacy(allEqual());
    expect(finding(r, "coinjoin")?.groups[0]?.outputs.length).toBe(5_000);
  });
  it("5,000 outputs in 1,666 groups of three equal values are every group (R6)", () => {
    const r = checkPrivacy(manyGroups());
    expect(finding(r, "coinjoin")?.groups).toHaveLength(1_666);
  });
  it("5,000 inputs from one address to 5,000 outputs paying it back are one reused address", () => {
    const r = checkPrivacy(oneAddress());
    expect(finding(r, "reuse")?.addresses[0]?.outputs.length).toBe(5_000);
  });
});

// Well under 50 ms of processor time each on a developer's machine (lib/cost.ts); a quadratic pass
// would take seconds.
describe.skipIf(!BENCH)("large transactions, their speed (on request)", () => {
  it.each([
    ["5,000 outputs, all equal", allEqual],
    ["5,000 outputs in 1,666 groups of three", manyGroups],
    ["5,000 inputs and outputs on one address", oneAddress],
  ])("%s are checked in under 50 ms", (_name, shape) => {
    const t = shape();
    const { ms } = cost(() => checkPrivacy(t));
    expect(ms).toBeLessThan(50);
  });
});
