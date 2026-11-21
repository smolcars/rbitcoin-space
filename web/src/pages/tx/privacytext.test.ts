// Every sentence the privacy check can say, exactly, from reports the real rules make
// (lib/privacy.ts) on transactions built here, and which cards get which marks.
import { describe, expect, it } from "vitest";
import type { ScriptType, Transaction, Vin, Vout } from "../../lib/esplora";
import { checkPrivacy, type PrivacyFinding, type PrivacyReport } from "../../lib/privacy";
import {
  btc,
  CHECKS,
  cardMarks,
  countTone,
  isPartial,
  LIMITS,
  listed,
  listedRefs,
  plain,
  type Said,
  sayCount,
  sayFinding,
  sayNothing,
  sayPartial,
  shownAddress,
  shownFindings,
  TITLE_MAX,
} from "./privacytext";
import { runs } from "./Privacy";

// ---- Transactions: each label is one address, a P2WPKH script unless a type is given. ----

interface Coin {
  value: number;
  to: string;
  type?: ScriptType;
  /** The address as the node names it, when the test needs a particular one. */
  address?: string;
}

const PREFIX: Partial<Record<ScriptType, string>> = {
  v0_p2wpkh: "0014",
  v0_p2wsh: "0020",
  v1_p2tr: "5120",
  p2sh: "a914",
};

function vout(c: Coin): Vout {
  const type = c.type ?? "v0_p2wpkh";
  const body = Array.from(c.to, (ch) => (ch.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(40, "0");
  return {
    scriptpubkey: `${PREFIX[type] ?? "00"}${body}`,
    scriptpubkey_asm: "",
    scriptpubkey_type: type,
    scriptpubkey_address: c.address ?? `bcrt1q${c.to}`,
    value: c.value,
  };
}

let parent = 0;
function vin(c: Coin | null | undefined): Vin {
  parent += 1;
  const outpoint = { txid: parent.toString(16).padStart(64, "0"), vout: 0, is_coinbase: false };
  if (c === undefined) return outpoint;
  return { ...outpoint, prevout: c === null ? null : vout(c) };
}

function tx(ins: (Coin | null | undefined)[], outs: Coin[]): Transaction {
  return {
    txid: "f".repeat(64),
    version: 2,
    locktime: 0,
    status: { confirmed: true },
    vin: ins.map((c) => vin(c)),
    vout: outs.map((c) => vout(c)),
  };
}

/** Pay to anchor: one fixed script anyone can spend, left out of every rule. */
const ANCHOR: Vout = {
  scriptpubkey: "51024e73",
  scriptpubkey_asm: "",
  scriptpubkey_type: "unknown",
  scriptpubkey_address: "bc1pfeessrawgf",
  value: 240,
};
/** `t` with an anchor input or output added. */
function anchored(t: Transaction, side: "in" | "out"): Transaction {
  return side === "in"
    ? { ...t, vin: [...(t.vin ?? []), { ...vin(undefined), prevout: ANCHOR }] }
    : { ...t, vout: [...t.vout, ANCHOR] };
}

/** The one finding of `kind` the rules made for `t`, as the page says it. */
function said(t: Transaction, kind: PrivacyFinding["kind"]): Said {
  const f = checkPrivacy(t).findings.find((x) => x.kind === kind);
  if (!f) throw new Error(`no ${kind} finding`);
  const s = sayFinding(f, checkPrivacy(t).findings);
  seen.push(s);
  return s;
}
/** Every finding said in this file, for the check on how its sentences split around numbers. */
const seen: Said[] = [];

/** A said finding as plain lines: title, body, then each reason after "• ". */
const lines = (s: Said) => [
  plain(s.title),
  ...s.body.map((b) => plain(b)),
  ...s.reasons.map((r) => `• ${plain(r)}`),
];

describe("amounts and lists in a sentence", () => {
  it("writes BTC without trailing zeros, whole bitcoins grouped", () => {
    expect(btc(5_000_000)).toBe("0.05 BTC");
    expect(btc(100_000_000)).toBe("1 BTC");
    expect(btc(123_456_789_012)).toBe("1 234.56789012 BTC");
  });
  it("lists up to five indexes by number, and counts more", () => {
    expect(listed("input", [3])).toBe("input 3");
    expect(listed("output", [4, 0, 1])).toBe("outputs 0, 1 and 4");
    expect(listed("input", [0, 1, 2, 3, 4])).toBe("inputs 0, 1, 2, 3 and 4");
    expect(listed("input", [0, 1, 2, 3, 4, 5])).toBe("6 inputs");
  });
});

describe("address reuse", () => {
  it("an output paying an input's address back", () => {
    const t = tx(
      [{ value: 100_000, to: "me" }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "me" },
      ],
    );
    expect(lines(said(t, "reuse"))).toStrictEqual([
      "Address reused",
      "Input 0 spends from bcrt1qme and output 1 pays it too: an observer may read them as one owner's.",
    ]);
  });
  it("several inputs and outputs on one address", () => {
    const t = tx(
      [
        { value: 100_000, to: "me" },
        { value: 100_000, to: "me" },
      ],
      [
        { value: 30_001, to: "me" },
        { value: 60_001, to: "me" },
      ],
    );
    expect(lines(said(t, "reuse"))).toStrictEqual([
      "Address reused",
      "Inputs 0 and 1 spend from bcrt1qme and outputs 0 and 1 pay it too: an observer may read them as one owner's.",
    ]);
  });
  it("inputs only", () => {
    const t = tx(
      [
        { value: 100_000, to: "me" },
        { value: 100_000, to: "me" },
        { value: 100_000, to: "me" },
      ],
      [{ value: 290_000, to: "you" }],
    );
    expect(lines(said(t, "reuse"))).toStrictEqual([
      "Address reused",
      "Inputs 0, 1 and 2 all spend from bcrt1qme: an observer may read them as one owner's, with anything else paid to it.",
    ]);
  });
  it("outputs only", () => {
    const t = tx(
      [{ value: 100_000, to: "me" }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "you" },
      ],
    );
    expect(lines(said(t, "reuse"))).toStrictEqual([
      "Address reused",
      "Outputs 0 and 1 both pay bcrt1qyou: an observer may read them as one owner's.",
    ]);
  });
  it("a reused script with no address is called a locking script (U18)", () => {
    const script = `5121${"02".repeat(33)}51ae`;
    const t = tx(
      [{ value: 100_000, to: "me" }],
      [
        { value: 30_001, to: "ms", type: "multisig", address: script },
        { value: 60_001, to: "ms", type: "multisig", address: script },
      ],
    );
    // No address: the rules name it by its script's hex.
    const noAddress: Transaction = { ...t, vout: [] };
    for (const o of t.vout) {
      const { scriptpubkey_address: _, ...rest } = o;
      noAddress.vout.push({ ...rest, scriptpubkey: script });
    }
    const s = said(noAddress, "reuse");
    expect(lines(s)).toStrictEqual([
      "Locking script reused",
      `Outputs 0 and 1 both pay the locking script ${script.slice(0, 8)}…${script.slice(-8)}: an observer may read them as one owner's.`,
    ]);
    expect(cardMarks(checkPrivacy(noAddress).findings).get("out:0")).toStrictEqual([
      { text: "Reused script", short: "Reused", tone: "caution", kind: "reuse" },
    ]);
  });
  it("an address all in lower-case hex is still an address, as the rules say (U18)", () => {
    const hexLike = "1646e6df533667199e41221ee21315b14f";
    const t = tx(
      [{ value: 100_000, to: "me", address: hexLike }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "me", address: hexLike },
      ],
    );
    const s = said(t, "reuse");
    expect(plain(s.title)).toBe("Address reused");
    // Said as an address, never as a bare locking script.
    expect(plain(s.body[0] ?? [])).toMatch(/pays it too/);
    expect(plain(s.body[0] ?? [])).not.toMatch(/locking script/);
    expect(plain(said(t, "change").body[0] ?? [])).toBe(
      "Suggested by one reading, which is not proof: it pays the reused address.",
    );
  });
  it("two empty locking scripts are a locking script, not an address (U18)", () => {
    const t = tx(
      [{ value: 100_000, to: "me" }],
      [
        { value: 30_001, to: "e" },
        { value: 60_001, to: "e" },
      ],
    );
    const empty: Transaction = { ...t, vout: [] };
    for (const o of t.vout) {
      const { scriptpubkey_address: _, ...rest } = o;
      empty.vout.push({ ...rest, scriptpubkey: "", scriptpubkey_type: "unknown" });
    }
    expect(plain(said(empty, "reuse").title)).toBe("Locking script reused");
  });
  it("a pay-back to a P2PK output says the same locking script (U18)", () => {
    const key = `21${"02".repeat(33)}ac`;
    const t = tx(
      [{ value: 100_000, to: "me" }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "me" },
      ],
    );
    const p2pk = (v: Vout): Vout => {
      const { scriptpubkey_address: _, ...rest } = v;
      return { ...rest, scriptpubkey: key, scriptpubkey_type: "p2pk" };
    };
    const back: Transaction = { ...t, vin: [], vout: [] };
    for (const i of t.vin ?? []) back.vin?.push(i.prevout ? { ...i, prevout: p2pk(i.prevout) } : i);
    const [pay, change] = t.vout;
    if (pay && change) back.vout.push(pay, p2pk(change));
    expect(plain(said(back, "change").reasons[0] ?? [])).toBe(
      "It pays the same locking script input 0 spends from.",
    );
  });
  it("says three addresses and counts the rest", () => {
    const outs = ["a", "b", "c", "d", "e"].flatMap((to) => [
      { value: 10_001, to },
      { value: 10_002, to },
    ]);
    const s = said(tx([{ value: 1_000_000, to: "me" }], outs), "reuse");
    expect(plain(s.title)).toBe("5 addresses reused");
    expect(s.body).toHaveLength(4);
    expect(plain(s.body[3] ?? [])).toBe("2 more addresses appear more than once.");
  });
  it("counts many inputs instead of listing them", () => {
    const ins = Array.from({ length: 65 }, () => ({ value: 10_000, to: "me" }));
    expect(plain(said(tx(ins, [{ value: 600_000, to: "you" }]), "reuse").body[0] ?? [])).toBe(
      "65 inputs all spend from bcrt1qme: an observer may read them as one owner's, with anything else paid to it.",
    );
  });
});

