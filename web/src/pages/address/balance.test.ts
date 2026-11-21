import { describe, expect, it } from "vitest";
import { ApiError, type Stamped } from "../../lib/api";
import type { TxSummary } from "../../lib/esplora";
import {
  advance,
  type History,
  loadHistory,
  MAX_PAGES,
  MAX_ROWS,
  points,
  readRows,
  SUMMARY_PAGE,
} from "./balance";

const txid = (n: number) => n.toString(16).padStart(64, "0");
/** Row `n` in block `height`, at ten minutes a block. */
const row = (n: number, value: number, height = n): TxSummary => ({
  txid: txid(n),
  value,
  height,
  time: 1_700_000_000 + height * 600,
  tx_position: 1,
});
const TIP = "f".repeat(64);
const BASE = "/address/bc1qme";

/** A node with `rows` (newest first) and the totals it gives; records every path asked. */
function node(rows: TxSummary[], balance = 0, count = rows.length) {
  const asked: string[] = [];
  const fetch = (path: string): Promise<Stamped<unknown>> => {
    asked.push(path);
    const tip = { hash: TIP, height: 1000 };
    const page = /\/txs\/summary(?:\/(\w+))?/.exec(path);
    if (page === null) {
      return Promise.resolve({
        tip,
        value: {
          chain_stats: {
            funded_txo_sum: balance,
            spent_txo_sum: 0,
            tx_count: count,
            funded_txo_count: 0,
            spent_txo_count: 0,
          },
        },
      });
    }
    const from = page[1] === undefined ? 0 : rows.findIndex((r) => r.txid === page[1]) + 1;
    return Promise.resolve({ tip, value: rows.slice(from, from + SUMMARY_PAGE) });
  };
  return { asked, fetch };
}

const history = (rows: TxSummary[], complete = true, balance?: number): History => ({
  rows,
  complete,
  balance: balance ?? rows.reduce((s, r) => s + r.value, 0),
  total: rows.length,
});

describe("points", () => {
  it("steps up on a receive and down on a spend, oldest first", () => {
    const pts = points(history([row(2, -30_000), row(1, 50_000)]));
    expect(pts.map((p) => [p.height, p.balance, p.change])).toStrictEqual([
      [1, 50_000, 50_000],
      [2, 20_000, -30_000],
    ]);
  });

  it("makes one step of a block that receives and spends", () => {
    const pts = points(history([row(3, -10_000, 2), row(2, 40_000, 2), row(1, 5000)]));
    expect(pts.map((p) => [p.height, p.balance, p.change])).toStrictEqual([
      [1, 5000, 5000],
      [2, 35_000, 30_000],
    ]);
  });

  it("takes a transaction that spends and pays change back as its net change", () => {
    // Spent 50 000 and got 29 000 back: the summary row is the net.
    const pts = points(history([row(2, -21_000), row(1, 50_000)]));
    expect(pts.at(-1)?.balance).toBe(29_000);
    expect(pts.at(-1)?.change).toBe(-21_000);
  });

  it("leaves the change of a partial history's oldest block unknown", () => {
    const pts = points(history([row(3, 1000), row(2, 2000)], false, 10_000));
    expect(pts.map((p) => [p.balance, p.change])).toStrictEqual([
      [9000, null],
      [10_000, 1000],
    ]);
  });

  it("never lets time run backwards, though a block may claim an earlier time", () => {
    const late = { ...row(1, 1000), time: 1_700_009_000 };
    const pts = points(history([row(2, 1000), late]));
    expect(pts[1]?.time).toBe(pts[0]?.time);
  });
});

describe("readRows", () => {
  it("refuses an answer it does not understand", () => {
    expect(() => readRows({ rows: [] })).toThrow(TypeError);
    expect(() => readRows([{ ...row(1, 1), value: "1" }])).toThrow(TypeError);
    expect(() => readRows([{ ...row(1, 1), txid: "<b>" }])).toThrow(TypeError);
    expect(readRows([row(1, 1)])).toHaveLength(1);
  });
});

