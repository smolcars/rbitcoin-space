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
  ...(JSON.parse(handoverState(from, found)) as object),
  _depth: 3,
});
/** A handover built by hand, for what the writer would never write. */
const raw = (h: unknown) => ({ lookalike: h });
const valid = { from: VICTIM, found: [own], count: 1 };

describe("readHandover", () => {
  it("reads back what a row wrote, beside the router's own keys", () => {
    expect(readHandover(state(VICTIM, [own, pair]), poisoning)).toStrictEqual({
      from: VICTIM,
      found: [own, pair],
      more: false,
    });
  });

  it("puts the reader's own address's lookalikes first", () => {
    expect(readHandover(state(VICTIM, [pair, own]), poisoning)?.found).toStrictEqual([own, pair]);
  });

  it("finds an address among the inputs' previous outputs too", () => {
    const spent = tx([VICTIM_LOOKALIKE], [CUSTOMER]);
    expect(readHandover(state(VICTIM, [own]), spent)?.found).toStrictEqual([own]);
  });

  it("caps what a row writes, and says there were more", () => {
    const many = Array.from({ length: HANDOVER_MAX + 36 }, () => own);
    const written = JSON.parse(handoverState(VICTIM, many)) as { lookalike: { found: unknown[] } };
    expect(written.lookalike.found).toHaveLength(HANDOVER_MAX);
    // One distinct address, said once.
    expect(readHandover(written, poisoning)).toStrictEqual({
      from: VICTIM,
      found: [own],
      more: true,
    });
  });

  it("ignores an oversized list whole", () => {
    const found = Array.from({ length: HANDOVER_MAX + 1 }, () => own);
    expect(
      readHandover(raw({ from: VICTIM, found, count: found.length }), poisoning),
    ).toBeUndefined();
  });

  it("ignores an address this transaction does not name", () => {
    const elsewhere = tx([CUSTOMER], [VICTIM, PAYEE]);
    expect(readHandover(state(VICTIM, [own, pair]), elsewhere)).toBeUndefined();
    // And keeps those it does name.
    const some = tx([CUSTOMER], [PAYEE_LOOKALIKE]);
    expect(readHandover(state(VICTIM, [own, pair]), some)?.found).toStrictEqual([pair]);
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
      expect(readHandover(s, poisoning)).toBeUndefined();
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
      expect(readHandover(raw({ ...valid, found: [bad] }), poisoning)).toBeUndefined();
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
      expect(readHandover(raw({ ...valid, found: [bad] }), poisoning)).toBeUndefined();
    }
  });
});