describe("which output is change", () => {
  it("pay-back alone, with two outputs", () => {
    const t = tx(
      [{ value: 100_000, to: "me" }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "me" },
      ],
    );
    // The reuse finding beside it already names the address: the change finding points at it.
    expect(lines(said(t, "change"))).toStrictEqual([
      "Output 1 reads as change, output 0 as the payment",
      "Suggested by one reading, which is not proof: it pays the reused address.",
    ]);
    // Said alone, it says the whole reading.
    const f = checkPrivacy(t).findings.find((x) => x.kind === "change");
    expect(f && lines(sayFinding(f))).toStrictEqual([
      "Output 1 reads as change, output 0 as the payment",
      "Suggested by one reading, which is not proof:",
      "• It pays the same address input 0 spends from.",
    ]);
  });
  it("pay-back beside a second reused address: the reading is said whole", () => {
    const t = tx(
      [
        { value: 100_000, to: "me" },
        { value: 100_000, to: "them" },
      ],
      [
        { value: 30_001, to: "you" },
        { value: 40_001, to: "you" },
        { value: 60_001, to: "me" },
      ],
    );
    expect(said(t, "reuse").body).toHaveLength(2);
    expect(lines(said(t, "change")).slice(1)).not.toContain(
      "Suggested by one reading, which is not proof: it pays the reused address.",
    );
  });
  it("pay-back from several inputs, beside more than one other output: no payment named", () => {
    const t = tx(
      [
        { value: 100_000, to: "me" },
        { value: 100_000, to: "me" },
      ],
      [
        { value: 30_001, to: "you" },
        { value: 40_001, to: "them" },
        { value: 60_001, to: "me" },
      ],
    );
    expect(lines(said(t, "change"))).toStrictEqual([
      "Output 2 reads as change",
      "Suggested by one reading, which is not proof: it pays the reused address.",
    ]);
  });
  it("round amount", () => {
    const t = tx(
      [{ value: 10_000_000, to: "me" }],
      [
        { value: 5_000_000, to: "you" },
        { value: 4_987_654, to: "new" },
      ],
    );
    expect(lines(said(t, "change"))).toStrictEqual([
      "Output 1 reads as change, output 0 as the payment",
      "Suggested by one reading, which is not proof:",
      "• Output 0 is a round 0.05 BTC and this one is not.",
    ]);
  });
  it("script type", () => {
    const t = tx(
      [{ value: 10_000_000, to: "me", type: "v1_p2tr" }],
      [
        { value: 4_123_457, to: "you" },
        { value: 5_865_432, to: "new", type: "v1_p2tr" },
      ],
    );
    expect(lines(said(t, "change"))).toStrictEqual([
      "Output 1 reads as change, output 0 as the payment",
      "Suggested by one reading, which is not proof:",
      "• Every input that funds it is P2TR, and of the two outputs checked only this one is.",
    ]);
  });
  it("the smallest coin, one input: states the comparison and nothing more", () => {
    const t = tx(
      [
        { value: 103_000, to: "i0" },
        { value: 302_000, to: "i1" },
      ],
      [
        { value: 100_001, to: "a" },
        { value: 300_001, to: "b" },
      ],
    );
    const s = said(t, "change");
    expect(lines(s)).toStrictEqual([
      "Output 0 reads as change, output 1 as the payment",
      "Suggested by one reading, which is not proof:",
      "• It is less than 0.00103 BTC, the least spent from any one funding address (input 0), and the other output checked is not.",
    ]);
    // Input 1 alone would pay output 1: the words must never say it could not.
    expect(lines(s).join(" ")).not.toMatch(/could not|couldn't|needed every/);
  });
  it("the smallest coin, one address's inputs together", () => {
    const t = tx(
      [
        { value: 150_001, to: "a" },
        { value: 900_001, to: "a" },
        { value: 400_003, to: "b" },
      ],
      [
        { value: 100_001, to: "x" },
        { value: 1_349_003, to: "y" },
      ],
    );
    expect(plain(said(t, "change").reasons[0] ?? [])).toBe(
      "It is less than 0.00400003 BTC, the least spent from any one funding address (input 2), and the other output checked is not.",
    );
    // Input 0 is the smaller coin, but its address spends more in all: never "the smallest coin".
    expect(plain(said(t, "change").reasons[0] ?? [])).not.toMatch(/smallest/);
    const one = tx(
      [
        { value: 150_001, to: "a" },
        { value: 250_001, to: "a" },
        { value: 900_003, to: "b" },
      ],
      [
        { value: 100_001, to: "x" },
        { value: 1_199_003, to: "y" },
      ],
    );
    expect(plain(said(one, "change").reasons[0] ?? [])).toBe(
      "It is less than 0.00400002 BTC, the least spent from any one funding address (inputs 0 and 1), and the other output checked is not.",
    );
  });
  it("two readings agreeing: neither of them proof", () => {
    const t = tx(
      [{ value: 10_000_000, to: "me" }],
      [
        { value: 5_000_000, to: "you" },
        { value: 4_987_654, to: "me" },
      ],
    );
    expect(lines(said(t, "change"))).toStrictEqual([
      "Output 1 reads as change, output 0 as the payment",
      "Suggested by two readings, neither of them proof:",
      "• It pays the same address input 0 spends from.",
      "• Output 0 is a round 0.05 BTC and this one is not.",
    ]);
  });
  it("script type with an anchor output beside: counts the two outputs that are paid (U13)", () => {
    const t = tx(
      [{ value: 10_000_000, to: "me", type: "v1_p2tr" }],
      [
        { value: 4_123_457, to: "you" },
        { value: 5_865_432, to: "new", type: "v1_p2tr" },
      ],
    );
    const three = anchored(t, "out");
    expect(three.vout).toHaveLength(3);
    expect(plain(said(three, "change").reasons[0] ?? [])).toBe(
      "Every input that funds it is P2TR, and of the two outputs checked only this one is.",
    );
  });
  it("script type with an anchor input beside: says the inputs that fund it", () => {
    const t = tx(
      [{ value: 10_000_000, to: "me", type: "v1_p2tr" }],
      [
        { value: 4_123_457, to: "you" },
        { value: 5_865_432, to: "new", type: "v1_p2tr" },
      ],
    );
    expect(plain(said(anchored(t, "in"), "change").reasons[0] ?? [])).toBe(
      "Every input that funds it is P2TR, and of the two outputs checked only this one is.",
    );
  });
  it("several readings agreeing are each a reason", () => {
    const t = tx(
      [{ value: 10_000_000, to: "me", type: "v1_p2tr" }],
      [
        { value: 5_000_000, to: "you" },
        { value: 4_987_654, to: "me", type: "v1_p2tr" },
      ],
    );
    expect(lines(said(t, "change"))).toStrictEqual([
      "Output 1 reads as change, output 0 as the payment",
      "Suggested by three readings, none of them proof:",
      "• It pays the same address input 0 spends from.",
      "• Output 0 is a round 0.05 BTC and this one is not.",
      "• Every input that funds it is P2TR, and of the two outputs checked only this one is.",
    ]);
  });
  it("disputed: each reading its direction, then its comparison; no output named as change", () => {
    // Output 0 is round, so the round reading points at 1; only 0 is of the inputs' type.
    const t = tx(
      [{ value: 10_000_000, to: "me", type: "v1_p2tr" }],
      [
        { value: 5_000_000, to: "you", type: "v1_p2tr" },
        { value: 4_987_654, to: "new" },
      ],
    );
    const s = said(t, "change-disputed");
    expect(lines(s)).toStrictEqual([
      "No output clearly reads as change",
      "These two readings disagree:",
      "• Payment: output 0 is a round 0.05 BTC, and output 1 is not.",
      "• Change: of the two outputs checked only output 0 is P2TR, as is every input that funds it.",
    ]);
    expect(lines(s).join(" ")).not.toMatch(/reads as change,|is the payment|is change/);
  });
  it("four readings agreeing", () => {
    const t = tx(
      [
        { value: 150_003, to: "a" },
        { value: 4_990_003, to: "b" },
      ],
      [
        { value: 5_000_000, to: "x", type: "v1_p2tr" },
        { value: 100_001, to: "a" },
      ],
    );
    expect(lines(said(t, "change"))).toStrictEqual([
      "Output 1 reads as change, output 0 as the payment",
      "Suggested by four readings, none of them proof:",
      "• It pays the same address input 0 spends from.",
      "• Output 0 is a round 0.05 BTC and this one is not.",
      "• Every input that funds it is P2WPKH, and of the two outputs checked only this one is.",
      "• It is less than 0.00150003 BTC, the least spent from any one funding address (input 0), and the other output checked is not.",
    ]);
  });
  it("disputed by three readings", () => {
    const t = tx(
      [
        { value: 150_003, to: "a" },
        { value: 4_990_003, to: "b" },
      ],
      [
        { value: 5_000_000, to: "x" },
        { value: 100_001, to: "y", type: "v1_p2tr" },
      ],
    );
    expect(lines(said(t, "change-disputed"))).toStrictEqual([
      "No output clearly reads as change",
      "These readings disagree:",
      "• Payment: output 0 is a round 0.05 BTC, and output 1 is not.",
      "• Change: of the two outputs checked only output 0 is P2WPKH, as is every input that funds it.",
      "• Change: output 1 is less than 0.00150003 BTC, the least spent from any one funding address (input 0), and the other output checked is not.",
    ]);
  });
  it("disputed with the smallest coin, as a fact", () => {
    const t = tx(
      [
        { value: 1_699_450, to: "i0", type: "v0_p2wsh" },
        { value: 1_865_846, to: "i1", type: "v0_p2wsh" },
      ],
      [
        { value: 1_007_540, to: "a", type: "p2sh" },
        { value: 2_556_142, to: "b", type: "v0_p2wsh" },
      ],
    );
    expect(lines(said(t, "change-disputed"))).toStrictEqual([
      "No output clearly reads as change",
      "These two readings disagree:",
      "• Change: of the two outputs checked only output 1 is P2WSH, as is every input that funds it.",
      "• Change: output 0 is less than 0.0169945 BTC, the least spent from any one funding address (input 0), and the other output checked is not.",
    ]);
  });
});

