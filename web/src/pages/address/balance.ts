// The address's confirmed balance over time, from the node's paged `/txs/summary` rows: how much
// history to load, how to anchor a partial one to the true balance, and how a live change joins
// what is loaded. Pure but for `loadHistory`, which takes its fetcher. docs/FRONTEND.md "The
// address balance chart".
import { isNotFound, type Stamped } from "../../lib/api";
import type { AddressStats, TxSummary } from "../../lib/esplora";

/** Rows in one page of `/txs/summary`: the node's fixed page size (rbitcoin v0.9.2). */
export const SUMMARY_PAGE = 25;
/**
 * Summary pages one page view may ask for: 200 transactions. That is about one step every 5 px
 * across a desktop chart and 1.5 px on a phone, so more would not show, and it stays well inside a
 * client's share of the address routes (docs/CONFIG.md). A partial history adds one more request.
 */
export const MAX_PAGES = 8;
export const MAX_ROWS = SUMMARY_PAGE * MAX_PAGES;

/** What is loaded: confirmed rows, newest first, and the confirmed balance after the newest. */
export interface History {
  rows: TxSummary[];
  /** The rows reach the address's first transaction. */
  complete: boolean;
  /** Sats after `rows[0]`. */
  balance: number;
  /** Confirmed transactions in all. */
  total: number;
}

/** One block's step on the chart. */
export interface Point {
  /** Block time, made non-decreasing (a block may claim an earlier time than its parent). */
  time: number;
  height: number;
  /** Sats after the block. */
  balance: number;
  /** The block's net change in sats; null for the oldest block of a partial history. */
  change: number | null;
}

const isRow = (r: unknown): r is TxSummary => {
  if (typeof r !== "object" || r === null) return false;
  const { txid, value, height, time } = r as Record<string, unknown>;
  return (
    typeof txid === "string" &&
    /^[0-9a-f]{64}$/.test(txid) &&
    Number.isSafeInteger(value) &&
    Number.isSafeInteger(height) &&
    Number.isSafeInteger(time)
  );
};

/** A summary page as the node sent it; throws on anything else, since it is untrusted. */
export function readRows(page: unknown): TxSummary[] {
  if (!Array.isArray(page) || !page.every((r) => isRow(r))) {
    throw new TypeError("The node's history summary was not understood.");
  }
  return page;
}

const sum = (rows: readonly TxSummary[]) => rows.reduce((s, r) => s + r.value, 0);
const confirmed = (rows: readonly TxSummary[]) => rows.filter((r) => r.height > 0);

/**
 * The newest history, at most `pages` pages, every page as of the first's block. When it stops
 * short of the first transaction (the cap, or a later page that failed), the address's totals as
 * of that block anchor it. `given` is the first page when it is already in. `asof` pins every
 * request, the first too, to that block hash. `strict`: a later page that fails fails the whole,
 * for a caller that reads `complete` as "reached the first transaction or the cap", never as a
 * page that went missing.
 */
export async function loadHistory(
  base: string,
  fetch: (path: string) => Promise<Stamped<unknown>>,
  pages = MAX_PAGES,
  given?: Stamped<unknown>,
  asof?: string,
  strict = false,
): Promise<History> {
  const first =
    given ?? (await fetch(`${base}/txs/summary${asof === undefined ? "" : `?asof=${asof}`}`));
  const tip = asof ?? first.tip?.hash;
  const pin = tip === undefined ? "" : `?asof=${tip}`;
  let page = readRows(first.value);
  const rows = [...page];
  for (let asked = 1; page.length >= SUMMARY_PAGE && asked < pages; asked++) {
    const last = page.at(-1)?.txid ?? "";
    try {
      // oxlint-disable-next-line no-await-in-loop -- each page continues after the last one's final row
      page = readRows((await fetch(`${base}/txs/summary/${last}${pin}`)).value);
    } catch (error) {
      // As of a block, a 404 says the block left the best chain: nothing loaded may be shown.
      if (strict || (asof !== undefined && isNotFound(error))) throw error;
      // A later page that fails (a node too slow to answer) leaves the newer ones, anchored below.
      break;
    }
    rows.push(...page);
  }
  const kept = confirmed(rows);
  if (page.length < SUMMARY_PAGE) {
    return { rows: kept, complete: true, balance: sum(kept), total: kept.length };
  }
  // Without a block to pin the totals to, they could be newer than the rows.
  if (tip === undefined) throw new Error("The node did not say which block its history is as of.");
  const c = ((await fetch(`${base}${pin}`)).value as Partial<AddressStats> | null)?.chain_stats;
  const balance = (c?.funded_txo_sum ?? Number.NaN) - (c?.spent_txo_sum ?? Number.NaN);
  const total = c?.tx_count ?? Number.NaN;
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(total)) {
    throw new TypeError("The node's totals were not understood.");
  }
  return { rows: kept, complete: total === kept.length, balance, total };
}

/**
 * The history after a change: the fresh first page joined to the rows already loaded, with the
 * balance carried by what is new and what left (a reorg). Undefined when the page does not meet
 * what is loaded; the page is then anchored on its own.
 */
export function advance(old: History, fresh: readonly TxSummary[]): History | undefined {
  const page = confirmed(fresh);
  if (fresh.length < SUMMARY_PAGE) {
    return { rows: page, complete: true, balance: sum(page), total: page.length };
  }
  const index = new Map(old.rows.map((r, i) => [r.txid, i]));
  const j = page.findIndex((r) => index.has(r.txid));
  if (j === -1) return undefined;
  const k = index.get(page[j]?.txid ?? "") ?? 0;
  // The rest of the page must be the loaded rows, in order and in the same blocks.
  for (let i = j; i < page.length && k + i - j < old.rows.length; i++) {
    const was = old.rows[k + i - j];
    if (was?.txid !== page[i]?.txid || was?.height !== page[i]?.height) return undefined;
  }
  const added = page.slice(0, j);
  const gone = old.rows.slice(0, k);
  // The page's own rows where it overlaps: a block re-mined at the same height has a new time.
  const joined = [...page, ...old.rows.slice(k + page.length - j)];
  const rows = joined.slice(0, MAX_ROWS);
  return {
    rows,
    complete: old.complete && rows.length === joined.length,
    balance: old.balance + sum(added) - sum(gone),
    total: old.total + added.length - gone.length,
  };
}

/** One step per block, oldest first, each with the balance after it. */
export function points(h: History): Point[] {
  const out: Point[] = [];
  let after = h.balance;
  for (const r of h.rows) {
    const last = out.at(-1);
    if (last?.height === r.height) {
      last.change = (last.change ?? 0) + r.value;
    } else {
      out.push({ time: r.time, height: r.height, balance: after, change: r.value });
    }
    after -= r.value;
  }
  // The oldest block of a partial history may have more rows on a page not loaded.
  const oldest = out.at(-1);
  if (oldest && !h.complete) oldest.change = null;
  out.reverse();
  for (let i = 1; i < out.length; i++) {
    const p = out[i];
    const prev = out[i - 1];
    if (p && prev && p.time < prev.time) p.time = prev.time;
  }
  return out;
}
