import { describe, expect, it, vi } from "vitest";
import type { Outspend, TxStatus } from "../../lib/esplora";
import type { BlockSummary, FeeRates } from "../../lib/summary";
import {
  childInBlock,
  feeVerdict,
  formatMultiple,
  judgeFee,
  PARENT_CHECKS,
  parentsOf,
  verdictDetail,
  verdictText,
  verdictTitle,
} from "./verdict";

const BLOCK = "00000000000000000000e13ad5e424f6ba7208b0c1a9a687e9ccc4d62b3b094c";
const OTHER = "0000000000000000000159affbb5acfb646390efa277f0feeabc2429b5388c36";
const P1 = "a".repeat(64);
const P2 = "b".repeat(64);

const rates = (over: Partial<FeeRates> = {}): FeeRates => ({
  min: 0,
  p10: 0.12,
  p25: 0.12,
  median: 1.08,
  p75: 2,
  p90: 3.15,
  max: 62.1,
  ...over,
});
const summary = (fee_rate: FeeRates | null = rates()): BlockSummary => ({
  id: BLOCK,
  height: 975_511,
  tx_count: 4198,
  fees: 1_475_029,
  vsize: 999_391,
  weight: 3_991_349,
  fee_rate,
  fee_bands: Array.from({ length: 12 }, () => 0),
});
const mined = (hash: string): TxStatus => ({ confirmed: true, block_hash: hash, block_height: 1 });
const spentIn = (hash: string): Outspend => ({
  spent: true,
  txid: P2,
  vin: 0,
  status: mined(hash),
});

describe("feeVerdict", () => {
  it("says at, near or a multiple by the low end", () => {
    expect(feeVerdict(0.12, 0.12, 1)?.kind).toBe("at");
    expect(feeVerdict(0.05, 0.12, 1)?.kind).toBe("at");
    expect(feeVerdict(0.2, 0.12, 1)?.kind).toBe("near");
    expect(feeVerdict(0.24, 0.12, 1)?.kind).toBe("above");
    expect(feeVerdict(3, 1.5, 1)).toStrictEqual({ kind: "above", ratio: 2, low: 1.5, height: 1 });
  });

  it("calls a rate that prints the same as the low end at it, not near it", () => {
    // 0.1249 and 0.1199 both print 0.12.
    expect(feeVerdict(0.1249, 0.1199, 1)?.kind).toBe("at");
    expect(feeVerdict(12.04, 12, 1)?.kind).toBe("at");
    expect(feeVerdict(0.126, 0.1199, 1)?.kind).toBe("near");
  });

  it("compares printed figures across their precisions", () => {
    // 12.5 prints with one decimal, 0.12 with two: compared as numbers, not digit strings.
    expect(feeVerdict(12.5, 0.12, 1)?.kind).toBe("above");
    expect(feeVerdict(0.12, 12.5, 1)?.kind).toBe("at");
  });

  it("judges nothing it cannot", () => {
    expect(feeVerdict(1, 0, 1)).toBeUndefined();
    expect(feeVerdict(1, undefined, 1)).toBeUndefined();
    expect(feeVerdict(undefined, 1, 1)).toBeUndefined();
    expect(feeVerdict(Number.NaN, 1, 1)).toBeUndefined();
    expect(feeVerdict(1, Number.POSITIVE_INFINITY, 1)).toBeUndefined();
    expect(feeVerdict(-1, 1, 1)).toBeUndefined();
  });

  it("keeps a zero-fee transaction at the low end", () => {
    expect(feeVerdict(0, 0.12, 1)?.kind).toBe("at");
  });
});

describe("formatMultiple", () => {
  it("rounds down, one decimal under ten, whole and grouped above", () => {
    expect(formatMultiple(2)).toBe("2.0×");
    expect(formatMultiple(2.49)).toBe("2.4×");
    expect(formatMultiple(9.99)).toBe("9.9×");
    expect(formatMultiple(10)).toBe("10×");
    expect(formatMultiple(37.9)).toBe("37×");
    expect(formatMultiple(76_923.07)).toBe("76 923×");
    expect(formatMultiple(Number.NaN)).toBe("–");
  });
});

describe("the words", () => {
  it("says the multiple beside the rate and in full in its note", () => {
    const v = feeVerdict(1, 0.013, 976_475);
    if (!v) throw new Error("no verdict");
    expect(verdictText(v)).toBe("76× its block's low end");
    expect(verdictTitle(v)).toBe("76 times its block's low end");
    expect(verdictDetail(v)).toBe(
      "The cheapest tenth of block 976 475, by size, paid 0.01 sat/vB or less. Compared with this transaction's own rate.",
    );
  });

  it("names the quiet states without a number", () => {
    const at = feeVerdict(0.1, 0.12, 1);
    const near = feeVerdict(0.2, 0.12, 1);
    if (!at || !near) throw new Error("no verdict");
    expect(verdictText(at)).toBe("At its block's low end");
    expect(verdictText(near)).toBe("Near its block's low end");
    expect(verdictTitle(near)).toBe("Less than 2 times its block's low end");
  });

  it("formats large rates and low ends as the site prints them", () => {
    const v = feeVerdict(1007.46, 3.006, 1);
    if (!v) throw new Error("no verdict");
    expect(verdictText(v)).toBe("335× its block's low end");
  });
});

