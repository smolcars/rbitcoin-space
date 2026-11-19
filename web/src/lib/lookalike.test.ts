import { describe, expect, it } from "vitest";
import type { Transaction } from "./esplora";
import { HANDOVER_MAX, handoverState, type Lookalike, readHandover } from "./lookalike";

// The regtest browser test's addresses (e2e/lookalike.mine.e2e.ts): real checksums.
const VICTIM = "bcrt1q92tjde2x93754htnwfj50zh9g2dmx39f5kmmx6";
const VICTIM_LOOKALIKE = "bcrt1q92tjvp70h8qk3ma6v7u4cnyqkffq94gvfsmmx6";
const PAYEE = "bcrt1pdclg9pxv7f9q8wa527cg452hsvc4mlrm5cya77ju7d3t3kh2gnrsy44uu7";
const PAYEE_LOOKALIKE = "bcrt1pdclrxgvd3rzmust7u2klx3xq7cna7pccla77ex8zuvekangf4gdqe74uu7";
const CUSTOMER = "mjh66T2J8h1LrrvqrVMKahUaNSABz6YTFx";

const out = (address: string) => ({
  scriptpubkey: "",
  scriptpubkey_asm: "",
  scriptpubkey_type: "unknown" as const,
  value: 600,
  scriptpubkey_address: address,
});
const tx = (inputs: string[], outputs: string[]): Transaction => ({
  txid: "aa".repeat(32),
  version: 2,
  locktime: 0,
  vin: inputs.map((a, i) => ({
    txid: "bb".repeat(32),
    vout: i,
    is_coinbase: false,
    sequence: 0,
    scriptsig: "",
    prevout: out(a),
  })),
  vout: outputs.map((a) => out(a)),
  status: { confirmed: false },
});

const own: Lookalike = {
  here: VICTIM_LOOKALIKE,
  like: VICTIM,
  own: true,
  head: 4,
  tail: 4,
  prefix: 6,
};
const pair: Lookalike = {
  here: PAYEE_LOOKALIKE,
  like: PAYEE,
  own: false,
  head: 3,
  tail: 4,
  prefix: 6,
};
const poisoning = tx([CUSTOMER], [VICTIM, VICTIM_LOOKALIKE, PAYEE_LOOKALIKE]);

/** The state as the router hands it back: parsed, with its own key beside ours. */
const state = (from: string, found: readonly Lookalike[]) => ({
  ...(JSON.parse(handoverState(from, found, poisoning.txid, "regtest")) as object),
  _depth: 3,
});
/** A handover built by hand, for what the writer would never write, made for `poisoning`. */
const raw = (h: unknown) => ({
  lookalike: isRecord(h) ? { txid: poisoning.txid, network: "regtest", ...h } : h,
});
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Read as the regtest transaction page reads it. */
const read = (s: unknown, t: Transaction) => readHandover(s, t, "regtest");
const valid = { from: VICTIM, found: [own], count: 1 };

