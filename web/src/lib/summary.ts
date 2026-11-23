// A mined block's fee facts from GET /app/block(s)/…/summary (docs/FRONTEND.md "Block summaries").
import { fetchApp } from "./api";
import type { Hash } from "./esplora";
import type { Network } from "./network";
import { FEE_BANDS, UNSPLIT_BANDS } from "./format";

/** Fee rates in sat/vB, unrounded; percentiles are weighted by virtual size. */
export interface FeeRates {
  min: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
}

/** Who mined a block: a pool from the server's shipped list, or Unknown (`slug` "unknown"). */
export interface Miner {
  /** The list's name, never text from the block. */
  name: string;
  /** The pool page's slug: lowercase letters and digits. */
  slug: string;
}

export interface BlockSummary {
  id: Hash;
  height: number;
  tx_count: number;
  /** sats, the coinbase left out, as are `vsize` and `weight`. */
  fees: number;
  vsize: number;
  weight: number;
  /** Null for a block holding only its coinbase. */
  fee_rate: FeeRates | null;
  /** Virtual size paying in each of the ten fee bands, cheapest first: the strata. */
  fee_bands: number[];
  /** Absent from a server that does not name miners. */
  miner?: Miner;
  /**
   * Whether the coinbase is laid out as Stratum V2's reference implementation writes it: what the
   * block's builder wrote, not proof. Absent from an older server: read that as false.
   */
  sv2?: boolean;
  /** The block's audit totals, null without one; absent from an older server. Read with `readAudit`. */
  audit?: unknown;
}

/** The batch route takes at most this many hashes. */
export const SUMMARY_BATCH = 10;

const RATE_KEYS = ["min", "p10", "p25", "median", "p75", "p90", "max"] as const;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function isMiner(v: unknown): v is Miner {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m["name"] === "string" &&
    m["name"].length > 0 &&
    m["name"].length <= 64 &&
    typeof m["slug"] === "string" &&
    /^[a-z0-9]{1,64}$/.test(m["slug"])
  );
}

/** Whether a reply (or a WebSocket message's `summary`) is a summary this app can draw. */
export function isSummary(v: unknown): v is BlockSummary {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  const rates = s["fee_rate"];
  const bands = s["fee_bands"];
  return (
    typeof s["id"] === "string" &&
    /^[0-9a-f]{64}$/.test(s["id"]) &&
    Number.isSafeInteger(s["height"]) &&
    ["tx_count", "fees", "vsize", "weight"].every((k) => isCount(s[k])) &&
    (rates === null ||
      (typeof rates === "object" &&
        rates !== null &&
        RATE_KEYS.every((k) => isCount((rates as Record<string, unknown>)[k])))) &&
    Array.isArray(bands) &&
    // Ten for a block stored before the lowest band was split (widenBands), else twelve.
    (bands.length === FEE_BANDS || bands.length === UNSPLIT_BANDS) &&
    bands.every((b) => isCount(b)) &&
    (s["miner"] === undefined || isMiner(s["miner"])) &&
    (s["sv2"] === undefined || typeof s["sv2"] === "boolean")
  );
}

// shortcut: insertion-ordered, capped like api.ts's cache; kept for the page's life: only a release changes a miner.
const KNOWN_MAX = 512;
const known = new Map<string, BlockSummary>();
const key = (network: Network, hash: string) => `${network}:${hash}`;

/** A summary this page already has: fetched, or pushed over the WebSocket. */
export function knownSummary(network: Network, hash: string): BlockSummary | undefined {
  return known.get(key(network, hash));
}

/** Keeps a summary for the life of the page. */
export function rememberSummary(network: Network, summary: BlockSummary): void {
  if (known.size >= KNOWN_MAX) {
    const oldest = known.keys().next();
    if (!oldest.done) known.delete(oldest.value);
  }
  known.set(key(network, summary.id), summary);
}

/** Forgets every summary. For tests. */
export function clearSummaries(): void {
  known.clear();
}

/**
 * The commit the server wrote into the page (`<meta name="revision">`), or empty without one (a
 * build with no commit, a test, the dev server). A release can name a block's miner differently,
 * so each release's summaries have their own URLs in the browser's cache, and a page that cannot
 * name its release does not use that cache.
 */
function pageRelease(): string {
  const r =
    typeof document === "undefined"
      ? null
      : document.querySelector('meta[name="revision"]')?.getAttribute("content");
  return typeof r === "string" && /^[0-9a-f]{40}$/.test(r) ? r : "";
}

/**
 * The summaries of up to ten blocks in one request, retrying when the server says it is busy (503)
 * or this client asked for too much (429), as long as it says to wait. Summaries already known are
 * not asked for again. Resolves with every summary it has, keyed by hash.
 */
export async function fetchSummaries(
  network: Network,
  hashes: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, BlockSummary>> {
  const missing = [...new Set(hashes)].filter((h) => !known.has(key(network, h)));
  const release = pageRelease();
  const tail = release === "" ? "" : `&r=${release}`;
  const cached = release !== "";
  for (let i = 0; i < missing.length; i += SUMMARY_BATCH) {
    const part = missing.slice(i, i + SUMMARY_BATCH);
    const path = `/blocks/summary?hashes=${part.map((h) => encodeURIComponent(h)).join(",")}${tail}`;
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time, so a page never floods the server
    const reply = await fetchApp<unknown>(network, path, signal ? { signal, cached } : { cached });
    if (Array.isArray(reply)) {
      for (const s of reply) if (isSummary(s)) rememberSummary(network, s);
    }
  }
  const found = new Map<string, BlockSummary>();
  for (const h of hashes) {
    const s = knownSummary(network, h);
    if (s) found.set(h, s);
  }
  return found;
}