describe("childInBlock", () => {
  it("finds a child mined in the same block", () => {
    expect(childInBlock([{ spent: false }, spentIn(BLOCK)], BLOCK)).toBe(true);
    expect(childInBlock([{ spent: false }, spentIn(OTHER)], BLOCK)).toBe(false);
    expect(childInBlock([], BLOCK)).toBe(false);
  });

  it("cannot tell from a list it does not have, or a spend not known to be mined", () => {
    expect(childInBlock(undefined, BLOCK)).toBeUndefined();
    expect(childInBlock(null, BLOCK)).toBeUndefined();
    expect(
      childInBlock([{ spent: true, txid: P2, status: { confirmed: false } }], BLOCK),
    ).toBeUndefined();
    expect(childInBlock([{ spent: true, txid: P2 }], BLOCK)).toBeUndefined();
  });
});

describe("parentsOf", () => {
  it("lists each parent once and no coinbase input", () => {
    expect(
      parentsOf([
        { txid: P1, is_coinbase: false },
        { txid: P1, is_coinbase: false },
        { txid: P2, is_coinbase: false },
        { txid: "0".repeat(64), is_coinbase: true },
      ]),
    ).toStrictEqual([P1, P2]);
  });
});

describe("judgeFee", () => {
  const judge = (over: {
    rate?: number;
    summary?: BlockSummary | undefined;
    spends?: Outspend[] | null;
    parents?: string[];
    status?: (txid: string) => Promise<TxStatus>;
  }) => {
    const status = vi.fn<(txid: string) => Promise<TxStatus>>(
      over.status ?? (async () => mined(OTHER)),
    );
    const result = judgeFee({
      rate: over.rate ?? 1,
      block: BLOCK,
      parents: over.parents ?? [P1],
      summary: async () => ("summary" in over ? over.summary : summary()),
      spends: async () => ("spends" in over ? over.spends : [{ spent: false }]),
      status,
    });
    return { result, status };
  };

  it("gives a multiple once no relative was mined beside it", async () => {
    const { result, status } = judge({});
    expect((await result)?.kind).toBe("above");
    expect(status).toHaveBeenCalledWith(P1);
  });

  it("shows nothing for a block without rates, a low end of 0, or the wrong block", async () => {
    await expect(judge({ summary: summary(null) }).result).resolves.toBeUndefined();
    await expect(judge({ summary: summary(rates({ p10: 0 })) }).result).resolves.toBeUndefined();
    await expect(judge({ summary: undefined }).result).resolves.toBeUndefined();
    await expect(judge({ summary: { ...summary(), id: OTHER } }).result).resolves.toBeUndefined();
  });

  it("shows nothing when a child in the block may have paid for it, or spends are unknown", async () => {
    await expect(judge({ rate: 0.1, spends: [spentIn(BLOCK)] }).result).resolves.toBeUndefined();
    await expect(judge({ spends: [spentIn(BLOCK)] }).result).resolves.toBeUndefined();
    await expect(judge({ spends: null }).result).resolves.toBeUndefined();
  });

  it("shows nothing above the low end when it may have paid for a parent in the block", async () => {
    await expect(judge({ status: async () => mined(BLOCK) }).result).resolves.toBeUndefined();
  });

  it("keeps 'at the low end' without asking the parents: a package's rate would be lower still", async () => {
    const { result, status } = judge({ rate: 0.1, status: async () => mined(BLOCK) });
    expect((await result)?.kind).toBe("at");
    expect(status).not.toHaveBeenCalled();
  });

  it("asks no more than its cap of parents, and shows nothing past it", async () => {
    const many = Array.from({ length: PARENT_CHECKS + 1 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const { result, status } = judge({ parents: many });
    await expect(result).resolves.toBeUndefined();
    expect(status).not.toHaveBeenCalled();
  });

  it("asks nothing more once the summary rules a verdict out", async () => {
    const spends = vi.fn<() => Promise<Outspend[]>>(async () => []);
    const status = vi.fn<(txid: string) => Promise<TxStatus>>(async () => mined(OTHER));
    const v = judgeFee({
      rate: 1,
      block: BLOCK,
      parents: [P1],
      summary: async () => summary(null),
      spends,
      status,
    });
    await expect(v).resolves.toBeUndefined();
    expect(spends).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