describe("a CoinJoin's shape", () => {
  const ins = (n: number) =>
    Array.from({ length: n }, (_, k) => ({ value: 2_000_000, to: `i${k}` }));
  it("one group of equal outputs", () => {
    const outs = [0, 1, 2].map((k) => ({ value: 1_000_000, to: `o${k}` }));
    expect(lines(said(tx(ins(3), outs), "coinjoin"))).toStrictEqual([
      "Shaped like a CoinJoin",
      "Outputs 0, 1 and 2 each pay exactly 0.01 BTC to a different address, and the inputs that fund it spend from 3 different addresses.",
      "Their amounts alone do not tell an observer which is whose. It may be a CoinJoin; the shape alone does not prove it.",
    ]);
  });
  it("several groups", () => {
    const outs = [
      ...[0, 1, 2, 3].map((k) => ({ value: 1_000_000, to: `a${k}` })),
      ...[0, 1, 2].map((k) => ({ value: 50_000, to: `b${k}` })),
    ];
    expect(plain(said(tx(ins(7), outs), "coinjoin").body[0] ?? [])).toBe(
      "7 outputs fall into 2 groups of equal amounts, the largest 4 of 0.01 BTC. Within each group every output pays a different address, and the inputs that fund it spend from 7 different addresses.",
    );
  });
  it("counts the inputs that fund it, not an anchor beside them", () => {
    const outs = [0, 1, 2].map((k) => ({ value: 1_000_000, to: `o${k}` }));
    expect(plain(said(anchored(tx(ins(3), outs), "in"), "coinjoin").body[0] ?? [])).toBe(
      "Outputs 0, 1 and 2 each pay exactly 0.01 BTC to a different address, and the inputs that fund it spend from 3 different addresses.",
    );
  });
  it("is neutral, not a caution", () => {
    const outs = [0, 1, 2].map((k) => ({ value: 1_000_000, to: `o${k}` }));
    expect(said(tx(ins(3), outs), "coinjoin").tone).toBe("neutral");
  });
});