describe("readHandover", () => {
  it("reads back what a row wrote, beside the router's own keys", () => {
    expect(read(state(VICTIM, [own, pair]), poisoning)).toStrictEqual({
      from: VICTIM,
      found: [own, pair],
      more: false,
    });
  });

  it("puts the reader's own address's lookalikes first", () => {
    expect(read(state(VICTIM, [pair, own]), poisoning)?.found).toStrictEqual([own, pair]);
  });

  it("finds an address among the inputs' previous outputs too", () => {
    const spent = tx([VICTIM_LOOKALIKE], [CUSTOMER]);
    expect(read(state(VICTIM, [own]), spent)?.found).toStrictEqual([own]);
  });

  it("caps what a row writes, and says there were more", () => {
    // A hundred addresses ground to the reader's ends, as a poisoning transaction carries them.
    const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const ground = Array.from({ length: HANDOVER_MAX + 36 }, (_, i): Lookalike => {
      const a = BECH32[i % 32] ?? "q";
      const b = BECH32[Math.floor(i / 32)] ?? "q";
      // "92" and "mmx6" as the reader's, the characters next to them different from theirs.
      return {
        here: `bcrt1q92q${a}${b}${"q".repeat(28)}pmmx6`,
        like: VICTIM,
        own: true,
        head: 2,
        tail: 4,
        prefix: 6,
      };
    });
    const dusted = tx([CUSTOMER], [VICTIM, ...ground.map((l) => l.here)]);
    const written = JSON.parse(handoverState(VICTIM, ground, dusted.txid, "regtest")) as {
      lookalike: { found: unknown[] };
    };
    expect(written.lookalike.found).toHaveLength(HANDOVER_MAX);
    expect(read(written, dusted)).toStrictEqual({
      from: VICTIM,
      found: ground.slice(0, HANDOVER_MAX),
      more: true,
    });
  });

  it("ignores an oversized list whole", () => {
    const found = Array.from({ length: HANDOVER_MAX + 1 }, () => own);
    expect(read(raw({ from: VICTIM, found, count: found.length }), poisoning)).toBeUndefined();
  });

  it("ignores an address this transaction does not name", () => {
    const elsewhere = tx([CUSTOMER], [VICTIM, PAYEE]);
    expect(read(state(VICTIM, [own, pair]), elsewhere)).toBeUndefined();
    // And keeps those it does name.
    const some = tx([CUSTOMER], [PAYEE_LOOKALIKE]);
    expect(read(state(VICTIM, [own, pair]), some)?.found).toStrictEqual([pair]);
  });

  it("ignores anything malformed", () => {
    for (const s of [
      undefined,
      null,
      "lookalike",
      42,
      [valid],
      {},
      { lookalike: null },
      raw([valid]),
      raw({ ...valid, found: "x" }),
      raw({ ...valid, found: [] }),
      raw({ ...valid, count: -1 }),
      raw({ ...valid, count: 0 }),
      raw({ ...valid, count: 1.5 }),
      raw({ ...valid, count: "1" }),
      raw({ ...valid, from: 7 }),
      raw({ ...valid, from: "not an address" }),
      raw({ ...valid, from: `bc1q${"q".repeat(200)}` }),
    ]) {
      expect(read(s, poisoning)).toBeUndefined();
    }
  });

  it("ignores a finding of the wrong types", () => {
    for (const bad of [
      null,
      "x",
      [own],
      { ...own, head: "4" },
      { ...own, tail: -4 },
      { ...own, prefix: 6.5 },
      { ...own, own: "true" },
      { ...own, here: 1 },
      { ...own, like: ["x"] },
      { ...own, here: `<b>${VICTIM_LOOKALIKE}</b>` },
    ]) {
      expect(read(raw({ ...valid, found: [bad] }), poisoning)).toBeUndefined();
    }
  });

  it("ignores a finding whose marks or claims its addresses do not bear out", () => {
    for (const bad of [
      { ...own, head: 5 },
      { ...own, tail: 5 },
      { ...own, head: 0 },
      { ...own, prefix: 5 },
      { ...own, head: 80 },
      // `own` must mean the reader's address, and only it.
      { ...own, own: false },
      { ...pair, own: true },
      // Never the reader's own address, nor an address like itself.
      { ...own, here: VICTIM, like: VICTIM_LOOKALIKE },
      { ...own, like: VICTIM_LOOKALIKE },
    ]) {
      expect(read(raw({ ...valid, found: [bad] }), poisoning)).toBeUndefined();
    }
  });
});

