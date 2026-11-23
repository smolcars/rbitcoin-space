import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatHashrate } from "../../components/chart/scale";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import { fakeBlock } from "../../lib/fakes";
import { clearSummaries } from "../../lib/summary";
import MiningPage from "./MiningPage";
import PoolPage from "./PoolPage";

const pool = (rank: number, name: string, slug: string, blockCount: number) => ({
  poolId: slug === "unknown" ? 0 : rank,
  name,
  link: "",
  blockCount,
  rank,
  emptyBlocks: 0,
  slug,
  avgMatchRate: null,
  avgFeeDelta: null,
  poolUniqueId: rank,
});
const RANKING = {
  pools: [pool(1, "Foundry USA", "foundryusa", 30), pool(2, "Unknown", "unknown", 10)],
  blockCount: 40,
  lastEstimatedHashrate: 9e20,
  lastEstimatedHashrate3d: 9e20,
  lastEstimatedHashrate1w: 9.5e20,
};
const HASHRATES = {
  hashrates: [
    { timestamp: 1_790_000_000, avgHashrate: 9e20 },
    { timestamp: 1_790_086_400, avgHashrate: 9.5e20 },
  ],
  difficulty: [],
  currentHashrate: 9.5e20,
  currentDifficulty: 148_360_000_000_000,
};
const REWARDS = {
  startBlock: 1,
  endBlock: 40,
  totalReward: "12600000000",
  totalFee: "100000000",
  totalTx: "4000",
};
const PARTIAL = { "x-data-complete": "false", "x-data-from-time": "1789000000" };

type Reply = () => Response | Promise<Response>;
let replies: Record<string, Reply>;
let requests: string[];