describe("coins spent together (before sending)", () => {
  it("from several addresses, with change", () => {
    const t = tx(
      [
        { value: 100_000, to: "a" },
        { value: 100_000, to: "b" },
      ],
      [
        { value: 50_001, to: "x" },
        { value: 140_001, to: "y" },
      ],
    );
    expect(lines(said(t, "spent-together"))).toStrictEqual([
      "Coins spent together",
      "Inputs 0 and 1 are spent together, from 2 different addresses: an observer may read them as one owner's.",
    ]);
  });
  it("from one address, to one output", () => {
    const t = tx(
      [
        { value: 100_000, to: "a" },
        { value: 100_000, to: "a" },
        { value: 100_000, to: "a" },
      ],
      [{ value: 290_000, to: "x" }],
    );
    expect(lines(said(t, "spent-together"))).toStrictEqual([
      "Coins spent together",
      "Inputs 0, 1 and 2 are spent together, all from one address: an observer may read them as one owner's.",
      "Only one output is paid, other than data or a fee anchor, so nothing in it reads as change.",
    ]);
  });
  it("one paid output beside an anchor: says only that one output is paid", () => {
    const t = tx(
      [
        { value: 100_000, to: "a" },
        { value: 100_000, to: "b" },
      ],
      [{ value: 190_000, to: "x" }],
    );
    expect(lines(said(anchored(t, "out"), "spent-together"))).toStrictEqual([
      "Coins spent together",
      "Inputs 0 and 1 are spent together, from 2 different addresses: an observer may read them as one owner's.",
      "Only one output is paid, other than data or a fee anchor, so nothing in it reads as change.",
    ]);
  });
  it("is not shown on the transaction page", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 100_000, to: "a" },
          { value: 100_000, to: "b" },
        ],
        [{ value: 190_000, to: "x" }],
      ),
    );
    expect(r.findings.map((f) => f.kind)).toStrictEqual(["spent-together"]);
    expect(shownFindings(r, false)).toStrictEqual([]);
    expect(shownFindings(r, true)).toHaveLength(1);
  });
});

describe("when only part could be checked", () => {
  const partial = (r: PrivacyReport, unsent = false) => sayPartial(r, unsent).map((s) => plain(s));
  const SUPPLY = 21_000_000 * 100_000_000;
  const HEAD = "Only part of this transaction could be checked.";
  it("says nothing when everything was checked", () => {
    const r = checkPrivacy(tx([{ value: 100_000, to: "a" }], [{ value: 90_000, to: "b" }]));
    expect(isPartial(r)).toBe(false);
    expect(partial(r)).toStrictEqual([]);
    expect(sayNothing(false)).toBe("Nothing in this transaction's shape stands out.");
  });
  it("one unknown input, two outputs: what it held back, on each page", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 800_000, to: "a" }, null],
        [
          { value: 500_001, to: "x" },
          { value: 278_901, to: "y" },
        ],
      ),
    );
    expect(partial(r)).toStrictEqual([
      HEAD,
      "What input 1 spends is not known here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one funding address.",
      "What it shows about address reuse and which output is change may be incomplete.",
    ]);
    expect(partial(r, true)).toStrictEqual([
      HEAD,
      "What input 1 spends is not known here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types, the least spent from one funding address and coins spent together.",
      "What it shows about address reuse, which output is change and coins spent together may be incomplete.",
    ]);
  });
  it("one input past the lookup limit, three outputs", () => {
    const ins = [
      ...Array.from({ length: 100 }, (_, k) => ({ value: 10_000, to: `i${k}` })),
      undefined,
    ];
    const r = checkPrivacy(
      tx(ins, [
        { value: 100_001, to: "x" },
        { value: 200_002, to: "y" },
        { value: 300_003, to: "z" },
      ]),
    );
    expect(partial(r)).toStrictEqual([
      HEAD,
      "What input 100 spends is not known here, so these were not checked: the CoinJoin shape and outputs paying back to an input's address.",
      "What it shows about address reuse, which output is change and the CoinJoin shape may be incomplete.",
    ]);
  });
  it("many unknown inputs are counted", () => {
    const many = checkPrivacy(tx([null, null, null, null, null, null], [{ value: 1, to: "x" }]));
    expect(partial(many)[1]).toBe(
      "What 6 inputs spend is not known here, so these were not checked: the CoinJoin shape and outputs paying back to an input's address.",
    );
  });
  it("no inputs listed", () => {
    const t = tx(
      [],
      [
        { value: 5_000_000, to: "x" },
        { value: 4_987_654, to: "y" },
      ],
    );
    expect(partial(checkPrivacy({ ...t, pruned: true }))).toStrictEqual([
      HEAD,
      "Its inputs are not listed here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one funding address.",
      "What it shows about address reuse and which output is change may be incomplete.",
    ]);
  });
  it("amounts that cannot be right, every input known", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 10_000, to: "a" }],
        [
          { value: 500_000, to: "x" },
          { value: 123_457, to: "y" },
        ],
      ),
    );
    expect(partial(r)).toStrictEqual([
      HEAD,
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so these were not checked: the CoinJoin shape, round amounts and the least spent from one funding address.",
      "What it shows about which output is change may be incomplete.",
    ]);
  });
  it("an unknown input and amounts that cannot be right: each cause with what it held back", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 800_000, to: "a" }, null],
        [
          { value: SUPPLY, to: "x" },
          { value: 123_457, to: "y" },
        ],
      ),
    );
    expect(partial(r)).toStrictEqual([
      HEAD,
      "What input 1 spends is not known here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one funding address.",
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so these were not checked: the CoinJoin shape, round amounts and the least spent from one funding address.",
      "What it shows about address reuse and which output is change may be incomplete.",
    ]);
  });
  it("no inputs listed and amounts that cannot be right", () => {
    const t = tx(
      [],
      [
        { value: SUPPLY, to: "x" },
        { value: 123_457, to: "y" },
      ],
    );
    expect(partial(checkPrivacy({ ...t, pruned: true }))).toStrictEqual([
      HEAD,
      "Its inputs are not listed here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one funding address.",
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so these were not checked: the CoinJoin shape, round amounts and the least spent from one funding address.",
      "What it shows about address reuse and which output is change may be incomplete.",
    ]);
  });
  it("amounts that cannot be right beside three outputs, every input known", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 10_000, to: "a" },
          { value: 10_000, to: "b" },
          { value: 10_000, to: "c" },
        ],
        [
          { value: 11_000, to: "x" },
          { value: 11_000, to: "y" },
          { value: 11_000, to: "z" },
        ],
      ),
    );
    expect(partial(r)).toStrictEqual([
      HEAD,
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so this was not checked: the CoinJoin shape.",
      "What it shows about the CoinJoin shape may be incomplete.",
    ]);
  });
  it("an unknown input and one output over the supply: amounts named, from the report (U12)", () => {
    const r = checkPrivacy(
      tx([{ value: 800_000, to: "a" }, null], [{ value: SUPPLY + 1, to: "x" }]),
    );
    expect(r.amountsValid).toBe(false);
    expect(partial(r)).toStrictEqual([
      HEAD,
      "What input 1 spends is not known here, so these were not checked: the CoinJoin shape and outputs paying back to an input's address.",
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so this was not checked: the CoinJoin shape.",
      "What it shows about address reuse may be incomplete.",
    ]);
    // The same with an amount that can be right says nothing about amounts.
    const fine = checkPrivacy(
      tx([{ value: 800_000, to: "a" }, null], [{ value: 100_000, to: "x" }]),
    );
    expect(partial(fine).join(" ")).not.toMatch(/amounts/);
  });
  it("three paying outputs with an unknown input and a bad amount: amounts named (U12)", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 800_000, to: "a" }, null],
        [
          { value: -1, to: "x" },
          { value: 200_002, to: "y" },
          { value: 300_003, to: "z" },
        ],
      ),
    );
    expect(partial(r)).toContain(
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so this was not checked: the CoinJoin shape.",
    );
  });
  it("never says nothing stands out when only part was checked", () => {
    expect(sayNothing(true)).toBe("Nothing was found in the part that could be checked.");
    expect(sayNothing(true)).not.toMatch(/stands out/);
  });
});