describe("loadHistory", () => {
  it("loads a short history whole, summed from nothing, with no totals asked", async () => {
    const n = node([row(2, -1000), row(1, 3000)]);
    const h = await loadHistory(BASE, n.fetch);
    expect(h).toStrictEqual({
      rows: [row(2, -1000), row(1, 3000)],
      complete: true,
      balance: 2000,
      total: 2,
    });
    expect(n.asked).toStrictEqual([`${BASE}/txs/summary`]);
  });

  it("leaves an unconfirmed change to the page's own figures", async () => {
    // The node lists only confirmed rows; one without a block would not be drawn.
    const h = await loadHistory(BASE, node([row(9, 7000, 0), row(1, 3000)]).fetch);
    expect(h.rows).toStrictEqual([row(1, 3000)]);
    expect(h.balance).toBe(3000);
  });

  it("pages through, each page as of the first's block", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(30 - i, 100));
    const n = node(rows);
    const h = await loadHistory(BASE, n.fetch);
    expect(h.complete).toBe(true);
    expect(h.balance).toBe(3000);
    expect(n.asked).toStrictEqual([
      `${BASE}/txs/summary`,
      `${BASE}/txs/summary/${txid(6)}?asof=${TIP}`,
    ]);
  });

  it(`asks at most ${MAX_PAGES} pages, then anchors to the totals as of the same block`, async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(5000 - i, 100));
    const n = node(rows, 123_456, 5000);
    const h = await loadHistory(BASE, n.fetch);
    expect(n.asked.filter((p) => p.includes("/txs/summary"))).toHaveLength(MAX_PAGES);
    expect(n.asked).toHaveLength(MAX_PAGES + 1);
    expect(n.asked.at(-1)).toBe(`${BASE}?asof=${TIP}`);
    expect(h.rows).toHaveLength(MAX_ROWS);
    expect(h).toMatchObject({ complete: false, balance: 123_456, total: 5000 });
    // The line ends at the true balance, however much of the history is loaded.
    expect(points(h).at(-1)?.balance).toBe(123_456);
    expect(points(h)[0]?.balance).toBe(123_456 - (MAX_ROWS - 1) * 100);
  });

  it("keeps the pages it has when a later one fails, anchored all the same", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(300 - i, 100));
    const n = node(rows, 77_777, 300);
    const flaky = (p: string) =>
      p.includes(`/txs/summary/${txid(251)}`) ? Promise.reject(new Error("504")) : n.fetch(p);
    const h = await loadHistory(BASE, flaky);
    expect(h).toMatchObject({ complete: false, balance: 77_777, total: 300 });
    expect(h.rows).toHaveLength(50);
  });

  it("strict, a later page that fails fails the whole: a lookup must not read it as a cap", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(50 - i, 100));
    const n = node(rows);
    const flaky = (p: string) =>
      p.includes(`/txs/summary/${txid(26)}`) ? Promise.reject(new Error("504")) : n.fetch(p);
    await expect(loadHistory(BASE, flaky, MAX_PAGES, undefined, undefined, true)).rejects.toThrow(
      "504",
    );
  });

  it("as of a block, a later page answered 404 means the block left the chain: no partial chart", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(300 - i, 100));
    const n = node(rows, 77_777, 300);
    const pinned = "a".repeat(64);
    const gone = (p: string) =>
      p.includes(`/txs/summary/${txid(276)}`)
        ? Promise.reject(new ApiError(404, "Not found."))
        : n.fetch(p);
    await expect(loadHistory(BASE, gone, MAX_PAGES, undefined, pinned)).rejects.toMatchObject({
      status: 404,
    });
    // Its totals are never asked: they could come from before the block left.
    expect(n.asked.some((p) => p === `${BASE}?asof=${pinned}`)).toBe(false);
    // Any other failure of a later page keeps the pages already in, anchored, as before.
    const slow = (p: string) =>
      p.includes(`/txs/summary/${txid(276)}`)
        ? Promise.reject(new ApiError(504, "Request timed out."))
        : n.fetch(p);
    const h = await loadHistory(BASE, slow, MAX_PAGES, undefined, pinned);
    expect(h).toMatchObject({ complete: false, balance: 77_777, total: 300 });
    expect(h.rows).toHaveLength(25);
  });

  it("knows a history of exactly the cap is whole when the totals agree", async () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => row(MAX_ROWS - i, 100));
    const h = await loadHistory(BASE, node(rows, MAX_ROWS * 100, MAX_ROWS).fetch);
    expect(h.complete).toBe(true);
  });

  it("anchors a page already in on its own, with one request, after a gap too wide to join", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(5000 - i, 100));
    const n = node(rows, 99_999, 5000);
    const first = await n.fetch(`${BASE}/txs/summary`);
    n.asked.length = 0;
    const h = await loadHistory(BASE, n.fetch, 1, first);
    expect(n.asked).toStrictEqual([`${BASE}?asof=${TIP}`]);
    expect(h).toMatchObject({ complete: false, balance: 99_999, total: 5000 });
    expect(h.rows).toHaveLength(SUMMARY_PAGE);
  });

  it("pins every request to the block it is given, the first page too, stamped or not", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(300 - i, 100));
    const n = node(rows, 55_555, 300);
    const pinned = "a".repeat(64);
    const unstamped = (p: string) => n.fetch(p).then((r) => ({ ...r, tip: undefined }));
    const h = await loadHistory(BASE, unstamped, 2, undefined, pinned);
    expect(n.asked).toStrictEqual([
      `${BASE}/txs/summary?asof=${pinned}`,
      `${BASE}/txs/summary/${txid(276)}?asof=${pinned}`,
      `${BASE}?asof=${pinned}`,
    ]);
    expect(h).toMatchObject({ complete: false, balance: 55_555, total: 300 });
  });

  it("refuses to anchor a partial history to totals of an unknown block", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(300 - i, 100));
    const n = node(rows);
    const unstamped = (p: string) => n.fetch(p).then((r) => ({ ...r, tip: undefined }));
    await expect(loadHistory(BASE, unstamped)).rejects.toThrow(/which block/);
  });
});