beforeEach(() => {
  clearApiCache();
  requests = [];
  replies = {
    "/v1/mining/pools/1w": () => Response.json(RANKING, { headers: PARTIAL }),
    "/v1/mining/hashrate/1w": () => Response.json(HASHRATES, { headers: PARTIAL }),
    "/v1/mining/reward-stats/40": () => Response.json(REWARDS),
    "/v1/difficulty-adjustment": () => Response.json({ error: "x" }, { status: 404 }),
    "/blocks": () => Response.json([]),
  };
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace(/^\/(regtest|signet|testnet4)/, "").replace(/^\/api/, "");
    requests.push(path);
    const reply = replies[path];
    return reply ? reply() : Response.json({ error: "not found" }, { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of disposers) d();
  disposers = [];
});

const text = (el: HTMLElement) => el.textContent ?? "";

describe("mining page", () => {
  it("ranks the pools, with Unknown shown honestly, and says where partial data starts", async () => {
    const el = mount(() => <MiningPage />, "/mining");
    await vi.waitFor(() => expect(text(el)).toContain("Foundry USA"));
    const pools = el.querySelector("[aria-labelledby=mining-pools-title]");
    expect(pools?.textContent).toContain("40 blocks in the last week");
    expect(pools?.textContent).toContain("75.0%");
    expect(pools?.textContent).toContain("named by no tag or address on the list");
    expect(pools?.querySelector("a[href='/mining/pool/unknown']")).not.toBeNull();
    expect(pools?.textContent).toContain("Data from 10 Sep 2026 onward");
    // A week's estimate: its share of the week's blocks times the week's hashrate.
    expect(pools?.textContent).toContain("713 EH/s");
    await vi.waitFor(() => expect(text(el)).toContain("Paid to miners"));
    // A summary reads in magnitude, the exact amount in its title.
    expect(text(el)).toContain("126.00 BTC");
    expect(el.querySelector('[title^="126.00\u202F000\u202F000 BTC"]')).not.toBeNull();
  });

  it("names each recent block's miner from one batch of facts", async () => {
    clearSummaries();
    const blocks = [fakeBlock(12), fakeBlock(11)];
    replies["/blocks"] = () => Response.json(blocks);
    const miners = [
      { name: "Foundry USA", slug: "foundryusa" },
      { name: "Unknown", slug: "unknown" },
    ];
    replies[`/app/blocks/summary?hashes=${blocks.map((b) => b.id).join(",")}`] = () =>
      Response.json(
        blocks.map((b, i) => ({
          id: b.id,
          height: b.height,
          tx_count: 1,
          fees: 0,
          vsize: 0,
          weight: 0,
          fee_rate: null,
          fee_bands: Array.from({ length: 10 }, () => 0),
          miner: miners[i],
        })),
      );
    const el = mount(() => <MiningPage />, "/mining");
    const tiles = () => [...el.querySelectorAll<HTMLElement>(".mining-tile")];
    await vi.waitFor(() =>
      expect(tiles().map((t) => t.querySelector(".mining-tile__pool")?.textContent)).toStrictEqual([
        "Foundry USA",
        "Unknown",
      ]),
    );
    expect(requests.filter((r) => r.startsWith("/app/blocks/summary"))).toHaveLength(1);
    // Read with the tile's link, not twice.
    expect(tiles()[0]?.querySelector("a")?.textContent).toContain("Block 12, mined by Foundry USA");
    expect(tiles()[0]?.querySelector(".mining-tile__pool")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("takes the period from the address and marks it current", async () => {
    replies["/v1/mining/pools/1m"] = () => Response.json(RANKING);
    const el = mount(() => <MiningPage />, "/mining?period=1m");
    await vi.waitFor(() => expect(requests).toContain("/v1/mining/pools/1m"));
    expect(requests).toContain("/v1/mining/hashrate/1m");
    expect(requests).toContain("/v1/mining/blocks/fees/1m");
    // The weekly shares are a tab of their own: fetched only when it opens.
    expect(requests).not.toContain("/v1/mining/hashrate/pools/1m");
    const current = el.querySelector("[aria-current=page]");
    expect(current?.textContent).toBe("1 m: the last 30 days");
  });

  it("keeps the pools caption with the period's own data when the period changes", async () => {
    let answer = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    replies["/v1/mining/pools/24h"] = async () => {
      await held;
      return Response.json({ ...RANKING, blockCount: 7 });
    };
    replies["/v1/mining/hashrate/24h"] =
      replies["/v1/mining/hashrate/1w"] ?? (() => Response.json({}));
    const el = mount(() => <MiningPage />, "/mining");
    const caption = () =>
      el.querySelector("[aria-labelledby=mining-pools-title] .section__head")?.textContent ?? "";
    await vi.waitFor(() => expect(caption()).toContain("40 blocks in the last week"));
    el.querySelector<HTMLAnchorElement>("a[href='/mining?period=24h']")?.click();
    // While the day loads, the week's figures stay, and so do the words that describe them.
    await vi.waitFor(() => expect(requests).toContain("/v1/mining/pools/24h"));
    expect(caption()).toContain("40 blocks in the last week");
    answer();
    await vi.waitFor(() => expect(caption()).toContain("7 blocks in the last 24 hours"));
  });

  it("gives the hashrate over the toggle's time: a day for 24 h, else the last 7 days", async () => {
    // `currentHashrate` counts 1,008 blocks, days of them once blocks slow down: never shown.
    replies["/v1/mining/hashrate/1w"] = () =>
      Response.json({ ...HASHRATES, currentHashrate: 3e21 }, { headers: PARTIAL });
    replies["/v1/mining/pools/24h"] = () =>
      Response.json({ ...RANKING, blockCount: 7 }, { headers: PARTIAL });
    replies["/v1/mining/pools/1m"] = () => Response.json(RANKING, { headers: PARTIAL });
    replies["/v1/mining/hashrate/1m"] = replies["/v1/mining/hashrate/1w"];
    const el = mount(() => <MiningPage />, "/mining");
    const fig = () =>
      [...el.querySelectorAll(".mining-fig")].find((f) => f.textContent?.startsWith("Hashrate"))
        ?.textContent ?? "";
    await vi.waitFor(() => expect(fig()).toContain(formatHashrate(9.5e20, 4)));
    expect(fig()).toContain("Over the last 7 days");
    el.querySelector<HTMLAnchorElement>("a[href='/mining?period=24h']")?.click();
    await vi.waitFor(() => expect(fig()).toContain(formatHashrate(9e20, 4)));
    expect(fig()).toContain("Over the last 24 hours");
    // A month is no "now": the week's figure again.
    el.querySelector<HTMLAnchorElement>("a[href='/mining?period=1m']")?.click();
    await vi.waitFor(() => expect(fig()).toContain(formatHashrate(9.5e20, 4)));
    expect(fig()).toContain("Over the last 7 days");
    expect(fig()).not.toContain(formatHashrate(3e21, 4));
  });

  it("says when nothing is stored for the period, and offers all time", async () => {
    replies["/v1/mining/pools/1w"] = () => Response.json({ ...RANKING, pools: [], blockCount: 0 });
    const el = mount(() => <MiningPage />, "/mining");
    await vi.waitFor(() => expect(text(el)).toContain("No blocks stored for the last week"));
    expect(el.querySelector("a[href='/mining?period=all']")).not.toBeNull();
    expect(requests.some((p) => p.includes("reward-stats"))).toBe(false);
  });

  it("shows no reward totals when they fail, and offers a retry", async () => {
    replies["/v1/mining/reward-stats/40"] = () => Response.json({ error: "boom" }, { status: 500 });
    const el = mount(() => <MiningPage />, "/mining");
    const paid = () =>
      [...el.querySelectorAll(".mining-fig")].find((f) => f.textContent?.startsWith("Paid"));
    const retry = () => paid()?.querySelector("button");
    await vi.waitFor(() => expect(retry()?.textContent).toBe("Could not load. Try again"));
    expect(text(el)).not.toContain("126.00 BTC");
    replies["/v1/mining/reward-stats/40"] = () => Response.json(REWARDS);
    retry()?.click();
    await vi.waitFor(() => expect(text(el)).toContain("126.00 BTC"));
  });

  it("drops the reward totals when the pools fail, since they count the pools' blocks", async () => {
    replies["/v1/mining/pools/24h"] = () => Response.json({ error: "boom" }, { status: 500 });
    const el = mount(() => <MiningPage />, "/mining");
    await vi.waitFor(() => expect(text(el)).toContain("126.00 BTC"));
    el.querySelector<HTMLAnchorElement>("a[href='/mining?period=24h']")?.click();
    await vi.waitFor(() => expect(text(el)).toContain("Could not load the pools"));
    expect(text(el)).not.toContain("126.00 BTC");
  });

  it("offers a retry when the next adjustment fails", async () => {
    replies["/v1/difficulty-adjustment"] = () => Response.json({ error: "boom" }, { status: 500 });
    const el = mount(() => <MiningPage />, "/mining");
    const figures = () => el.querySelector("[aria-label='Mining figures']");
    const retry = () =>
      [...(figures()?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "Could not load. Try again",
      );
    await vi.waitFor(() => expect(retry()).toBeDefined());
    replies["/v1/difficulty-adjustment"] = () =>
      Response.json({
        progressPercent: 50,
        difficultyChange: 2.5,
        estimatedRetargetDate: Date.now() + 86_400_000,
        remainingBlocks: 1008,
        previousRetarget: 1,
        nextRetargetHeight: 2016,
        expectedBlocks: 1000,
      });
    retry()?.click();
    await vi.waitFor(() => expect(figures()?.textContent).toContain("Up 2.50%"));
  });

  it("says plainly when the server keeps no mining history", async () => {
    replies["/v1/mining/pools/1w"] = () =>
      Response.json(
        { error: "mining data needs a block table on this server" },
        { status: 503, headers: { "retry-after": "1" } },
      );
    const el = mount(() => <MiningPage />, "/mining");
    await vi.waitFor(() => expect(text(el)).toContain("This server keeps no mining history"));
    expect(requests.filter((p) => p === "/v1/mining/pools/1w")).toHaveLength(1);
  });

  it("offers a retry when the server fails", async () => {
    replies["/v1/mining/pools/1w"] = () => Response.json({ error: "boom" }, { status: 500 });
    const el = mount(() => <MiningPage />, "/mining");
    await vi.waitFor(() => expect(text(el)).toContain("Could not load the pools"));
    replies["/v1/mining/pools/1w"] = () => Response.json(RANKING);
    const pools = el.querySelector("[aria-labelledby=mining-pools-title]");
    const retry = [...(pools?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Try again",
    );
    retry?.click();
    await vi.waitFor(() => expect(text(el)).toContain("Foundry USA"));
  });

  it("explains regtest: no pools, no meaningful hashrate, no retargets", async () => {
    const el = mount(() => <MiningPage />, "/regtest/mining");
    await vi.waitFor(() => expect(text(el)).toContain("Foundry USA"));
    expect(text(el)).toContain("There are no pools and the hashrate is not meaningful here");
    expect(text(el)).toContain("Not meaningful on regtest");
    expect(text(el)).toContain("Regtest never adjusts its difficulty");
    expect(requests).not.toContain("/v1/difficulty-adjustment");
  });

  it("explains signet's signers", async () => {
    const el = mount(() => <MiningPage />, "/signet/mining");
    await vi.waitFor(() => expect(text(el)).toContain("authorized signers"));
  });
});

const STATS = {
  pool: {
    id: 7,
    name: "<b>Evil</b> Pool",
    // oxlint-disable-next-line no-script-url -- hostile data the page must refuse to link
    link: "javascript:alert(1)",
    addresses: ["bc1qexample"],
    regexes: ["/evil/"],
    slug: "evil",
    unique_id: 7,
  },
  blockCount: { all: 3, "24h": 1, "1w": 2 },
  blockShare: { all: 0.1, "24h": 0.01, "1w": 0.02 },
  estimatedHashrate: 1e19,
  reportedHashrate: null,
  avgBlockHealth: null,
  totalReward: "937500000",
};

let disposers: (() => void)[] = [];

/** The pool page at `url`, under its own route so the slug is a parameter. */
function openPool(url: string) {
  const history = memoryHistory(url);
  const Router = createRouter({
    routes: [{ path: "/mining/pool/:slug", component: PoolPage }],
    history,
  });
  const el = document.createElement("div");
  document.body.append(el);
  disposers.push(render(() => <Router>{(page) => page.children}</Router>, el));
  return el;
}

describe("pool page", () => {
  it("renders the dataset's name as text and never links an unsafe scheme", async () => {
    replies["/v1/mining/pool/evil"] = () => Response.json(STATS);
    replies["/v1/mining/pool/evil/hashrate"] = () => Response.json([]);
    replies["/v1/mining/pool/evil/blocks"] = () => Response.json([]);
    const el = openPool("/mining/pool/evil");
    await vi.waitFor(() => expect(el.querySelector("h1")?.textContent).toBe("<b>Evil</b> Pool"));
    expect(el.querySelector("h1 b")).toBeNull();
    expect(el.querySelector("a[href^='javascript']")).toBeNull();
    expect(text(el)).toContain("No blocks from this pool are stored");
    expect(text(el)).toContain("10\u202FEH/s");
    expect(text(el)).toContain("9.38 BTC");
  });

  it("links a pool's site by its host", async () => {
    replies["/v1/mining/pool/evil"] = () =>
      Response.json({ ...STATS, pool: { ...STATS.pool, link: "https://www.example.com/pool" } });
    const el = openPool("/mining/pool/evil");
    await vi.waitFor(() =>
      expect(el.querySelector("a[href='https://www.example.com/pool']")?.textContent).toBe(
        "example.com",
      ),
    );
  });

  it("pages through a pool's blocks, showing the last ones after the server runs out", async () => {
    const block = (height: number) => ({
      id: height.toString(16).padStart(64, "0"),
      height,
      timestamp: 1_790_000_000 + height,
      tx_count: 1,
      size: 1000,
      weight: 4000,
      extras: { totalFees: 0, medianFee: null, reward: 312_500_000 },
    });
    const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => block(from - i));
    replies["/v1/mining/pool/evil"] = () => Response.json(STATS);
    replies["/v1/mining/pool/evil/hashrate"] = () => Response.json([]);
    replies["/v1/mining/pool/evil/blocks"] = () => Response.json(range(1000, 100));
    replies["/v1/mining/pool/evil/blocks/901"] = () => Response.json(range(900, 50));
    const el = openPool("/mining/pool/evil");
    const more = () =>
      [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show 25"));
    const rows = () => el.querySelectorAll("tbody tr").length;
    await vi.waitFor(() => expect(rows()).toBe(25));
    for (const want of [50, 75, 100, 125, 150]) {
      more()?.click();
      await vi.waitFor(() => expect(rows()).toBe(want));
    }
    expect(text(el)).not.toContain("Could not load older blocks");
    expect(more()).toBeUndefined();
  });

  it("says when older blocks come back unreadable, and lets the reader retry", async () => {
    replies["/v1/mining/pool/evil"] = () => Response.json(STATS);
    replies["/v1/mining/pool/evil/hashrate"] = () => Response.json([]);
    replies["/v1/mining/pool/evil/blocks"] = () =>
      Response.json(
        Array.from({ length: 100 }, (_, i) => ({
          id: "a".repeat(64),
          height: 1000 - i,
          timestamp: 1,
          tx_count: 1,
          size: 1,
          weight: 4,
          extras: { totalFees: 0, medianFee: null, reward: 1 },
        })),
      );
    replies["/v1/mining/pool/evil/blocks/901"] = () => Response.json({ not: "a list" });
    const el = openPool("/mining/pool/evil");
    await vi.waitFor(() => expect(el.querySelectorAll("tbody tr")).toHaveLength(25));
    for (let i = 0; i < 4; i++) {
      [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show 25"))?.click();
    }
    await vi.waitFor(() => expect(text(el)).toContain("Could not load older blocks"));
    expect(text(el)).toContain("The server sent a reply that could not be read.");
  });

  it("says when no pool has the name", async () => {
    const el = openPool("/mining/pool/nobody");
    await vi.waitFor(() => expect(text(el)).toContain("No pool on the list has this name"));
  });
});