describe("hostile addresses", () => {
  const HOSTILE = '<img src=x onerror="alert(1)">\u202Egnp.exe';
  it("stay one piece of the sentence, never markup or wording", () => {
    const t = tx(
      [{ value: 100_000, to: "me", address: HOSTILE }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "me", address: HOSTILE },
      ],
    );
    const sentence = said(t, "reuse").body[0] ?? [];
    expect(sentence.filter((p) => typeof p !== "string")).toStrictEqual([
      { ref: "in", index: 0 },
      { address: HOSTILE },
      { ref: "out", index: 1 },
    ]);
    // The text around it is ours alone.
    expect(sentence.filter((p) => typeof p === "string").join("")).not.toMatch(/[<>]/);
    // Shown with its bidi override made visible, cut to eight and eight.
    expect(plain(sentence)).toBe(
      "Input 0 spends from <img src…\uFFFDgnp.exe and output 1 pays it too: an observer may read them as one owner's.",
    );
  });
  it("hidden and reordering characters are made visible, in the short form and the title", () => {
    const hidden = "bc1q\u200Bab\u202Ecd\u2066ef\u0007gh\u2028ij\uE000kl";
    const shown = shownAddress(hidden);
    expect(shown.title).toBe("bc1q\\u{200B}ab\\u{202E}cd\\u{2066}ef\\u{7}gh\\u{2028}ij\\u{E000}kl");
    expect(shown.short).toBe("bc1q\uFFFDab\uFFFD…gh\uFFFDij\uFFFDkl");
    const kept = ["\u200B", "\u202E", "\u2066", "\u0007", "\u2028", "\uE000"].filter((c) =>
      `${shown.short}${shown.title}`.includes(c),
    );
    expect(kept).toStrictEqual([]);
  });
  it("two strings with different hidden characters never share a title (U16)", () => {
    const a = shownAddress("bc1q\u202Eabc");
    const b = shownAddress("bc1q\u200Babc");
    expect(a.short).toBe(b.short);
    expect(a.title).toBe("bc1q\\u{202E}abc");
    expect(b.title).toBe("bc1q\\u{200B}abc");
    // A backslash is escaped too, so the escapes cannot be typed in.
    expect(shownAddress("bc1q\\u{202E}abc").title).toBe("bc1q\\\\u{202E}abc");
  });
  it("a title is cut past 128 characters; a short address is shown whole", () => {
    const long = shownAddress("a".repeat(500));
    expect(long.title).toBe(`${"a".repeat(TITLE_MAX)}…`);
    expect(long.short).toBe("aaaaaaaa…aaaaaaaa");
    expect(shownAddress("bcrt1qme")).toStrictEqual({
      short: "bcrt1qme",
      title: "bcrt1qme",
      cut: 0,
    });
  });
});

describe("marks on the cards", () => {
  it("reuse marks every input and output on the address; change marks change and payment", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 100_000, to: "me" }],
        [
          { value: 30_001, to: "you" },
          { value: 60_001, to: "me" },
        ],
      ),
    );
    expect(Object.fromEntries(cardMarks(r.findings))).toStrictEqual({
      "in:0": [{ text: "Reused address", short: "Reused", tone: "caution", kind: "reuse" }],
      "out:1": [
        { text: "Reused address", short: "Reused", tone: "caution", kind: "reuse" },
        { text: "Reads as change", short: "Change", tone: "caution", kind: "change" },
      ],
      "out:0": [{ text: "Reads as payment", short: "Payment", tone: "caution", kind: "change" }],
    });
  });
  it("no payment mark when more than two outputs are paid", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 200_000, to: "me" }],
        [
          { value: 30_001, to: "you" },
          { value: 40_001, to: "them" },
          { value: 60_001, to: "me" },
        ],
      ),
    );
    const marks = cardMarks(r.findings);
    expect(marks.get("out:2")?.map((m) => m.text)).toStrictEqual([
      "Reused address",
      "Reads as change",
    ]);
    expect(marks.has("out:0")).toBe(false);
    expect(marks.has("out:1")).toBe(false);
  });
  it("a disputed reading marks no card", () => {
    const r = checkPrivacy(
      tx(
        [{ value: 10_000_000, to: "me", type: "v1_p2tr" }],
        [
          { value: 5_000_000, to: "you", type: "v1_p2tr" },
          { value: 4_987_654, to: "new" },
        ],
      ),
    );
    expect(r.findings.map((f) => f.kind)).toStrictEqual(["change-disputed"]);
    expect(cardMarks(r.findings).size).toBe(0);
  });
  it("a CoinJoin marks its equal outputs, neutral", () => {
    const ins = [0, 1, 2, 3].map((k) => ({ value: 2_000_000, to: `i${k}` }));
    const r = checkPrivacy(
      tx(ins, [
        { value: 1_000_000, to: "o0" },
        { value: 1_000_000, to: "o1" },
        { value: 1_000_000, to: "o2" },
        { value: 4_987_654, to: "o3" },
      ]),
    );
    expect(Object.fromEntries(cardMarks(r.findings))).toStrictEqual({
      "out:0": [{ text: "Equal amount", short: "Equal", tone: "neutral", kind: "coinjoin" }],
      "out:1": [{ text: "Equal amount", short: "Equal", tone: "neutral", kind: "coinjoin" }],
      "out:2": [{ text: "Equal amount", short: "Equal", tone: "neutral", kind: "coinjoin" }],
    });
  });
  it("coins spent together mark no card", () => {
    const r = checkPrivacy(
      tx(
        [
          { value: 100_000, to: "a" },
          { value: 100_000, to: "b" },
        ],
        [{ value: 190_000, to: "x" }],
      ),
    );
    expect(cardMarks(shownFindings(r, true)).size).toBe(0);
  });
});

