import { afterEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "./api";
import {
  type BlockSummary,
  clearSummaries,
  fetchSummaries,
  isSummary,
  knownSummary,
} from "./summary";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const summary = (n: number): BlockSummary => ({
  id: hash(n),
  height: n,
  tx_count: 2,
  fees: 300,
  vsize: 150,
  weight: 600,
  fee_rate: { min: 2, p10: 2, p25: 2, median: 2, p75: 2, p90: 2, max: 2 },
  fee_bands: [0, 0, 0, 0, 0, 0, 150, 0, 0, 0],
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearApiCache();
  clearSummaries();
});

describe("isSummary", () => {
  it("accepts the server's shape, including a coinbase-only block", () => {
    expect(isSummary(summary(1))).toBe(true);
    expect(isSummary({ ...summary(1), fee_rate: null })).toBe(true);
    const miner = { name: "Foundry USA", slug: "foundryusa" };
    expect(isSummary({ ...summary(1), miner })).toBe(true);
    expect(isSummary({ ...summary(1), miner: { name: "Unknown", slug: "unknown" } })).toBe(true);
  });

  it("refuses a miner whose slug could not be a pool page", () => {
    for (const miner of [
      null,
      "Foundry USA",
      { name: "Foundry USA" },
      { name: "", slug: "foundryusa" },
      { name: "A", slug: "../admin" },
      { name: "A", slug: "Foundry USA" },
      { name: "x".repeat(65), slug: "x" },
    ]) {
      expect(isSummary({ ...summary(1), miner })).toBe(false);
    }
  });

  it("takes the Stratum V2 mark as a boolean, or absent from an older server", () => {
    expect(isSummary({ ...summary(1), sv2: true })).toBe(true);
    expect(isSummary({ ...summary(1), sv2: false })).toBe(true);
    expect("sv2" in summary(1)).toBe(false);
    for (const sv2 of [null, 1, "true", "Sv2/pool//", {}]) {
      expect(isSummary({ ...summary(1), sv2 })).toBe(false);
    }
  });

  it("refuses anything it could not draw", () => {
    expect(isSummary({ ...summary(1), id: "<b>" })).toBe(false);
    expect(isSummary({ ...summary(1), fee_bands: [1, 2] })).toBe(false);
    expect(isSummary({ ...summary(1), fee_bands: [...summary(1).fee_bands.slice(1), -1] })).toBe(
      false,
    );
    expect(isSummary({ ...summary(1), fee_rate: { median: 1 } })).toBe(false);
    expect(isSummary({ ...summary(1), fees: "300" })).toBe(false);
    expect(isSummary(null)).toBe(false);
  });
});

describe("fetchSummaries", () => {
  it("asks in batches of ten, skips what it knows, and keeps what it gets", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      const hashes = new URL(url, "http://x").searchParams.get("hashes")?.split(",") ?? [];
      return Response.json(hashes.map((h) => summary(Number.parseInt(h, 16))));
    });
    const wanted = Array.from({ length: 12 }, (_, i) => hash(i + 1));
    const found = await fetchSummaries("signet", wanted);
    expect(found.size).toBe(12);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/^\/signet\/app\/blocks\/summary\?hashes=/);
    expect(asked[1]?.split(",")).toHaveLength(2);
    expect(knownSummary("signet", hash(3))?.height).toBe(3);
    expect(knownSummary("mainnet", hash(3))).toBeUndefined();
    await fetchSummaries("signet", [hash(3), hash(4)]);
    expect(asked).toHaveLength(2);
  });

  it("names the page's release, so a new release never reads an old one's cached miner", async () => {
    const rev = "a8c5a81705bef0bcd931f790c282538ea1196f70";
    const asked: [string, RequestCache | undefined][] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      asked.push([url, init?.cache]);
      const hashes = new URL(url, "http://x").searchParams.get("hashes")?.split(",") ?? [];
      return Response.json(hashes.map((h) => summary(Number.parseInt(h, 16))));
    });
    const meta = document.createElement("meta");
    meta.name = "revision";
    try {
      meta.content = rev;
      document.head.append(meta);
      await fetchSummaries("mainnet", [hash(5)]);
      // A build with no commit, or a value that could add to the query, names no release.
      meta.content = "unknown";
      await fetchSummaries("mainnet", [hash(6)]);
      meta.content = "a&x=1";
      await fetchSummaries("mainnet", [hash(7)]);
    } finally {
      meta.remove();
    }
    await fetchSummaries("mainnet", [hash(8)]);
    // Only a page that names its release takes the browser's copy; the rest ask the server.
    expect(asked).toStrictEqual([
      [`/app/blocks/summary?hashes=${hash(5)}&r=${rev}`, undefined],
      [`/app/blocks/summary?hashes=${hash(6)}`, "no-cache"],
      [`/app/blocks/summary?hashes=${hash(7)}`, "no-cache"],
      [`/app/blocks/summary?hashes=${hash(8)}`, "no-cache"],
    ]);
  });

  it("leaves out what the server did not send or sent malformed", async () => {
    vi.stubGlobal("fetch", async () => Response.json([summary(1), { id: hash(2) }]));
    const found = await fetchSummaries("mainnet", [hash(1), hash(2)]);
    expect([...found.keys()]).toStrictEqual([hash(1)]);
  });
});
