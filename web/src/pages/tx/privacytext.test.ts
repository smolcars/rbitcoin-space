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
  shownFindings,
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
      "Input 0 spends from bcrt1qme, and output 1 pays the same address. An observer can tie that output to whoever controls that input.",
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
      "Inputs 0 and 1 spend from bcrt1qme, and outputs 0 and 1 pay the same address. An observer can tie those outputs to whoever controls those inputs.",
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
      "Inputs 0, 1 and 2 all spend from bcrt1qme. An observer can tie those coins to one owner, with anything else paid to that address.",
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
      "Outputs 0 and 1 both pay bcrt1qyou. An observer can tie them to the same owner.",
    ]);
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
      "65 inputs all spend from bcrt1qme. An observer can tie those coins to one owner, with anything else paid to that address.",
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
      "• It pays back to the address input 0 spends from, so it goes to whoever controls that input.",
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
      "• It pays back to the address inputs 0 and 1 spend from, so it goes to whoever controls those inputs.",
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
      "• It is the only output of the inputs' type, P2TR, which suggests it goes back to the same wallet.",
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
      "• It is less than 0.00103 BTC, the smallest coin spent (input 0), and the other output is not. If the wallet would not add a coin it did not need, that suggests the other output is the payment.",
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
      "It is less than 0.00400003 BTC, the smallest coin spent (input 2), and the other output is not. If the wallet would not add a coin it did not need, that suggests the other output is the payment.",
    );
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
      "It is less than 0.00400002 BTC, the least spent from one address (inputs 0 and 1), and the other output is not. If the wallet would not add a coin it did not need, that suggests the other output is the payment.",
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
      "• It pays back to the address input 0 spends from, so it goes to whoever controls that input.",
      "• Output 0 is a round 0.05 BTC and this one is not, which suggests output 0 is the payment.",
      "• It is the only output of the inputs' type, P2TR, which suggests it goes back to the same wallet.",
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
      "These readings point at different outputs, so none of them is strong:",
      "• Output 0 is a round 0.05 BTC, and output 1 is not.",
      "• Only output 0 is of the inputs' type, P2TR.",
    ]);
    expect(lines(s).join(" ")).not.toMatch(/reads as change,|is the payment|is change/);
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
      "These readings point at different outputs, so none of them is strong:",
      "• Only output 1 is of the inputs' type, P2WSH.",
      "• Output 0 is less than 0.0169945 BTC, the smallest coin spent (input 0), and the other output is not.",
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
      "Outputs 0, 1 and 2 each pay exactly 0.01 BTC, to different addresses, and the inputs come from 3 different addresses.",
      "That is the shape of a CoinJoin, where several people pay into one transaction so an observer cannot tell which equal output is whose. The shape alone does not prove it is one, and which output is change is not read here.",
    ]);
  });
  it("several groups", () => {
    const outs = [
      ...[0, 1, 2, 3].map((k) => ({ value: 1_000_000, to: `a${k}` })),
      ...[0, 1, 2].map((k) => ({ value: 50_000, to: `b${k}` })),
    ];
    expect(plain(said(tx(ins(7), outs), "coinjoin").body[0] ?? [])).toBe(
      "7 outputs fall into 2 groups of equal amounts, the largest 4 of 0.01 BTC, each to a different address, and the inputs come from 7 different addresses.",
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
      "There is one output and no change, so all of it goes to one place.",
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
  it("says nothing when everything was checked", () => {
    const r = checkPrivacy(tx([{ value: 100_000, to: "a" }], [{ value: 90_000, to: "b" }]));
    expect(isPartial(r)).toBe(false);
    expect(partial(r)).toStrictEqual([]);
    expect(sayNothing(false)).toBe("Nothing in this transaction's shape stands out.");
  });
  it("one unknown input, two outputs", () => {
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
      "What input 1 spends is not known here, so only part of this transaction could be checked.",
      "Not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the smallest coin spent.",
      "What it shows about address reuse and which output is change may be incomplete.",
    ]);
    expect(partial(r, true)).toStrictEqual([
      "What input 1 spends is not known here, so only part of this transaction could be checked.",
      "Not checked: the CoinJoin shape, outputs paying back to an input's address, script types, the smallest coin spent and coins spent together.",
      "What it shows about address reuse, which output is change and coins spent together may be incomplete.",
    ]);
  });
  it("several unknown inputs, three outputs, past the lookup limit", () => {
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
      "What input 100 spends is not known here, so only part of this transaction could be checked.",
      "Not checked: the CoinJoin shape and outputs paying back to an input's address.",
      "What it shows about address reuse, which output is change and the CoinJoin shape may be incomplete.",
    ]);
    const many = checkPrivacy(tx([null, null, null, null, null, null], [{ value: 1, to: "x" }]));
    expect(partial(many)[0]).toBe(
      "What 6 inputs spend is not known here, so only part of this transaction could be checked.",
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
    const r = checkPrivacy({ ...t, pruned: true });
    expect(partial(r)).toStrictEqual([
      "This transaction's inputs are not listed here, so only its outputs could be checked.",
      "Not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the smallest coin spent.",
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
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so only part of it could be checked.",
      "Not checked: the CoinJoin shape, round amounts and the smallest coin spent.",
      "What it shows about which output is change may be incomplete.",
    ]);
  });
  it("never says nothing stands out when only part was checked", () => {
    expect(sayNothing(true)).toBe("Nothing was found in the part that could be checked.");
    expect(sayNothing(true)).not.toMatch(/stands out/);
  });
});

describe("hostile addresses", () => {
  const HOSTILE = '<img src=x onerror="alert(1)">‮gnp.exe';
  it("stay one piece of the sentence, never markup or wording", () => {
    const t = tx(
      [{ value: 100_000, to: "me", address: HOSTILE }],
      [
        { value: 30_001, to: "you" },
        { value: 60_001, to: "me", address: HOSTILE },
      ],
    );
    const s = said(t, "reuse");
    const sentence = s.body[0] ?? [];
    expect(sentence.filter((p) => typeof p !== "string")).toStrictEqual([{ address: HOSTILE }]);
    // The text around it is ours alone.
    expect(sentence.filter((p) => typeof p === "string").join("")).not.toMatch(/[<>]/);
    // Shortened as the site shortens: eight and eight.
    expect(plain(sentence, (a) => `${a.slice(0, 8)}…${a.slice(-8)}`)).toBe(
      "Input 0 spends from <img src…‮gnp.exe, and output 1 pays the same address. An observer can tie that output to whoever controls that input.",
    );
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
      "Which output is change, from four readings: one output paying back to an address an input spends from; one round amount beside one that is not; the only output of the inputs' script type; and the smaller output being less than the smallest coin spent while the larger is not. A pay-back decides; readings that point at different outputs leave it unclear.",
      "The shape of a CoinJoin: three or more outputs of one amount, each to a different address, from at least as many different addresses.",
      "Coins spent together, which suggest one owner; shown only before a transaction is sent, while that can still change.",
    ]);
    expect(LIMITS).toStrictEqual([
      "It does not look at earlier transactions, so an address used before this one is not noticed.",
      "It knows amounts round in bitcoin only, not a payment round in another currency.",
      "These are readings anyone can make, not proof, and nothing here makes a transaction private.",
    ]);
  });
});
