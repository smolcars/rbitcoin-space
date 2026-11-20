import { describe, expect, it } from "vitest";
import { pinnedPath, readAt, readPinned, readTip, readTyped, unusedThen } from "./asof";

const HASH = "0".repeat(19) + "320283a032748cef8227873ff4872689bf23f1cda83a5".padStart(45, "0");
const NOW = Date.UTC(2026, 10, 20) / 1000;

describe("readAt", () => {
  it("is live without the parameter", () => {
    expect(readAt(undefined)).toStrictEqual({ kind: "now" });
  });

  it("reads a height in digits within u32", () => {
    expect(readAt("840000")).toStrictEqual({ kind: "height", height: 840_000 });
    expect(readAt("0")).toStrictEqual({ kind: "height", height: 0 });
    expect(readAt("4294967295")).toStrictEqual({ kind: "height", height: 4_294_967_295 });
    expect(readAt(["12", "13"])).toStrictEqual({ kind: "height", height: 12 });
  });

  it("keeps anything else as text to say it is not a height", () => {
    for (const text of ["", "abc", "-1", "1.5", "4294967296", " 12", "12a", HASH, "1e3"]) {
      expect(readAt(text)).toStrictEqual({ kind: "invalid", text });
    }
  });
});

describe("readTyped", () => {
  it("reads a height, with group spaces or commas as the site and readers write them", () => {
    expect(readTyped("840000", NOW)).toStrictEqual({ kind: "height", height: 840_000 });
    expect(readTyped(" 840 000 ", NOW)).toStrictEqual({ kind: "height", height: 840_000 });
    expect(readTyped("840,000", NOW)).toStrictEqual({ kind: "height", height: 840_000 });
  });

  it("reads a date as the palette does: the end of that day, UTC", () => {
    expect(readTyped("2024-04-20", NOW)).toMatchObject({
      kind: "date",
      moment: { at: Date.UTC(2024, 3, 20, 23, 59, 59) / 1000, label: "20 Apr 2024" },
    });
    expect(readTyped("20 April 2024", NOW).kind).toBe("date");
  });

  it("says when nothing or neither was typed", () => {
    expect(readTyped("  ", NOW)).toStrictEqual({ kind: "empty" });
    expect(readTyped("yesterday", NOW)).toStrictEqual({ kind: "invalid" });
    expect(readTyped("04/05/2024", NOW)).toStrictEqual({ kind: "invalid" });
    expect(readTyped("99999999999", NOW)).toStrictEqual({ kind: "invalid" });
  });
});

describe("readPinned", () => {
  const block = { id: HASH, height: 840_000, timestamp: 1_713_571_767 };

  it("takes the block when it is the one the height named", () => {
    expect(readPinned(HASH, block, 840_000)).toStrictEqual({
      hash: HASH,
      height: 840_000,
      time: 1_713_571_767,
    });
  });

  it("refuses a hash or block that does not match, or is not well formed", () => {
    expect(readPinned(HASH.toUpperCase(), block, 840_000)).toBeUndefined();
    expect(readPinned(`${HASH}\n`, block, 840_000)).toBeUndefined();
    expect(readPinned(HASH, { ...block, height: 839_999 }, 840_000)).toBeUndefined();
    expect(readPinned(HASH, { ...block, id: "f".repeat(64) }, 840_000)).toBeUndefined();
    expect(readPinned(HASH, { ...block, timestamp: "1713571767" }, 840_000)).toBeUndefined();
    expect(readPinned(HASH, { ...block, timestamp: -1 }, 840_000)).toBeUndefined();
    expect(readPinned(HASH, null, 840_000)).toBeUndefined();
    expect(readPinned(42, block, 840_000)).toBeUndefined();
  });
});

describe("the rest", () => {
  it("reads a tip height, or nothing", () => {
    expect(readTip("976787\n")).toBe(976_787);
    expect(readTip("tip")).toBeUndefined();
    expect(readTip(5)).toBeUndefined();
  });

  it("pins a path with ?asof=", () => {
    expect(pinnedPath("/address/x/txs/chain", HASH)).toBe(`/address/x/txs/chain?asof=${HASH}`);
  });

  it("knows an address not used by then", () => {
    const stats = (tx_count: number) => ({
      chain_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 3,
      },
    });
    expect(unusedThen(stats(0))).toBe(true);
    expect(unusedThen(stats(1))).toBe(false);
  });
});