describe("the summary's line on a narrow screen", () => {
  const payback = tx(
    [{ value: 100_000, to: "me" }],
    [
      { value: 30_001, to: "you" },
      { value: 60_001, to: "me" },
    ],
  );
  it("counts the findings the page shows", () => {
    expect(sayCount(checkPrivacy(payback))).toBe("2 things an observer can read");
  });
  it("says nothing for nothing to report, and says a partial check either way", () => {
    const clean = tx([{ value: 100_000, to: "me" }], [{ value: 90_000, to: "you" }]);
    expect(sayCount(checkPrivacy(clean))).toBeNull();
    const part = (t: Transaction): Transaction => ({
      ...t,
      vin: (t.vin ?? []).map((i) => Object.assign(structuredClone(i), { prevout: null })),
    });
    expect(sayCount(checkPrivacy(part(clean)))).toBe(
      "What an observer can read: only partly checked",
    );
    const twice = tx(
      [{ value: 100_000, to: "me" }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "you" },
      ],
    );
    expect(sayCount(checkPrivacy(part(twice)))).toBe(
      "1 thing an observer can read, only partly checked",
    );
  });
  it("takes the caution colour only when something is given away", () => {
    expect(countTone(checkPrivacy(payback))).toBe("caution");
    const ins = [0, 1, 2, 3].map((k) => ({ value: 2_000_000, to: `i${k}` }));
    const join = tx(ins, [
      { value: 1_000_000, to: "o0" },
      { value: 1_000_000, to: "o1" },
      { value: 1_000_000, to: "o2" },
      { value: 4_987_654, to: "o3" },
    ]);
    expect(checkPrivacy(join).findings.map((f) => f.kind)).toStrictEqual(["coinjoin"]);
    expect(countTone(checkPrivacy(join))).toBe("neutral");
  });
  it("never counts what is shown only before sending", () => {
    const together = tx(
      [
        { value: 100_000, to: "a" },
        { value: 100_000, to: "b" },
      ],
      [{ value: 190_000, to: "x" }],
    );
    expect(checkPrivacy(together).findings.map((f) => f.kind)).toStrictEqual(["spent-together"]);
    expect(sayCount(checkPrivacy(together))).toBeNull();
  });
});

describe("numbers in a sentence", () => {
  it("are each a link to its card, and a count links nothing", () => {
    expect(listedRefs("input", [4, 0, 3])).toStrictEqual([
      "inputs ",
      { ref: "in", index: 0 },
      ", ",
      { ref: "in", index: 3 },
      " and ",
      { ref: "in", index: 4 },
    ]);
    expect(listedRefs("output", [2])).toStrictEqual(["output ", { ref: "out", index: 2 }]);
    expect(listedRefs("input", [0, 1, 2, 3, 4, 5])).toStrictEqual(["6 inputs"]);
  });
  it("a change finding's title links its outputs", () => {
    const t = tx(
      [{ value: 100_000, to: "me" }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "me" },
      ],
    );
    expect(said(t, "change").title).toStrictEqual([
      "Output ",
      { ref: "out", index: 1 },
      " reads as change, output ",
      { ref: "out", index: 0 },
      " as the payment",
    ]);
  });
  it("coins spent together say they are shown only before sending", () => {
    const together = tx(
      [
        { value: 100_000, to: "a" },
        { value: 100_000, to: "b" },
      ],
      [{ value: 190_000, to: "x" }],
    );
    expect(said(together, "spent-together").note).toBe("Shown only before sending");
  });
});

describe("what this checks", () => {
  it("names every check in a sentence, and what it does not do", () => {
    expect(CHECKS).toStrictEqual([
      {
        text: "Address reuse: an address that appears more than once among the inputs that fund this transaction and the outputs it pays. An observer may read the coins at one address as one owner's.",
      },
      {
        text: "Which output is change, from four readings:",
        readings: [
          "When it pays two or more outputs, the only one paying the same address an input spends from, which an observer may read as going back to the sender. This one decides.",
          "Of the two outputs checked, a round amount (a multiple of 0.0001 BTC with at most two significant digits, such as 0.05 or 1.5 BTC) beside one that is not even a multiple of 0.00001 BTC: the round one suggests the payment.",
          "Every input that funds it of one script type, and only one of the two outputs checked of that type: it suggests the change.",
          "The smaller of the two outputs checked being less than the least spent from any one funding address, while the larger is not: if the wallet would not add coins it did not need, the larger suggests the payment.",
        ],
        after:
          "The last three look only at a transaction that pays exactly two outputs, the two outputs checked. Readings that point at different outputs leave it unclear, unless one is the pay-back, which decides. With more than one output paying an address an input spends from, no output is read as change.",
      },
      {
        text: "The shape of a CoinJoin, where several people pay into one transaction: among other conditions, three or more outputs of one amount, each to a different address, with the inputs that fund it from at least as many different addresses. Equal amounts alone do not tell which output is whose, though other things still may; on that shape, which output is change is not read.",
      },
      {
        text: "Coins spent together, which suggest one owner; shown only before a transaction is sent, while that can still change.",
      },
    ]);
    expect(LIMITS).toStrictEqual([
      "It does not look at earlier transactions, so an address used before this one is not noticed.",
      "It knows amounts round in bitcoin only, not a payment round in another currency.",
      "These are readings anyone can make, not proof, and nothing here makes a transaction private.",
    ]);
  });
});

// ---- Every sentence says what its rule counted: funding inputs, and scripts by name. ----

/** `v` paying a bare P2PK script, which has no address. */
function bare(v: Vout, n: number): Vout {
  const { scriptpubkey_address: _, ...rest } = v;
  return {
    ...rest,
    scriptpubkey: `21${n.toString(16).padStart(2, "0").repeat(33)}ac`,
    scriptpubkey_type: "p2pk",
  };
}
/** `t` with input `i`'s coin moved to a script with no address. */
function bareInput(t: Transaction, i: number): Transaction {
  const inputs = structuredClone(t.vin ?? []);
  const x = inputs[i];
  if (x?.prevout) x.prevout = bare(x.prevout, 0x40 + i);
  return { ...t, vin: inputs };
}
/** `t` with output `o` paying a script with no address. */
function bareOutput(t: Transaction, o: number): Transaction {
  const outputs = structuredClone(t.vout);
  const v = outputs[o];
  if (v) outputs[o] = bare(v, 0x60 + o);
  return { ...t, vout: outputs };
}

