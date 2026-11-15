import { describe, expect, it } from "vitest";
import { SAMPLE } from "./testdata";
import { badges, counts, isVtxoId, lifeElapsed, parseVtxo, readVtxoId, roughTime } from "./vtxo";

const TXID = "5452a1e4a4b3c787f44bd3a2fc1ac2af0d378d8fe86eff08ab0317db671ba9ec";

describe("vtxo ids", () => {
  it("reads txid:vout and nothing else", () => {
    expect(readVtxoId(` ${TXID}:0 `)).toBe(`${TXID}:0`);
    expect(readVtxoId(`${TXID.toUpperCase()}:12`)).toBe(`${TXID}:12`);
    for (const bad of [
      "",
      TXID,
      `${TXID}:`,
      `${TXID}:01`,
      `${TXID}:-1`,
      `${TXID}:4294967296`,
      `${TXID.slice(1)}:0`,
      `${TXID}:0x`,
    ]) {
      expect([bad, isVtxoId(bad)]).toStrictEqual([bad, false]);
    }
    expect(isVtxoId(`${TXID}:4294967295`)).toBe(true);
  });
});

describe("parseVtxo", () => {
  it("reads the server's answer", () => {
    const v = parseVtxo(SAMPLE);
    expect(v?.amount).toBe(10_000);
    expect(v?.txs.map((t) => t.kind)).toStrictEqual([
      "branch",
      "branch",
      "leaf",
      "transfer",
      "transfer",
    ]);
    expect(v && counts(v)).toStrictEqual({ tree: 3, transfers: 2 });
  });

  it("refuses anything malformed", () => {
    const broken = [
      null,
      [],
      { ...SAMPLE, id: "<b>" },
      { ...SAMPLE, amount: -1 },
      { ...SAMPLE, server_pubkey: "04ab" },
      { ...SAMPLE, txs: [{ ...SAMPLE.txs[0], txid: "data:text/html,x" }] },
      { ...SAMPLE, txs: [{ ...SAMPLE.txs[0], kind: "root" }] },
      { ...SAMPLE, signatures: "yes" },
      { ...SAMPLE, anchor: { ...SAMPLE.anchor, found: "true" } },
    ];
    for (const b of broken) expect(parseVtxo(b)).toBeNull();
  });
});

describe("badges", () => {
  it("says what holds", () => {
    const v = parseVtxo(SAMPLE);
    if (!v) throw new Error("the sample did not parse");
    expect(badges(v, 100_000, [])).toStrictEqual(["signed", "unsettled"]);
    expect(badges(v, v.expiryHeight - 10, [{ state: "mempool" }])).toStrictEqual([
      "signed",
      "exiting",
      "unsettled",
      "expiring",
    ]);
    expect(badges(v, v.expiryHeight, [])).toContain("expired");
    expect(badges({ ...v, rebuilt: false }, undefined, [])[0]).toBe("unverified");
    expect(badges({ ...v, expiryBound: false }, undefined, [])[0]).toBe("unverified");
    expect(badges({ ...v, signatures: "missing" }, undefined, [])[0]).toBe("unsigned");
  });
});

describe("times", () => {
  it("rounds blocks to a reading", () => {
    expect(roughTime(12)).toBe("≈ 2 h");
    expect(roughTime(144)).toBe("≈ 1 day");
    expect(roughTime(6)).toBe("≈ 60 min");
    expect(roughTime(4320)).toBe("≈ 30 days");
  });
  it("measures the life used", () => {
    expect(lifeElapsed(100, 150, 200)).toBe(0.5);
    expect(lifeElapsed(100, 300, 200)).toBe(1);
    expect(lifeElapsed(undefined, 50, 200)).toBe(0);
  });
});