describe("readHandover holds a finding to the rule and to what it was made for", () => {
  const TXID = "aa".repeat(32);
  /** State as a row writes it, for a transaction and network. */
  const made = (found: readonly Lookalike[], txid = TXID, network = "regtest") =>
    JSON.parse(handoverState(VICTIM, found, txid, network)) as unknown;

  it("never takes an address for a lookalike of itself in another case", () => {
    // The same bech32 address upper-cased is the same address, not one that differs in the middle.
    const same = VICTIM_LOOKALIKE.toUpperCase();
    const self = { here: VICTIM_LOOKALIKE, like: same, own: true, head: 38, tail: 38, prefix: 6 };
    const handed = raw({ from: same, found: [self], count: 1, txid: TXID, network: "regtest" });
    expect(readHandover(handed, poisoning, "regtest")).toBeUndefined();
  });

  it("refuses a pair that agrees below the rule's thresholds", () => {
    // Agrees with PAYEE_LOOKALIKE on one character after "bcrt1p" and one at the end.
    const like = `bcrt1pd${"q".repeat(PAYEE_LOOKALIKE.length - 8)}7`;
    const weak = { here: PAYEE_LOOKALIKE, like, own: false, head: 1, tail: 1, prefix: 6 };
    expect(readHandover(made([weak]), poisoning, "regtest")).toBeUndefined();
    // And one that claims less agreement than its addresses have.
    expect(readHandover(made([{ ...own, head: 2 }]), poisoning, "regtest")).toBeUndefined();
  });

  it("refuses findings made for another transaction or network", () => {
    expect(readHandover(made([own]), poisoning, "regtest")?.found).toStrictEqual([own]);
    // Another transaction that names the same address.
    expect(readHandover(made([own], "cc".repeat(32)), poisoning, "regtest")).toBeUndefined();
    expect(readHandover(made([own]), poisoning, "mainnet")).toBeUndefined();
    // A state without them is not ours.
    expect(readHandover({ lookalike: valid }, poisoning, "regtest")).toBeUndefined();
  });

  it("says there were more only when the list is full", () => {
    const handed = raw({
      from: VICTIM,
      found: [own],
      count: 1_000_000,
      txid: TXID,
      network: "regtest",
    });
    expect(readHandover(handed, poisoning, "regtest")).toBeUndefined();
  });

  it("says there were more only of a full list whose every finding holds", () => {
    // Sixty-four copies of one finding claiming a sixty-fifth: no row writes an address twice.
    const copies = raw({
      from: VICTIM,
      found: Array.from({ length: HANDOVER_MAX }, () => own),
      count: HANDOVER_MAX + 1,
    });
    expect(readHandover(copies, poisoning, "regtest")).toBeUndefined();
    // A full list of which only one holds: that one is marked, and nothing is said of more.
    const padded = raw({
      from: VICTIM,
      found: [own, ...Array.from({ length: HANDOVER_MAX - 1 }, () => ({ ...pair, here: PAYEE }))],
      count: HANDOVER_MAX + 1,
    });
    expect(readHandover(padded, poisoning, "regtest")).toStrictEqual({
      from: VICTIM,
      found: [own],
      more: false,
    });
  });

  it("says there were more only when the transaction names more than are marked", () => {
    const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const ground = (n: number) =>
      Array.from({ length: n }, (_, i): Lookalike => {
        const a = BECH32[i % 32] ?? "q";
        const b = BECH32[Math.floor(i / 32)] ?? "q";
        return {
          here: `bcrt1q92q${a}${b}${"q".repeat(28)}pmmx6`,
          like: VICTIM,
          own: true,
          head: 2,
          tail: 4,
          prefix: 6,
        };
      });
    const full = ground(HANDOVER_MAX);
    const claiming = (count: number, t: Transaction) =>
      read(raw({ from: VICTIM, found: full, count, txid: t.txid, network: "regtest" }), t);
    // Every address the transaction names beside the reader's own is marked: none was left out,
    // whatever the count says. The findings themselves hold, so they stay.
    const exact = tx([VICTIM], [VICTIM, ...full.map((l) => l.here)]);
    expect(claiming(HANDOVER_MAX + 1, exact)).toStrictEqual({
      from: VICTIM,
      found: full,
      more: false,
    });
    // One more address there, of any kind the rule compares: a sixty-fifth is possible, a
    // sixty-sixth is not.
    const another = tx([CUSTOMER], [VICTIM, ...full.map((l) => l.here)]);
    expect(claiming(HANDOVER_MAX + 1, another)?.more).toBe(true);
    expect(claiming(HANDOVER_MAX + 2, another)?.more).toBe(false);
    // An address the rule never compares (pay to anchor) is no lookalike left out.
    const anchored = tx([VICTIM], [VICTIM, "bcrt1pfeesnyr2tx", ...full.map((l) => l.here)]);
    expect(claiming(HANDOVER_MAX + 1, anchored)?.more).toBe(false);
  });

  it("refuses a finding that hides a lookalike of the reader's own address behind another's", () => {
    // The lookalike agrees with the reader's address on two and four, and with this one on three
    // and four: the address page says it resembles the reader's, and so must what it hands over.
    const other = `bcrt1q92t${"a".repeat(31)}mmx6`;
    const hidden = raw({
      from: VICTIM,
      found: [{ here: VICTIM_LOOKALIKE, like: other, own: false, head: 3, tail: 4, prefix: 6 }],
      count: 1,
    });
    expect(readHandover(hidden, poisoning, "regtest")).toBeUndefined();
    // Said as it is, it is taken.
    expect(
      readHandover(raw({ from: VICTIM, found: [own], count: 1 }), poisoning, "regtest"),
    ).toStrictEqual({ from: VICTIM, found: [own], more: false });
  });
});