describe("what the rules counted, by name", () => {
  const join = () =>
    tx(
      [0, 1, 2].map((k) => ({ value: 2_000_000, to: `i${k}` })),
      [0, 1, 2].map((k) => ({ value: 1_000_000, to: `o${k}` })),
    );
  it("a CoinJoin with a script that has no address on each side says locking scripts", () => {
    const t = bareOutput(bareInput(join(), 1), 2);
    const f = checkPrivacy(t).findings.find((x) => x.kind === "coinjoin");
    expect(
      f?.kind === "coinjoin" && [f.sendersAreAddresses, f.groups[0]?.toAddresses],
    ).toStrictEqual([false, false]);
    expect(plain(said(t, "coinjoin").body[0] ?? [])).toBe(
      "Outputs 0, 1 and 2 each pay exactly 0.01 BTC to a different locking script, and the inputs that fund it spend from 3 different locking scripts.",
    );
  });
  it("a CoinJoin beside a fee anchor input counts only the inputs that fund it", () => {
    const t = anchored(join(), "in");
    expect(t.vin).toHaveLength(4);
    expect(plain(said(t, "coinjoin").body[0] ?? [])).toBe(
      "Outputs 0, 1 and 2 each pay exactly 0.01 BTC to a different address, and the inputs that fund it spend from 3 different addresses.",
    );
  });

  const smallest = () =>
    tx(
      [
        { value: 103_000, to: "i0" },
        { value: 302_000, to: "i1" },
      ],
      [
        { value: 100_001, to: "a" },
        { value: 300_001, to: "b" },
      ],
    );
  it("the smallest coin from a script with no address says locking script", () => {
    const t = bareInput(smallest(), 0);
    expect(plain(said(t, "change").reasons[0] ?? [])).toBe(
      "It is less than 0.00103 BTC, the least spent from any one funding locking script (input 0), and the other output checked is not.",
    );
  });
  it("the smallest coin beside a fee anchor input leaves the anchor's coin out", () => {
    const t = anchored(smallest(), "in");
    // The anchor's 240 sats are less than any funding address spends; it is not a funding address.
    expect(plain(said(t, "change").reasons[0] ?? [])).toBe(
      "It is less than 0.00103 BTC, the least spent from any one funding address (input 0), and the other output checked is not.",
    );
  });

  const together = () =>
    tx(
      [
        { value: 100_000, to: "a" },
        { value: 100_000, to: "b" },
      ],
      [{ value: 190_000, to: "x" }],
    );
  it("coins spent together from a script with no address say locking scripts", () => {
    const t = bareInput(together(), 1);
    expect(plain(said(t, "spent-together").body[0] ?? [])).toBe(
      "Inputs 0 and 1 are spent together, from 2 different locking scripts: an observer may read them as one owner's.",
    );
  });
  it("coins spent together beside a fee anchor list only the inputs that fund it", () => {
    const t = anchored(anchored(together(), "in"), "out");
    expect(lines(said(t, "spent-together"))).toStrictEqual([
      "Coins spent together",
      "Inputs 0 and 1 are spent together, from 2 different addresses: an observer may read them as one owner's.",
      "Only one output is paid, other than data or a fee anchor, so nothing in it reads as change.",
    ]);
  });

  it("two fee anchor outputs are no reuse, and an anchor input is no reused address", () => {
    const t = anchored(anchored(anchored(together(), "out"), "out"), "in");
    expect(checkPrivacy(t).findings.map((f) => f.kind)).not.toContain("reuse");
  });
  it("the two outputs checked beside a fee anchor output are the two that pay", () => {
    const t = anchored(
      tx(
        [{ value: 10_000_000, to: "me" }],
        [
          { value: 5_000_000, to: "you" },
          { value: 4_987_654, to: "new" },
        ],
      ),
      "out",
    );
    expect(lines(said(t, "change")).slice(2)).toStrictEqual([
      "• Output 0 is a round 0.05 BTC and this one is not.",
    ]);
  });
});

describe("a number or an address in a real sentence", () => {
  /** Sentences whose number or address is followed by punctuation outside its tail. */
  const splits = (x: Said): string[] =>
    [x.title, ...x.body, ...x.reasons].flatMap((sentence) => {
      const rs = runs(sentence);
      return rs.some((r, k) => {
        const next = rs[k + 1];
        return (
          !("text" in r) && next !== undefined && "text" in next && /^[,.;:)!?]/.test(next.text)
        );
      })
        ? [plain(sentence)]
        : [];
    });
  const coins = (n: number, value: number, to: string) =>
    Array.from({ length: n }, (_, k) => ({ value, to: `${to}${k}` }));

  it("keeps the punctuation after it in its tail, in every kind and reading", () => {
    const cases: Transaction[] = [
      // Reuse in and out, and change by pay-back, round amount, script type and smallest coin.
      tx(
        [
          { value: 150_003, to: "a" },
          { value: 4_990_003, to: "b" },
        ],
        [
          { value: 5_000_000, to: "x", type: "v1_p2tr" },
          { value: 100_001, to: "a" },
        ],
      ),
      // Readings that disagree, the smallest coin among them: "(input 0), and".
      tx(
        [
          { value: 150_003, to: "a" },
          { value: 4_990_003, to: "b" },
        ],
        [
          { value: 5_000_000, to: "x" },
          { value: 100_001, to: "y", type: "v1_p2tr" },
        ],
      ),
      // Reuse among inputs only and among outputs only, several listed: "0, 1".
      tx(
        Array.from({ length: 3 }, () => ({ value: 100_000, to: "same" })),
        [
          { value: 100_001, to: "out" },
          { value: 100_002, to: "out" },
        ],
      ),
      // A CoinJoin, one group and several.
      tx(coins(3, 2_000_000, "i"), coins(3, 1_000_000, "o")),
      tx(coins(7, 2_000_000, "i"), [...coins(4, 1_000_000, "a"), ...coins(3, 50_000, "b")]),
      // Coins spent together, listed: "Inputs 0, 1 and 2".
      tx(coins(3, 100_000, "t"), [{ value: 290_000, to: "x" }]),
    ];
    const all = cases.flatMap((t) => {
      const fs = checkPrivacy(t).findings;
      return fs.map((f) => sayFinding(f, fs));
    });
    expect(new Set(all.map((x) => x.kind))).toStrictEqual(
      new Set(["reuse", "change", "change-disputed", "coinjoin", "spent-together"]),
    );
    expect(all.flatMap((x) => splits(x))).toStrictEqual([]);
  });

  it("does the same for every finding the tests above say", () => {
    // Each `said` above records its finding; run with the file, this covers every form held.
    expect(seen.flatMap((x) => splits(x))).toStrictEqual([]);
  });
});

// ---- "What this checks", line by line against the rules: each line's smallest case fires, and
// the near miss it excludes does not. ----

