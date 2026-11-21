import { describe, expect, it } from "vitest";
import {
  compareNow,
  nextChange,
  PAGE_ROWS,
  pinnedPath,
  previousChange,
  readAt,
  readPinned,
  readTip,
  readTyped,
  unusedThen,
} from "./asof";

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
    expect(readTyped("2030-02-30", NOW)).toStrictEqual({ kind: "invalid" });
  });

  it("says a day not begun yet is to come, however far ahead, but reads today as a date", () => {
    expect(readTyped("2030-01-01", NOW)).toStrictEqual({ kind: "future", label: "1 Jan 2030" });
    expect(readTyped("2026-11-21", NOW)).toStrictEqual({ kind: "future", label: "21 Nov 2026" });
    // NOW is the start of 20 Nov 2026: that day has begun, so its newest block is asked.
    expect(readTyped("2026-11-20", NOW).kind).toBe("date");
    expect(readTyped("2026-11-20 00:30", NOW)).toStrictEqual({
      kind: "future",
      label: "20 Nov 2026, 00:30",
    });
  });

  it("reads the minute under way as begun, not still to come", () => {
    // 12:30:15 on 20 Nov 2026: 12:30 has begun, 12:31 has not; with seconds, to the second.
    const t = Date.UTC(2026, 10, 20, 12, 30, 15) / 1000;
    expect(readTyped("2026-11-20 12:30Z", t).kind).toBe("date");
    expect(readTyped("2026-11-20 12:31", t).kind).toBe("future");
    expect(readTyped("2026-11-20 12:30:10", t).kind).toBe("date");
    expect(readTyped("2026-11-20 12:30:20", t).kind).toBe("future");
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

describe("previousChange", () => {
  it("leads to the change before the latest one by the block", () => {
    expect(previousChange([975_000, 975_000, 974_257, 974_100], false)).toStrictEqual({
      kind: "change",
      height: 974_257,
    });
  });

  it("leads to the block before the first transaction when the page is the whole history", () => {
    expect(previousChange([800_010, 800_010], true)).toStrictEqual({
      kind: "before-first",
      height: 800_009,
    });
  });

  it("cannot say when a page short of the whole history holds one block only, or nothing", () => {
    expect(
      previousChange(
        Array.from({ length: PAGE_ROWS }, () => 900_000),
        false,
      ),
    ).toBeUndefined();
    expect(previousChange([], false)).toBeUndefined();
  });

  it("knows a full page is the whole history when the totals say so", () => {
    // 25 transactions, all in its first block: the step back is to the block before it.
    expect(
      previousChange(
        Array.from({ length: PAGE_ROWS }, () => 900_000),
        true,
      ),
    ).toStrictEqual({
      kind: "before-first",
      height: 899_999,
    });
  });

  it("offers no step back from a first transaction in block 0: nothing precedes it", () => {
    expect(previousChange([0], true)).toStrictEqual({ kind: "none" });
    expect(previousChange([5, 0, 0], true)).toStrictEqual({ kind: "change", height: 0 });
  });
});

describe("nextChange", () => {
  it("is the first block after the one shown, when the page reaches back to it", () => {
    expect(nextChange([976_100, 975_400, 975_010, 975_000], false, 975_000, true)).toStrictEqual({
      kind: "change",
      height: 975_010,
    });
    expect(nextChange([976_100, 975_400], true, 975_000, true)).toStrictEqual({
      kind: "change",
      height: 975_400,
    });
  });

  it("is the first use for an address with no history by then", () => {
    expect(nextChange([976_100, 975_400], true, 800_000, false)).toStrictEqual({
      kind: "first",
      height: 975_400,
    });
  });

  it("says nothing changed since when no confirmed row is later", () => {
    expect(nextChange([975_000, 974_000], false, 975_000, true)).toStrictEqual({ kind: "none" });
  });

  it("knows a full page holds every later transaction when it holds as many as came since", () => {
    // One transaction by 900 000 and 25 after it: the page of 25 is all of them.
    const page = Array.from({ length: PAGE_ROWS }, (_, i) => 976_000 - i);
    expect(nextChange(page, false, 900_000, true, PAGE_ROWS)).toStrictEqual({
      kind: "change",
      height: 976_000 - (PAGE_ROWS - 1),
    });
    expect(nextChange(page, false, 900_000, true, PAGE_ROWS + 1)).toBeUndefined();
  });

  it("cannot say when rows short of the whole history are all later than the block", () => {
    const page = Array.from({ length: PAGE_ROWS }, (_, i) => 976_000 - i);
    expect(nextChange(page, false, 900_000, true)).toBeUndefined();
    expect(nextChange([], false, 900_000, true)).toBeUndefined();
  });
});

describe("compareNow", () => {
  const part = (tx: number, funded: number, spent: number, fc = tx, sc = 0) => ({
    tx_count: tx,
    funded_txo_count: fc,
    funded_txo_sum: funded,
    spent_txo_count: sc,
    spent_txo_sum: spent,
  });
  const then = part(2, 50, 20, 2, 1);
  const at = { height: 975, hash: "a".repeat(64) };
  const above = { height: 980, hash: "b".repeat(64) };

  it("compares a present stamped above the block: counts the transactions since", () => {
    expect(compareNow(then, part(5, 90, 20, 4, 1), above, at)).toStrictEqual({
      kind: "later",
      transactions: 3,
      balance: 70,
    });
    expect(compareNow(then, part(2, 50, 20, 2, 1), above, at)).toStrictEqual({
      kind: "same",
      balance: 30,
    });
  });

  it("compares a present stamped with the block itself only when every total is the same", () => {
    expect(compareNow(then, part(2, 50, 20, 2, 1), at, at)).toStrictEqual({
      kind: "same",
      balance: 30,
    });
    // The same block cannot hold more than itself: a reply from elsewhere.
    expect(compareNow(then, part(3, 60, 20, 3, 1), at, at)).toStrictEqual({ kind: "unknown" });
  });

  it("will not compare without a stamp, or at the block's height under another hash", () => {
    expect(compareNow(then, part(3, 60, 20, 3, 1), undefined, at)).toStrictEqual({
      kind: "unknown",
    });
    const rival = { height: 975, hash: "c".repeat(64) };
    expect(compareNow(then, part(2, 50, 20, 2, 1), rival, at)).toStrictEqual({ kind: "unknown" });
    expect(compareNow(then, part(3, 60, 20, 3, 1), rival, at)).toStrictEqual({ kind: "unknown" });
  });

  it("will not compare a present stamped below the block", () => {
    const below = { height: 974, hash: "d".repeat(64) };
    expect(compareNow(then, part(5, 90, 20, 4, 1), below, at)).toStrictEqual({ kind: "unknown" });
  });

  it("will not compare, above the block, totals no later state of one chain could have", () => {
    // Fewer transactions; as many with other sums; a total that shrank.
    expect(compareNow(then, part(1, 50, 0, 1, 0), above, at)).toStrictEqual({ kind: "unknown" });
    expect(compareNow(then, part(2, 60, 20, 2, 1), above, at)).toStrictEqual({ kind: "unknown" });
    expect(compareNow(then, part(4, 40, 20, 4, 1), above, at)).toStrictEqual({ kind: "unknown" });
  });
});