describe("advance", () => {
  const full = Array.from({ length: 40 }, (_, i) => row(40 - i, 100));
  const loaded = history(full, true);

  it("puts new rows on top and carries the balance", () => {
    const fresh = [row(42, -500), row(41, 1000), ...full].slice(0, SUMMARY_PAGE);
    const h = advance(loaded, fresh);
    expect(h?.rows.slice(0, 3).map((r) => r.txid)).toStrictEqual([txid(42), txid(41), txid(40)]);
    expect(h?.rows).toHaveLength(42);
    expect(h?.balance).toBe(4000 + 500);
    expect(h?.complete).toBe(true);
  });

  it("drops the rows a reorg took away, and their change", () => {
    // Blocks 39 and 40 are gone; a new block 39 holds another payment.
    const fresh = [row(77, 5, 39), ...full.slice(2)].slice(0, SUMMARY_PAGE);
    const h = advance(loaded, fresh);
    expect(h?.rows[0]?.txid).toBe(txid(77));
    expect(h?.rows).toHaveLength(39);
    expect(h?.balance).toBe(4000 - 200 + 5);
    expect(h?.total).toBe(39);
  });

  it("takes the page's own block times where it overlaps what is loaded", () => {
    // Block 40 was replaced at the same height by one with another time.
    const remined = { ...full[0], time: 1 } as TxSummary;
    const h = advance(loaded, [remined, ...full.slice(1, SUMMARY_PAGE)]);
    expect(h?.rows[0]?.time).toBe(1);
    expect(h?.rows).toHaveLength(40);
    expect(h?.balance).toBe(4000);
  });

  it("takes a short page as the whole history", () => {
    expect(advance(loaded, [row(1, 7)])).toStrictEqual(history([row(1, 7)]));
  });

  it("asks for everything again when the page does not meet what is loaded", () => {
    const apart = Array.from({ length: SUMMARY_PAGE }, (_, i) => row(500 - i, 1));
    expect(advance(loaded, apart)).toBeUndefined();
    // The same transactions in other blocks: the history under them changed.
    const moved = full
      .slice(0, SUMMARY_PAGE)
      .map((r) => row(Number.parseInt(r.txid, 16), 100, r.height + 1));
    expect(advance(loaded, moved)).toBeUndefined();
  });

  it(`keeps at most ${MAX_ROWS} rows, and then says the history is partial`, () => {
    const many = Array.from({ length: MAX_ROWS }, (_, i) => row(MAX_ROWS - i, 100));
    const fresh = [row(MAX_ROWS + 1, 100), ...many].slice(0, SUMMARY_PAGE);
    const h = advance(history(many), fresh);
    expect(h?.rows).toHaveLength(MAX_ROWS);
    expect(h?.complete).toBe(false);
    expect(h?.balance).toBe((MAX_ROWS + 1) * 100);
  });
});