describe("what this checks says no more than the rules do", () => {
  const op = (t: Transaction): Transaction => ({
    ...t,
    vout: [
      ...t.vout,
      { scriptpubkey: "6a00", scriptpubkey_asm: "", scriptpubkey_type: "op_return", value: 0 },
    ],
  });
  const readings = (t: Transaction) =>
    checkPrivacy(t).findings.flatMap((f) =>
      f.kind === "change" || f.kind === "change-disputed"
        ? f.readings.map((r) => r.reason.kind)
        : [],
    );
  const kinds = (t: Transaction) => checkPrivacy(t).findings.map((f) => f.kind);
  const has = (kind: PrivacyFinding["kind"]) => (t: Transaction) => kinds(t).includes(kind);
  type Reason = ReturnType<typeof readings>[number];
  const reads = (reason: Reason) => (t: Transaction) => readings(t).includes(reason);
  const me = (value: number, type?: ScriptType) => ({ value, to: "me", ...(type ? { type } : {}) });

  const rows: {
    line: string;
    fires: (t: Transaction) => boolean;
    yes: Transaction;
    no: Transaction[];
  }[] = [
    {
      line: "Address reuse: an address more than once among funding inputs and paid outputs",
      fires: has("reuse"),
      yes: tx([me(100_000)], [{ value: 30_001, to: "you" }, me(60_001)]),
      // Two fee anchor outputs share a script, but anchors are not outputs it pays.
      no: [anchored(anchored(tx([me(100_000)], [{ value: 90_000, to: "you" }]), "out"), "out")],
    },
    {
      line: "Pay-back: of two or more paid outputs, the only one paying an input's address",
      fires: reads("payback"),
      yes: tx([me(100_000)], [{ value: 30_001, to: "you" }, me(60_001)]),
      no: [
        // One output, paying back: reuse only.
        tx([me(100_000)], [me(90_000)]),
        // Two outputs paying back to two inputs' addresses: none is the only one.
        tx(
          [me(100_000), { value: 100_000, to: "him" }],
          [me(90_001), { value: 90_001, to: "him" }],
        ),
        // A data output beside it is not an output it pays.
        op(tx([me(100_000)], [me(90_000)])),
      ],
    },
    {
      line: "Round amount: one of 0.0001 BTC, two significant digits, beside one not a multiple of 0.00001 BTC",
      fires: reads("round"),
      yes: tx(
        [{ value: 10_000_000, to: "a" }],
        [
          { value: 5_000_000, to: "x" },
          { value: 4_987_654, to: "y" },
        ],
      ),
      no: [
        // 0.0005 beside 0.00149: the other is a multiple of 0.00001 BTC.
        tx(
          [{ value: 300_000, to: "a" }],
          [
            { value: 50_000, to: "x" },
            { value: 149_000, to: "y" },
          ],
        ),
        // 0.0123 BTC has three significant digits: not round.
        tx(
          [{ value: 10_000_000, to: "a" }],
          [
            { value: 1_230_000, to: "x" },
            { value: 4_987_654, to: "y" },
          ],
        ),
        // Three outputs it pays: the round reading looks only at two.
        tx(
          [{ value: 20_000_000, to: "a" }],
          [
            { value: 5_000_000, to: "x" },
            { value: 4_987_654, to: "y" },
            { value: 3_987_654, to: "z" },
          ],
        ),
      ],
    },
    {
      line: "The 1.5 BTC example is round",
      fires: reads("round"),
      yes: tx(
        [{ value: 300_000_000, to: "a" }],
        [
          { value: 150_000_000, to: "x" },
          { value: 149_987_654, to: "y" },
        ],
      ),
      no: [],
    },
    {
      line: "Script type: every funding input one type, only one of the two outputs of it",
      fires: reads("script"),
      yes: tx(
        [{ value: 10_000_000, to: "a", type: "v1_p2tr" }],
        [
          { value: 5_000_001, to: "x", type: "v1_p2tr" },
          { value: 4_987_654, to: "y" },
        ],
      ),
      no: [
        // Inputs of two types.
        tx(
          [
            { value: 5_000_000, to: "a", type: "v1_p2tr" },
            { value: 5_000_000, to: "b" },
          ],
          [
            { value: 5_000_001, to: "x", type: "v1_p2tr" },
            { value: 4_987_654, to: "y" },
          ],
        ),
        // Both outputs of the inputs' type.
        tx(
          [{ value: 10_000_000, to: "a", type: "v1_p2tr" }],
          [
            { value: 5_000_001, to: "x", type: "v1_p2tr" },
            { value: 4_987_654, to: "y", type: "v1_p2tr" },
          ],
        ),
      ],
    },
    {
      line: "Smallest coin: the smaller output under the least from one funding address, the larger not",
      fires: reads("unneeded"),
      yes: tx(
        [
          { value: 103_000, to: "i0" },
          { value: 302_000, to: "i1" },
        ],
        [
          { value: 100_001, to: "a" },
          { value: 300_001, to: "b" },
        ],
      ),
      no: [
        // The smaller output is not under the least from one address.
        tx(
          [
            { value: 103_000, to: "i0" },
            { value: 302_000, to: "i1" },
          ],
          [
            { value: 110_001, to: "a" },
            { value: 290_001, to: "b" },
          ],
        ),
      ],
    },
    {
      line: "Readings that point at different outputs leave it unclear",
      fires: has("change-disputed"),
      yes: tx(
        [
          { value: 150_003, to: "a" },
          { value: 4_990_003, to: "b" },
        ],
        [
          { value: 5_000_000, to: "x" },
          { value: 100_001, to: "y", type: "v1_p2tr" },
        ],
      ),
      // Unless one is the pay-back, which decides: output 1 pays back and is the round one.
      no: [tx([me(10_000_000)], [{ value: 4_987_654, to: "you" }, me(5_000_000)])],
    },
    {
      line: "With more than one output paying an input's address back, no output is read as change",
      fires: (t) => has("reuse")(t) && readings(t).length === 0,
      // 0.05 and 0.04987654 BTC, both back to the input's own address: the amounts fit the round
      // reading, but neither is read as change.
      yes: tx([me(10_000_000)], [me(5_000_000), me(4_987_654)]),
      // One of them paying elsewhere: the pay-back is read.
      no: [tx([me(10_000_000)], [{ value: 5_000_000, to: "you" }, me(4_987_654)])],
    },
    {
      line: "CoinJoin: three or more equal outputs to different addresses, as many funding addresses",
      fires: has("coinjoin"),
      yes: tx(
        [0, 1, 2].map((k) => ({ value: 2_000_000, to: `i${k}` })),
        [0, 1, 2].map((k) => ({ value: 1_000_000, to: `o${k}` })),
      ),
      no: [
        // Two equal outputs.
        tx(
          [0, 1, 2].map((k) => ({ value: 2_000_000, to: `i${k}` })),
          [
            { value: 1_000_000, to: "o0" },
            { value: 1_000_000, to: "o1" },
            { value: 3_987_654, to: "o2" },
          ],
        ),
        // Fewer funding addresses than equal outputs.
        tx(
          [0, 1].map((k) => ({ value: 3_000_000, to: `i${k}` })),
          [0, 1, 2].map((k) => ({ value: 1_000_000, to: `o${k}` })),
        ),
      ],
    },
    {
      line: "Coins spent together: two or more funding inputs",
      fires: has("spent-together"),
      yes: tx(
        [
          { value: 100_000, to: "a" },
          { value: 100_000, to: "b" },
        ],
        [{ value: 190_000, to: "x" }],
      ),
      no: [
        tx([{ value: 100_000, to: "a" }], [{ value: 90_000, to: "x" }]),
        // A fee anchor's input does not fund it.
        anchored(tx([{ value: 100_000, to: "a" }], [{ value: 90_000, to: "x" }]), "in"),
      ],
    },
  ];

  it.each(rows)("$line", ({ fires, yes, no }) => {
    expect(fires(yes)).toBe(true);
    for (const t of no) expect(fires(t)).toBe(false);
  });
});
