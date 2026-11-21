// Every sentence the privacy check can say, exactly, from reports the real rules make
// (lib/privacy.ts) on transactions built here, and which cards get which marks.
import { describe, expect, it } from "vitest";
import type { ScriptType, Transaction, Vin, Vout } from "../../lib/esplora";
import { checkPrivacy, type PrivacyFinding, type PrivacyReport } from "../../lib/privacy";
import {
  btc,
  CHECKS,
  cardMarks,
  isPartial,
  LIMITS,
  listed,
  plain,
  type Said,
  sayFinding,
  sayNothing,
  sayPartial,
  shownAddress,
  shownFindings,
  TITLE_MAX,
} from "./privacytext";

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
  return sayFinding(f);
}

/** A said finding as plain lines: title, body, then each reason after "• ". */
const lines = (s: Said) => [
  s.title,
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
      "Input 0 spends from bcrt1qme, and output 1 pays the same address, so the same locking script. An observer may read one address as one owner, which ties that output to that input.",
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
      "Inputs 0 and 1 spend from bcrt1qme, and outputs 0 and 1 pay the same address, so the same locking script. An observer may read one address as one owner, which ties those outputs to those inputs.",
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
      "Inputs 0, 1 and 2 all spend from bcrt1qme. An observer may read one address as one owner, which ties those coins together, and to anything else paid to that address.",
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
      "Outputs 0 and 1 both pay bcrt1qyou. An observer may read one address as one owner, which ties those outputs together.",
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
      `Outputs 0 and 1 both pay the locking script ${script.slice(0, 8)}…${script.slice(-8)}. An observer may read one locking script as one owner, which ties those outputs together.`,
    ]);
    expect(cardMarks(checkPrivacy(noAddress).findings).get("out:0")).toStrictEqual([
      { text: "Reused script", tone: "caution" },
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
    expect(s.title).toBe("Address reused");
    expect(plain(s.body[0] ?? [])).toMatch(/pays the same address, so the same locking script/);
    expect(plain(said(t, "change").reasons[0] ?? [])).toBe(
      "It pays the same address input 0 spends from, which an observer may read as going back to the sender.",
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
    expect(said(empty, "reuse").title).toBe("Locking script reused");
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
      "It pays the same locking script input 0 spends from, which an observer may read as going back to the sender.",
    );
  });
  it("says three addresses and counts the rest", () => {
    const outs = ["a", "b", "c", "d", "e"].flatMap((to) => [
      { value: 10_001, to },
      { value: 10_002, to },
    ]);
    const s = said(tx([{ value: 1_000_000, to: "me" }], outs), "reuse");
    expect(s.title).toBe("5 addresses reused");
    expect(s.body).toHaveLength(4);
    expect(plain(s.body[3] ?? [])).toBe("2 more addresses appear more than once.");
  });
  it("counts many inputs instead of listing them", () => {
    const ins = Array.from({ length: 65 }, () => ({ value: 10_000, to: "me" }));
    expect(plain(said(tx(ins, [{ value: 600_000, to: "you" }]), "reuse").body[0] ?? [])).toBe(
      "65 inputs all spend from bcrt1qme. An observer may read one address as one owner, which ties those coins together, and to anything else paid to that address.",
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
    expect(lines(said(t, "change"))).toStrictEqual([
      "Output 1 reads as change, output 0 as the payment",
      "Suggested by one reading, which is not proof:",
      "• It pays the same address input 0 spends from, which an observer may read as going back to the sender.",
    ]);
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
      "Suggested by one reading, which is not proof:",
      "• It pays the same address inputs 0 and 1 spend from, which an observer may read as going back to the sender.",
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
      "• Output 0 is a round 0.05 BTC and this one is not, which suggests output 0 is the payment.",
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
      "• Every input that funds it is P2TR, and of the two outputs checked only this one is, which suggests it is the change.",
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
      "• It is less than 0.00103 BTC, the least spent from any one address (input 0), and the other output checked is not. If the wallet would not add coins it did not need, that suggests the other output checked is the payment.",
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
      "It is less than 0.00400003 BTC, the least spent from any one address (input 2), and the other output checked is not. If the wallet would not add coins it did not need, that suggests the other output checked is the payment.",
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
      "It is less than 0.00400002 BTC, the least spent from any one address (inputs 0 and 1), and the other output checked is not. If the wallet would not add coins it did not need, that suggests the other output checked is the payment.",
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
      "• It pays the same address input 0 spends from, which an observer may read as going back to the sender.",
      "• Output 0 is a round 0.05 BTC and this one is not, which suggests output 0 is the payment.",
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
      "Every input that funds it is P2TR, and of the two outputs checked only this one is, which suggests it is the change.",
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
      "Every input that funds it is P2TR, and of the two outputs checked only this one is, which suggests it is the change.",
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
      "• It pays the same address input 0 spends from, which an observer may read as going back to the sender.",
      "• Output 0 is a round 0.05 BTC and this one is not, which suggests output 0 is the payment.",
      "• Every input that funds it is P2TR, and of the two outputs checked only this one is, which suggests it is the change.",
    ]);
  });
  it("disputed: the readings as facts, no output named as change", () => {
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
      "These two readings point at different outputs, so neither is strong:",
      "• Output 0 is a round 0.05 BTC, and output 1 is not.",
      "• Every input that funds it is P2TR, and of the two outputs checked only output 0 is.",
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
      "• It pays the same address input 0 spends from, which an observer may read as going back to the sender.",
      "• Output 0 is a round 0.05 BTC and this one is not, which suggests output 0 is the payment.",
      "• Every input that funds it is P2WPKH, and of the two outputs checked only this one is, which suggests it is the change.",
      "• It is less than 0.00150003 BTC, the least spent from any one address (input 0), and the other output checked is not. If the wallet would not add coins it did not need, that suggests the other output checked is the payment.",
    ]);
  });
  it("disputed by three readings: none of them is strong", () => {
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
      "These readings point at different outputs, so none of them is strong:",
      "• Output 0 is a round 0.05 BTC, and output 1 is not.",
      "• Every input that funds it is P2WPKH, and of the two outputs checked only output 0 is.",
      "• Output 1 is less than 0.00150003 BTC, the least spent from any one address (input 0), and the other output checked is not.",
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
      "These two readings point at different outputs, so neither is strong:",
      "• Every input that funds it is P2WSH, and of the two outputs checked only output 1 is.",
      "• Output 0 is less than 0.0169945 BTC, the least spent from any one address (input 0), and the other output checked is not.",
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
      "Outputs 0, 1 and 2 each pay exactly 0.01 BTC, each to a different address, and the inputs that fund it come from 3 different addresses.",
      "That is the shape of a CoinJoin, where several people pay into one transaction. Because the amounts are equal, they alone do not tell an observer which equal output is whose; other things still may. The shape alone does not prove it is one, and which output is change is not read here.",
    ]);
  });
  it("several groups", () => {
    const outs = [
      ...[0, 1, 2, 3].map((k) => ({ value: 1_000_000, to: `a${k}` })),
      ...[0, 1, 2].map((k) => ({ value: 50_000, to: `b${k}` })),
    ];
    expect(plain(said(tx(ins(7), outs), "coinjoin").body[0] ?? [])).toBe(
      "7 outputs fall into 2 groups of equal amounts, the largest 4 of 0.01 BTC. Within each group every output pays a different address, and the inputs that fund it come from 7 different addresses.",
    );
  });
  it("counts the inputs that fund it, not an anchor beside them", () => {
    const outs = [0, 1, 2].map((k) => ({ value: 1_000_000, to: `o${k}` }));
    expect(plain(said(anchored(tx(ins(3), outs), "in"), "coinjoin").body[0] ?? [])).toBe(
      "Outputs 0, 1 and 2 each pay exactly 0.01 BTC, each to a different address, and the inputs that fund it come from 3 different addresses.",
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
      "Inputs 0 and 1 are spent together, from 2 different addresses. An observer can read coins spent in one transaction as one owner's.",
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
      "Inputs 0, 1 and 2 are spent together, all from one address. An observer can read coins spent in one transaction as one owner's.",
      "Only one output is paid, so nothing in it reads as change.",
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
      "Inputs 0 and 1 are spent together, from 2 different addresses. An observer can read coins spent in one transaction as one owner's.",
      "Only one output is paid, so nothing in it reads as change.",
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
      "What input 1 spends is not known here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one address.",
      "What it shows about address reuse and which output is change may be incomplete.",
    ]);
    expect(partial(r, true)).toStrictEqual([
      HEAD,
      "What input 1 spends is not known here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types, the least spent from one address and coins spent together.",
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
      "Its inputs are not listed here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one address.",
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
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so these were not checked: the CoinJoin shape, round amounts and the least spent from one address.",
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
      "What input 1 spends is not known here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one address.",
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so these were not checked: the CoinJoin shape, round amounts and the least spent from one address.",
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
      "Its inputs are not listed here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one address.",
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so these were not checked: the CoinJoin shape, round amounts and the least spent from one address.",
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
    expect(sentence.filter((p) => typeof p !== "string")).toStrictEqual([{ address: HOSTILE }]);
    // The text around it is ours alone.
    expect(sentence.filter((p) => typeof p === "string").join("")).not.toMatch(/[<>]/);
    // Shown with its bidi override made visible, cut to eight and eight.
    expect(plain(sentence)).toBe(
      "Input 0 spends from <img src…\uFFFDgnp.exe, and output 1 pays the same address, so the same locking script. An observer may read one address as one owner, which ties that output to that input.",
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
    expect(shownAddress("bcrt1qme")).toStrictEqual({ short: "bcrt1qme", title: "bcrt1qme" });
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
      "in:0": [{ text: "Reused address", tone: "caution" }],
      "out:1": [
        { text: "Reused address", tone: "caution" },
        { text: "Reads as change", tone: "caution" },
      ],
      "out:0": [{ text: "Reads as payment", tone: "caution" }],
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
      "out:0": [{ text: "Equal amount", tone: "neutral" }],
      "out:1": [{ text: "Equal amount", tone: "neutral" }],
      "out:2": [{ text: "Equal amount", tone: "neutral" }],
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

describe("what this checks", () => {
  it("names every check in a sentence, and what it does not do", () => {
    expect(CHECKS).toStrictEqual([
      "Address reuse: an address that appears more than once among this transaction's inputs and outputs.",
      "Which output is change, from four readings: one output paying the same address an input spends from; one round amount beside one that is not; the only one of two outputs checked of the inputs' script type; and the smaller of two outputs checked being less than the least spent from any one address while the larger is not. Every output is checked but data outputs (OP_RETURN) and fee anchors. A pay-back decides; readings that point at different outputs leave it unclear.",
      "The shape of a CoinJoin: among other conditions, three or more outputs of one amount, each to a different address, with the inputs that fund it from at least as many different addresses.",
      "Coins spent together, which suggest one owner; shown only before a transaction is sent, while that can still change.",
    ]);
    expect(LIMITS).toStrictEqual([
      "It does not look at earlier transactions, so an address used before this one is not noticed.",
      "It knows amounts round in bitcoin only, not a payment round in another currency.",
      "These are readings anyone can make, not proof, and nothing here makes a transaction private.",
    ]);
  });
});
