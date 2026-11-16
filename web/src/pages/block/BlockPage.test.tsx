import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT } from "../../components/audit/fakes";
import { FakeSocket } from "../../lib/fakes";
import { clearApiCache } from "../../lib/api";
import { type BlockSummary, clearSummaries } from "../../lib/summary";
import type { Block, BlockStatus, Transaction } from "../../lib/esplora";
import type { Network } from "../../lib/network";
import BlocksPage from "../blocks/BlocksPage";
import BlockPage from "./BlockPage";

// The networks the server's config lists as having Lightning; none unless a test says so.
const config = vi.hoisted(() => ({ lightning: [] as Network[] }));
vi.mock(import("../../lib/config"), () => ({
  loadConfig: () =>
    Promise.resolve({
      networks: ["mainnet" as const],
      version: "",
      ark: {},
      broadcast: false,
      ...config,
    }),
}));

const HASH = "00000000000000000001b0e1f2c63fd0a1ec0d0b4f50f1c1e2f9b8c1d2e3f4a5";
const PREV = "00000000000000000002aa1d55e93c43a9ab7fa3e3c88f7c5d7f2c4f04b5c6d7";
const NEXT = "00000000000000000000ff0e1c2b3a495867768594a3b2c1d0e0f1a2b3c4d5e6";

const block: Block = {
  id: HASH,
  height: 975_411,
  version: 0x20000000,
  timestamp: 1_794_000_000,
  tx_count: 30,
  size: 1_600_000,
  weight: 3_990_000,
  merkle_root: "ab".repeat(32),
  previousblockhash: PREV,
  mediantime: 1_793_998_000,
  nonce: 12_345,
  bits: 386_000_300,
  difficulty: 148_364_561_003_867.4,
};

const tx = (i: number, extra: Partial<Transaction> = {}): Transaction => ({
  txid: i.toString(16).padStart(64, "0"),
  version: 2,
  locktime: 0,
  fee: 1000,
  weight: 800,
  vin: [{ txid: "11".repeat(32), vout: 0, is_coinbase: false }],
  vout: [{ value: 5000, scriptpubkey: "", scriptpubkey_asm: "", scriptpubkey_type: "p2pkh" }],
  status: { confirmed: true },
  ...extra,
});

// "<img src=x onerror=alert(1)>" and a NUL as the miner's tag, after the BIP34 height push for 975 411.
const hostileTag = `0333e20e1d${Array.from(new TextEncoder().encode("<img src=x onerror=alert(1)>"), (b) => b.toString(16).padStart(2, "0")).join("")}00`;
const coinbase = tx(0, {
  fee: 0,
  vin: [{ txid: "00".repeat(32), vout: 0xffffffff, is_coinbase: true, scriptsig: hostileTag }],
  vout: [
    { value: 313_000_000, scriptpubkey: "", scriptpubkey_asm: "", scriptpubkey_type: "v0_p2wpkh" },
  ],
});

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}
let replies: Record<string, Reply | ((n: number) => Reply | Promise<Reply>)> = {};
const calls: string[] = [];
/** How each call in `calls` treated the browser's HTTP cache. */
const caching: (RequestCache | undefined)[] = [];

function serve(table: typeof replies) {
  replies = table;
  calls.length = 0;
  caching.length = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = input.replace(/^(\/(signet|testnet4|regtest))?\/api/, "");
    calls.push(path);
    caching.push(init?.cache);
    const r = replies[path];
    const reply = typeof r === "function" ? await r(calls.filter((c) => c === path).length) : r;
    if (!reply) return Response.json({ error: "not found" }, { status: 404 });
    const status = reply.status ?? 200;
    // Block JSON is immutable, as the server marks it, so the client keeps it in memory.
    const headers = /^\/block\/[0-9a-f]{64}$/.test(path)
      ? { "cache-control": "public, max-age=31536000, immutable" }
      : (reply.headers ?? {});
    return typeof reply.body === "string" || reply.body instanceof ArrayBuffer
      ? new Response(reply.body, { status, headers })
      : Response.json(reply.body, { status, headers });
  });
}

// Status replies carry the tip they are as of, as rbitcoin stamps them.
const status = (s: Partial<BlockStatus> = {}): Reply => ({
  body: { in_best_chain: true, height: block.height, next_best: NEXT, ...s },
  headers: { "x-bitcoin-chain-tip": "cd".repeat(32), "x-bitcoin-chain-tip-height": "975420" },
});

const SUMMARY: BlockSummary = {
  id: HASH,
  height: block.height,
  tx_count: 30,
  fees: 500_000,
  vsize: 999_391,
  weight: 3_989_000,
  fee_rate: {
    min: 0.100_719,
    p10: 0.12,
    p25: 0.126_984,
    median: 1.085_088_8,
    p75: 2.007_012,
    p90: 3.150_749,
    max: 62.100_917,
  },
  fee_bands: [367_013, 9447, 153, 5069, 233_233, 20_986, 238_267, 102_460, 17_310, 5453],
};
const COINBASE_ONLY: BlockSummary = {
  ...SUMMARY,
  tx_count: 1,
  fees: 0,
  vsize: 0,
  weight: 0,
  fee_rate: null,
  fee_bands: Array.from({ length: 10 }, () => 0),
};
/** The block's transaction records, as the server encodes them: the coinbase and 29 others. */
function records(version = 2): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(8 + 30 * 28));
  view.setUint32(0, version, true);
  view.setUint32(4, 30, true);
  for (let i = 0; i < 30; i++) {
    view.setUint32(8 + i * 28, 200, true);
    view.setBigUint64(12 + i * 28, BigInt(i === 0 ? 0 : 1000), true);
    view.setBigUint64(20 + i * 28, 5000n, true);
    view.setBigUint64(28 + i * 28, 1034n, true);
  }
  return view.buffer;
}
const txsPath = `/app/block/${HASH}/txs?v=2`;
const summaryPath = (...hashes: string[]) => `/app/blocks/summary?hashes=${hashes.join(",")}`;
const normal = () => ({
  [`/block/${HASH}`]: { body: block },
  [`/block/${HASH}/status`]: status(),
  [`/block/${HASH}/txs/0`]: {
    body: [coinbase, ...Array.from({ length: 24 }, (_, i) => tx(i + 1))],
  },
  [`/block/${HASH}/txs/25`]: { body: Array.from({ length: 5 }, (_, i) => tx(i + 25)) },
  "/blocks/tip/height": { body: "975420" },
  "/block-height/975411": { body: HASH },
  [summaryPath(HASH)]: { body: [SUMMARY] },
  [txsPath]: { body: records() },
});

beforeEach(() => {
  // The page hears the blocks topic while a block's facts are on their way.
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearApiCache();
  clearSummaries();
  document.body.replaceChildren();
});

let history = memoryHistory();

function open(url: string) {
  history = memoryHistory(url);
  const Router = createRouter({
    routes: [
      { path: ["/block/:id", "/signet/block/:id"], component: BlockPage },
      { path: ["/blocks", "/blocks/:from"], component: BlocksPage },
    ],
    history,
  });
  const el = document.createElement("div");
  document.body.append(el);
  // Disposed after each test, so a page's WebSocket subscription ends with it.
  mounted.push(render(() => <Router>{(page) => page.children}</Router>, el));
  return el;
}
const mounted: (() => void)[] = [];

const text = (el: Element) => (el.textContent ?? "").replaceAll(" ", " ");
const fact = (el: Element, label: string) =>
  text(
    [...el.querySelectorAll(".block-fact")]
      .find((f) => f.querySelector("dt")?.textContent === label)
      ?.querySelector("dd") ?? document.createElement("dd"),
  );
const until = <T,>(fn: () => T) => vi.waitFor(fn, { timeout: 2000 });

describe("BlockPage", () => {
  it("shows skeletons until the data arrives", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const el = open(`/block/${HASH}`);
    expect(el.querySelectorAll(".block-skel").length).toBeGreaterThan(10);
    expect(el.querySelector(".hash--full")?.textContent).toContain(HASH.slice(0, 8));
  });

  it("shows a block by hash with reward, fees and neighbours", async () => {
    serve(normal());
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Reward")).toContain("3.13000000 BTC"));
    expect(text(el.querySelector("h1") as Element)).toBe("Block 975 411");
    expect(fact(el, "Total fees")).toContain("500 000 sats");
    expect(fact(el, "Reward")).toContain("3.12500000 BTC subsidy");
    expect(fact(el, "Confirmations")).toContain("10");
    expect(fact(el, "Fullness")).toContain("99.8%");
    // The facts come before the drawing in reading order, so a phone shows them first.
    const side = el.querySelector(".block-side");
    const core = el.querySelector(".block-core");
    expect(
      !!side && !!core && !!(side.compareDocumentPosition(core) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    // This summary is from a server that does not name miners.
    await until(() => expect(fact(el, "Miner")).toBe("Not known on this server"));
    expect(fact(el, "Bits")).toContain("0x1701e5ac");
    const prev = el.querySelector<HTMLAnchorElement>('a[rel="prev"]');
    const next = el.querySelector<HTMLAnchorElement>('a[rel="next"]');
    expect(prev?.getAttribute("href")).toBe(`/block/${PREV}`);
    expect(text(next as Element)).toContain("975 412");
    expect(el.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(text(el.querySelector("tbody tr") as Element)).toContain("Coinbase");
    // A size keeps its unit in the cell, as on every other page: weight 800 is 200 vB.
    expect(text(el.querySelector("thead") as Element)).toContain("Virtual size");
    const cells = [...(el.querySelectorAll("tbody tr")[1]?.querySelectorAll("td") ?? [])];
    expect(cells.map((c) => text(c))).toContain("200 vB");
    expect(document.title).toBe("Block 975 411 | rbitcoin.space".replace(" 4", " 4"));
  });

  it("fills the fee facts and the core sample's layers from the summary", async () => {
    serve(normal());
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Median fee rate")).toContain("1.09 sat/vB"));
    expect(fact(el, "Fee range")).toContain("0.10 – 62.1 sat/vB");
    const layers = [...el.querySelectorAll<HTMLElement>(".block-core .strata__layer")];
    expect(layers).toHaveLength(10);
    expect(layers[0]?.style.getPropertyValue("--c")).toBe("var(--fee-1)");
    // Colour belongs to the drawing: the facts give rates as numbers alone.
    expect(el.querySelector(".block-fact .fee__swatch")).toBeNull();
    const caption = text(el.querySelector(".block-core__caption") as Element);
    expect(caption).toContain("Layers, cheapest first: under 0.20 sat/vB: 367.01 kvB, 37%");
    expect(caption).toContain("10.0 sat/vB and up: 5 453 vB, under 1%");
    expect(el.querySelector(".block-core .feekey")).not.toBeNull();
  });

  it("shows the block's audit from its facts", async () => {
    serve({ ...normal(), [summaryPath(HASH)]: { body: [{ ...SUMMARY, audit: AUDIT }] } });
    const el = open(`/block/${HASH}`);
    await until(() => expect(text(el.querySelector(".audit__rate") as Element)).toBe("99.87%"));
    expect(text(el.querySelector(".audit") as Element)).toContain("3 transactions, 1 200 vB");
  });

  it("says plainly that a block has no audit", async () => {
    serve({ ...normal(), [summaryPath(HASH)]: { body: [{ ...SUMMARY, audit: null }] } });
    const el = open(`/block/${HASH}`);
    await until(() =>
      expect(text(el.querySelector(".audit") as Element)).toContain(
        "Not audited: we were not watching when this block arrived",
      ),
    );
    expect(el.querySelector(".audit [role=alert]")).toBeNull();
  });

  it("shows a new block's audit when its facts arrive over the WebSocket", async () => {
    // The facts request is still being computed by the server when the push comes.
    serve({ ...normal(), [summaryPath(HASH)]: () => ({ body: new Promise(() => {}) }) });
    const served = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string) =>
      input.includes("/app/blocks/summary") ? new Promise(() => {}) : served(input),
    );
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Reward")).toContain("3.13000000 BTC"));
    expect(el.querySelector(".audit__rate")).toBeNull();
    const socket = await until(() => FakeSocket.last());
    socket.hello({ network: "mainnet" });
    // Another block's facts change nothing here.
    socket.receive({
      topic: "blocks",
      type: "summary",
      summary: { ...SUMMARY, id: NEXT, audit: null },
    });
    expect(el.querySelector(".audit__rate")).toBeNull();
    socket.receive({ topic: "blocks", type: "summary", summary: { ...SUMMARY, audit: AUDIT } });
    expect(text(el.querySelector(".audit__rate") as Element)).toBe("99.87%");
    expect(fact(el, "Median fee rate")).toContain("1.09 sat/vB");
  });

  it("names the miner, linking to its pool's page", async () => {
    const miner = { name: "Foundry USA", slug: "foundryusa" };
    serve({ ...normal(), [summaryPath(HASH)]: { body: [{ ...SUMMARY, miner }] } });
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Miner")).toContain("Foundry USA"));
    expect(fact(el, "Miner")).toContain("By payout address or tag");
    const link = [...el.querySelectorAll<HTMLAnchorElement>(".block-fact a")].find(
      (a) => a.textContent === "Foundry USA",
    );
    expect(link?.getAttribute("href")).toBe("/mining/pool/foundryusa");
  });

  it("says Unknown as such, never the miner's own tag", async () => {
    const miner = { name: "Unknown", slug: "unknown" };
    serve({ ...normal(), [summaryPath(HASH)]: { body: [{ ...SUMMARY, miner }] } });
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Miner")).toContain("Unknown"));
    expect(fact(el, "Miner")).toBe("UnknownNo listed address or tag");
    expect(el.querySelector('.block-fact a[href="/mining/pool/unknown"]')).not.toBeNull();
    // The tag is shown as the miner wrote it, in its own fact, as text.
    await until(() => expect(fact(el, "Coinbase tag")).toContain("<img src=x onerror=alert(1)>"));
    expect(el.querySelector("img")).toBeNull();
  });

  it("offers a retry for the miner when the facts fail", async () => {
    serve({ ...normal(), [summaryPath(HASH)]: { status: 502, body: { error: "node failed" } } });
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Miner")).toContain("Could not load. Try again"));
  });

  it("says when a block holds only its coinbase", async () => {
    serve({ ...normal(), [summaryPath(HASH)]: { body: [COINBASE_ONLY] } });
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Median fee rate")).toContain("None"));
    expect(fact(el, "Median fee rate")).toContain("Only the coinbase, which pays none");
    expect(fact(el, "Fee range")).toBe("–");
    expect(el.querySelectorAll(".strata__layer")).toHaveLength(0);
    expect(el.querySelector(".block-core__fill--strata")).toBeNull();
  });

  it("waits out a busy server without showing an error, as Retry-After says", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0); // no jitter
    const busy = (code: number, after: string): Reply => ({
      status: code,
      body: { error: "busy" },
      headers: { "retry-after": after },
    });
    serve({
      ...normal(),
      [summaryPath(HASH)]: (n) =>
        n === 1 ? busy(503, "1") : n === 2 ? busy(429, "2") : { body: [SUMMARY] },
    });
    const asked: number[] = [];
    const served = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      if (input === summaryPath(HASH)) asked.push(Date.now());
      return served(input);
    });
    const el = open(`/block/${HASH}`);
    await until(() => expect(asked).toHaveLength(2));
    // No error while a retry is pending, and none sooner than Retry-After.
    expect(el.querySelector(".block-fact__retry")).toBeNull();
    expect(text(el)).not.toContain("Busy");
    expect(fact(el, "Median fee rate")).toBe("");
    await until(() => expect(fact(el, "Median fee rate")).toContain("1.09 sat/vB"));
    expect(asked).toHaveLength(3);
    const [a = 0, b = 0, c = 0] = asked;
    expect(b - a).toBeGreaterThanOrEqual(1000);
    // The 429 said two seconds, which is also the backoff for a second retry.
    expect(c - b).toBeGreaterThanOrEqual(2000);
  });

  it("offers to try the fee facts again when they fail for good", async () => {
    serve({
      ...normal(),
      [summaryPath(HASH)]: (n) =>
        n === 1 ? { status: 502, body: { error: "node failed" } } : { body: [SUMMARY] },
    });
    const el = open(`/block/${HASH}`);
    const retry = await until(() => {
      const b = el.querySelector<HTMLButtonElement>(".block-fact__retry");
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    expect(fact(el, "Fee range")).toBe("–");
    retry.click();
    await until(() => expect(fact(el, "Median fee rate")).toContain("1.09 sat/vB"));
  });

  it("keeps the fee layers while the map's data loads", () => {
    serve(normal());
    // At once, before any reply.
    const el = open(`/block/${HASH}`);
    expect(el.querySelector(".block-core--grid")).toBeNull();
    const [layers, map] = el.querySelectorAll(".block-core__text");
    expect(layers?.classList.contains("block-core__text--off")).toBe(false);
    expect(map?.classList.contains("block-core__text--off")).toBe(true);
  });

  it("keeps the fee layers and says so where the browser has no WebGL2", async () => {
    // The test document, like a browser without WebGL2, gives no webgl2 context.
    serve(normal());
    const el = open(`/block/${HASH}`);
    await until(() =>
      expect(text(el)).toContain("needs WebGL2, which this browser does not offer"),
    );
    expect(el.querySelector(".block-core--grid")).toBeNull();
    expect(el.querySelector(".block-core__grid")).toBeNull();
    await until(() => expect(el.querySelectorAll(".block-core .strata__layer")).toHaveLength(10));
  });

  it("offers to load the map again when its data fails, keeping the layers meanwhile", async () => {
    serve({
      ...normal(),
      [txsPath]: (n) =>
        n === 1 ? { status: 502, body: { error: "node failed" } } : { body: records() },
    });
    const el = open(`/block/${HASH}`);
    const retry = await until(() => {
      const b = el.querySelector<HTMLButtonElement>(".block-core__retry");
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    expect(text(el)).toContain("The map of each transaction could not load.");
    retry.click();
    await until(() => expect(el.querySelector(".block-core__retry")).toBeNull());
    expect(calls.filter((c) => c === txsPath)).toHaveLength(2);
  });

  it("asks for a reload when the server sends a newer record format", async () => {
    serve({ ...normal(), [txsPath]: { body: records(3) } });
    const el = open(`/block/${HASH}`);
    await until(() => expect(text(el)).toContain("The server is newer than this page."));
  });

  it("asks for the fee facts again when the network changes under the same hash", async () => {
    serve(normal());
    const el = open(`/signet/block/${HASH}`);
    // The test server only knows mainnet's summary, as if the block were mainnet's.
    await until(() => expect(el.querySelector(".block-fact__retry")).not.toBeNull());
    history.set({ value: `/block/${HASH}` });
    await until(() => expect(fact(el, "Median fee rate")).toContain("1.09 sat/vB"));
  });

  it("counts confirmations from the tip the status reply is stamped with", async () => {
    serve({
      ...normal(),
      [`/block/${HASH}/status`]: {
        ...status(),
        headers: { "x-bitcoin-chain-tip": "cd".repeat(32), "x-bitcoin-chain-tip-height": "975413" },
      },
    });
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Confirmations")).toBe("3"));
    expect(calls).not.toContain("/blocks/tip/height");
  });

  it("shows the right header after moving between cached blocks", async () => {
    const prevBlock = {
      ...block,
      id: PREV,
      height: block.height - 1,
      version: 4,
      previousblockhash: null,
    };
    serve({
      ...normal(),
      [`/block/${PREV}`]: { body: prevBlock },
      [`/block/${PREV}/status`]: status({ height: prevBlock.height, next_best: HASH }),
      [`/block/${PREV}/txs/0`]: { body: [coinbase] },
    });
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Version")).toBe("0x20000000"));
    history.set({ value: `/block/${PREV}` });
    await until(() => expect(fact(el, "Version")).toBe("0x00000004"));
    history.set({ value: `/block/${HASH}` });
    await until(() => expect(text(el.querySelector("h1") as Element)).toBe("Block 975 411"));
    expect(fact(el, "Version")).toBe("0x20000000");
  });

  it("renders a hostile coinbase tag as text", async () => {
    serve(normal());
    const el = open(`/block/${HASH}`);
    await until(() => expect(fact(el, "Coinbase tag")).toContain("<img src=x onerror=alert(1)>"));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".block-tag__hidden")?.textContent).toBe("·");
  });

  it("loads more transactions below the first page", async () => {
    serve(normal());
    const el = open(`/block/${HASH}`);
    const button = await until(() => {
      const b = [...el.querySelectorAll("button")].find((x) => x.textContent === "Show 5 more");
      expect(b).toBeDefined();
      return b as HTMLButtonElement;
    });
    button.click();
    await until(() => expect(el.querySelectorAll("tbody tr")).toHaveLength(30));
    expect(text(el.querySelector(".section__meta") as Element)).toContain("30 of 30");
    expect([...el.querySelectorAll("button")].some((x) => x.textContent?.includes("more"))).toBe(
      false,
    );
  });

  it("resolves a height, and marks the genesis and the newest block", async () => {
    serve({
      ...normal(),
      [`/block/${HASH}`]: { body: { ...block, previousblockhash: null, height: 0 } },
      [`/block/${HASH}/status`]: status({ next_best: null, height: 0 }),
      "/block-height/0": { body: HASH },
    });
    const el = open("/block/0");
    await until(() =>
      expect(text(el.querySelector(".block-pager") as Element)).toContain("Genesis block"),
    );
    expect(text(el.querySelector(".block-pager") as Element)).toContain("The newest block");
    expect(calls).toContain("/block-height/0");
  });

  it("follows the newest block until the next is found, before it followed or after", async () => {
    let found = false;
    serve({
      ...normal(),
      [`/block/${HASH}/status`]: () => status({ next_best: found ? NEXT : null }),
    });
    const el = open(`/block/${HASH}`);
    const pager = () => text(el.querySelector(".block-pager") as Element);
    await until(() => expect(pager()).toContain("The newest block"));
    const asked = () => calls.filter((c) => c === `/block/${HASH}/status`).length;
    expect(asked()).toBe(1);
    const ws = await until(() => FakeSocket.last());
    ws.hello({ network: "mainnet" });
    // The tip as it stands is this block: nothing to ask.
    ws.receive({ topic: "blocks", type: "block", block: { ...block, id: HASH } });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(asked()).toBe(1);
    expect(pager()).toContain("The newest block");
    // The next one, found whether before the subscription took effect or after.
    found = true;
    ws.receive({ topic: "blocks", type: "block", block: { ...block, id: NEXT, height: 975_412 } });
    await until(() => expect(pager()).toContain("Next: 975 412"));
    expect(asked()).toBe(2);
    // The first ask may come from the browser's cache; the one the block prompted may not.
    expect(caching.filter((_, i) => calls[i] === `/block/${HASH}/status`)).toStrictEqual([
      undefined,
      "no-cache",
    ]);
  });

  it("asks again when the next block was announced while its status was on its way", async () => {
    let answer: (r: Reply) => void = () => undefined;
    serve({
      ...normal(),
      // The node answered before the next block; the answer arrives after its announcement.
      [`/block/${HASH}/status`]: (n) =>
        n === 1
          ? new Promise<Reply>((resolve) => {
              answer = resolve;
            })
          : status(),
    });
    const el = open(`/block/${HASH}`);
    const ws = await until(() => FakeSocket.last());
    ws.hello({ network: "mainnet" });
    ws.receive({ topic: "blocks", type: "block", block: { ...block, id: NEXT, height: 975_412 } });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    answer(status({ next_best: null }));
    await until(() =>
      expect(text(el.querySelector(".block-pager") as Element)).toContain("Next: 975 412"),
    );
  });

  it("follows the newest block opened from an older one, through a block found meanwhile", async () => {
    let answer: (r: Reply) => void = () => undefined;
    serve({
      ...normal(),
      [`/block/${PREV}`]: { body: { ...block, id: PREV, height: block.height - 1 } },
      [`/block/${PREV}/status`]: status({ height: block.height - 1, next_best: HASH }),
      [`/block/${PREV}/txs/0`]: { body: [coinbase] },
      [`/block/${HASH}/status`]: (n) =>
        n === 1
          ? new Promise<Reply>((resolve) => {
              answer = resolve;
            })
          : status(),
    });
    const el = open(`/block/${PREV}`);
    await until(() =>
      expect(text(el.querySelector(".block-pager") as Element)).toContain("Next: 975 411"),
    );
    const ws = await until(() => FakeSocket.last());
    ws.hello({ network: "mainnet" });
    history.set({ value: `/block/${HASH}` });
    await until(() => expect(calls).toContain(`/block/${HASH}/status`));
    // The older block's "next" is this block: it must not stand for this one's while it loads.
    const next = () => el.querySelector(".block-pager a[rel=next]")?.getAttribute("href");
    expect(next()).toBeUndefined();
    ws.receive({ topic: "blocks", type: "block", block: { ...block, id: NEXT, height: 975_412 } });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    answer(status({ next_best: null }));
    await until(() => expect(next()).toBe(`/block/${NEXT}`));
  });

  it("asks nothing more for an older block, whatever the topic says", async () => {
    serve(normal());
    const el = open(`/block/${HASH}`);
    const ws = await until(() => FakeSocket.last());
    ws.hello({ network: "mainnet" });
    ws.receive({ topic: "blocks", type: "block", block: { ...block, id: NEXT, height: 975_412 } });
    await until(() =>
      expect(text(el.querySelector(".block-pager") as Element)).toContain("Next: 975 412"),
    );
    ws.receive({ topic: "blocks", type: "block", block: { ...block, id: "ef".repeat(32) } });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(calls.filter((c) => c === `/block/${HASH}/status`)).toHaveLength(1);
  });

  it("marks a block that is not on the best chain", async () => {
    serve({
      ...normal(),
      [`/block/${HASH}/status`]: status({ in_best_chain: false, next_best: null, height: null }),
    });
    const el = open(`/block/${HASH}`);
    await until(() => expect(el.querySelector(".block-status")?.textContent).toContain("Stale"));
    expect(text(el.querySelector(".block-notice") as Element)).toContain("not on the best chain");
    expect(fact(el, "Confirmations")).toContain("0");
    expect(el.querySelector('a[rel="next"]')).toBeNull();
  });

  it("says when a hash is unknown", async () => {
    serve({ "/blocks/tip/height": { body: "975420" } });
    const el = open(`/block/${"ab".repeat(32)}`);
    await until(() => expect(el.querySelector("h1")?.textContent).toBe("Block not found"));
  });

  it("says when a height is above the tip", async () => {
    serve({ "/blocks/tip/height": { body: "975420" } });
    const el = open("/block/99999999");
    await until(() =>
      expect(text(el.querySelector("h1") as Element)).toBe("No block 99 999 999 yet"),
    );
    await until(() => expect(text(el)).toContain("The newest block is 975 420"));
  });

  it("refuses input that is neither a hash nor a height", () => {
    serve({});
    const el = open("/block/%3Cscript%3Ex");
    expect(el.querySelector("h1")?.textContent).toBe("Not a block");
    expect(text(el)).toContain("“<script>x” is not a block hash or a height");
    expect(el.querySelector("script")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("offers a retry when the node is unavailable", async () => {
    const down = { status: 502, body: { error: "node unavailable" } };
    serve({ ...normal(), [`/block/${HASH}`]: (n) => (n === 1 ? down : { body: block }) });
    const el = open(`/block/${HASH}`);
    const retry = await until(() => {
      const b = el.querySelector<HTMLButtonElement>(".state--error button");
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    expect(text(el)).toContain("Node unavailable.");
    retry.click();
    await until(() => expect(text(el.querySelector("h1") as Element)).toBe("Block 975 411"));
  });

  it("takes the fees from the summary and says when the miner claimed less than it could", async () => {
    // Block 124 724 on mainnet did this: the coinbase pays less than the subsidy alone.
    const short = {
      ...coinbase,
      vin: [{ txid: "00".repeat(32), vout: 0xffffffff, is_coinbase: true, scriptsig: "0333e20e" }],
      vout: [{ ...coinbase.vout[0], value: 312_000_000 }] as Transaction["vout"],
    };
    serve({
      ...normal(),
      [`/block/${HASH}/txs/0`]: {
        body: [short, tx(1, { fee: 0 }), ...Array.from({ length: 23 }, (_, i) => tx(i + 2))],
      },
    });
    const el = open(`/block/${HASH}`);
    // A transaction that pays nothing has a rate of zero, not a missing one.
    await until(() =>
      expect(text(el.querySelectorAll("tbody tr")[1]?.querySelectorAll("td")[1] as Element)).toBe(
        "0.00 sat/vB",
      ),
    );
    await until(() => expect(fact(el, "Total fees")).toContain("0.00500000 BTC"));
    expect(fact(el, "Total fees")).toContain("500 000 sats");
    await until(() =>
      expect(fact(el, "Reward")).toContain(
        "3.12000000 BTC0.01000000 BTC less than the subsidy and fees allowed",
      ),
    );
    // A tag with nothing after the height says so, rather than "shown as hex" over a dash.
    expect(fact(el, "Coinbase tag")).toBe("NoneThe miner wrote nothing after the height");
  });

  it("uses the network's halving interval", async () => {
    serve(normal());
    const el = open(`/signet/block/${HASH}`);
    await until(() => expect(fact(el, "Reward")).toContain("3.12500000 BTC subsidy"));
  });
});

describe("BlocksPage", () => {
  const list = (from: number) =>
    Array.from({ length: Math.min(10, from + 1) }, (_, i) => ({
      ...block,
      id: `${from - i}`.padStart(64, "0"),
      height: from - i,
    }));

  it("lists the newest 25 blocks from three of the API's answers and pages back", async () => {
    serve({
      "/blocks": { body: list(975_420) },
      "/blocks/975410": { body: list(975_410) },
      "/blocks/975400": { body: list(975_400) },
      "/blocks/tip/height": { body: "975420" },
    });
    const el = open("/blocks");
    await until(() =>
      expect(text(el.querySelector("tbody tr td .blocks-height") as Element)).toBe("975 420"),
    );
    await until(() => expect(el.querySelectorAll("tbody tr")).toHaveLength(25));
    expect(text(el.querySelectorAll("tbody tr .blocks-height")[24] as Element)).toBe("975 396");
    expect(el.querySelector('a[rel="next"]')?.getAttribute("href")).toBe("/blocks/975395");
    expect(el.querySelector('a[rel="prev"]')).toBeNull();
  });

  it("links newer pages and stops at the genesis block", async () => {
    serve({ "/blocks/5": { body: list(5) }, "/blocks/tip/height": { body: "975420" } });
    const el = open("/blocks/5");
    await until(() => expect(el.querySelectorAll("tbody tr")).toHaveLength(6));
    expect(el.querySelector('a[rel="prev"]')?.getAttribute("href")).toBe("/blocks/30");
    expect(el.querySelector('a[rel="next"]')).toBeNull();
  });

  it("fills each row's fee figures on its own, so a busy row does not hold up the rest", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = list(975_420);
    const table: typeof replies = {
      "/blocks": { body: rows },
      "/blocks/975410": { body: [] },
      "/blocks/tip/height": { body: "975420" },
    };
    for (const [i, b] of rows.entries()) {
      table[summaryPath(b.id)] = {
        body: [i === 1 ? { ...COINBASE_ONLY, id: b.id } : { ...SUMMARY, id: b.id }],
      };
    }
    const slow = rows[2]?.id ?? "";
    table[summaryPath(slow)] = (n) =>
      n === 1
        ? { status: 503, body: { error: "busy" }, headers: { "retry-after": "1" } }
        : { body: [{ ...SUMMARY, id: slow, fees: 7 }] };
    serve(table);
    const el = open("/blocks");
    const row = (i: number) => text(el.querySelectorAll("tbody tr")[i] as Element);
    await until(() => expect(row(0)).toContain("1.09"));
    expect(row(0)).toContain("0.00500000");
    expect(row(1)).toContain("None");
    expect(el.querySelectorAll("tbody tr")[2]?.querySelector(".block-skel")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1300);
    await until(() => expect(row(2)).toContain("0.00000007"));
  });

  it("gives each audited block its match rate, and a dash to a block without one", async () => {
    const rows = list(975_420);
    const table: typeof replies = {
      "/blocks": { body: rows },
      "/blocks/975410": { body: [] },
      "/blocks/tip/height": { body: "975420" },
    };
    for (const [i, b] of rows.entries()) {
      table[summaryPath(b.id)] = {
        body: [{ ...SUMMARY, id: b.id, audit: i === 0 ? AUDIT : null }],
      };
    }
    serve(table);
    const el = open("/blocks");
    const header = [...el.querySelectorAll("thead th")].map((th) => text(th));
    const col = header.indexOf("Match rate, %");
    expect(col).toBeGreaterThan(-1);
    const cell = (i: number) =>
      text(el.querySelectorAll("tbody tr")[i]?.querySelectorAll("td")[col] as Element);
    await until(() => expect(cell(0)).toBe("99.87%"));
    await until(() =>
      expect(text(el.querySelectorAll("tbody tr")[1] as Element)).toContain("1.09"),
    );
    expect(cell(1)).toBe("–no audit");
  });

  it("refuses a bad height", () => {
    serve({});
    const el = open("/blocks/abc");
    expect(text(el)).toContain("“abc” is not a block height");
  });
});

describe("BlockPage's Lightning panel", () => {
  const lnPath = `/app/lightning/block/${HASH}`;
  const end = (n: number, alias: string | null) => ({ id: `02${String(n).repeat(64)}`, alias });
  const chan = (n: number, capacity: number) => ({
    id: `975411x${n}x0`,
    scid: String(1_072_000_000 + n),
    capacity,
    node_one: end(1, "ACINQ"),
    node_two: end(2, "<img src=x onerror=alert(1)>"),
  });
  const answer = (opened: number[], closed: string[], forced: number, capacity = 0) => ({
    opened: { count: opened.length, capacity, channels: opened.map((c, i) => chan(i, c)) },
    closed: {
      count: closed.length,
      forced,
      channels: closed.map((kind, i) => ({ ...chan(100 + i, 1_000_000), kind })),
    },
  });
  const withLightning = (reply: Reply) => {
    config.lightning = ["mainnet"];
    serve({ ...normal(), [lnPath]: reply });
  };
  const summary = (el: Element) => text(el.querySelector(".blk-ln summary") ?? el);
  const loaded = (el: Element) => until(() => expect(fact(el, "Reward")).toContain("BTC"));

  /** Long enough for a panel that was coming to have come. */
  const moment = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

  afterEach(() => {
    config.lightning = [];
  });

  it("asks nothing on a network without Lightning", async () => {
    serve(normal());
    const el = open(`/block/${HASH}`);
    await loaded(el);
    await until(() => expect(calls).toContain(txsPath));
    expect(calls.some((c) => c.includes("/lightning/"))).toBe(false);
    expect(el.querySelector(".blk-ln")).toBeNull();
  });

  it("says what many channels did, closed, and lists them when opened", async () => {
    const caps = Array.from({ length: 12 }, (_, i) => 1_000_000 * (i + 1));
    withLightning({
      body: answer(
        caps,
        ["force", "penalty", "cooperative", "other", "cooperative"],
        2,
        78_000_000,
      ),
    });
    const el = open(`/block/${HASH}`);
    await until(() => expect(el.querySelector(".blk-ln")).not.toBeNull());
    expect(summary(el)).toBe(
      "Lightning in this block: 12 channels opened (0.780 BTC), 5\u00A0closed (2\u00A0forced)",
    );
    const details = el.querySelector("details.blk-ln") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // Directly under the facts, before the map and the transactions.
    const side = el.querySelector(".block-side") as Element;
    for (const [a, b] of [
      [side, details],
      [details, el.querySelector(".block-core") as Element],
      [details, el.querySelector(".block-txs") as Element],
    ] as const) {
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    // Opened first, then closed, each tagged; aliases are text.
    // The list inside is the lazy part's, drawn once it has loaded.
    await until(() => expect(details.querySelectorAll("tbody tr")).toHaveLength(17));
    const rows = [...details.querySelectorAll("tbody tr")];
    expect(text(rows[0] as Element)).toContain("Opened");
    expect(text(rows[12] as Element)).toContain("Force");
    expect(text(rows[13] as Element)).toContain("Penalty");
    expect(details.querySelector("img")).toBeNull();
    expect(text(details)).toContain("<img src=x onerror=alert(1)>");
    expect(text(details)).toContain("Public channels only.");
    expect(text(details)).not.toContain("not listed");
  });

  it("asks together with the block, not after it", async () => {
    config.lightning = ["mainnet"];
    serve({
      ...normal(),
      // The block's own reply never comes.
      [`/block/${HASH}`]: () => new Promise<Reply>(() => {}),
      [lnPath]: { body: answer([1_000_000], [], 0, 1_000_000) },
    });
    const el = open(`/block/${HASH}`);
    await until(() => expect(summary(el)).toContain("1 channel opened"));
  });

  it("asks once a block opened by height has its hash", async () => {
    withLightning({ body: answer([], ["force"], 1) });
    const el = open("/block/975411");
    await until(() => expect(el.querySelector(".blk-ln")).not.toBeNull());
    expect(calls.indexOf("/block-height/975411")).toBeLessThan(calls.indexOf(lnPath));
  });

  it("says one channel in the singular, leaves out none forced, and counts what it left out", async () => {
    withLightning({
      body: {
        ...answer([5_000_000], ["cooperative"], 0, 5_000_000),
        opened: { count: 140, capacity: 5_000_000, channels: [chan(0, 5_000_000)] },
      },
    });
    const el = open(`/block/${HASH}`);
    await until(() => expect(el.querySelector(".blk-ln")).not.toBeNull());
    expect(summary(el)).toBe(
      "Lightning in this block: 140 channels opened (0.0500 BTC), 1\u00A0closed",
    );
    expect(text(el.querySelector(".blk-ln") as Element)).toContain("139 smaller not listed.");
  });

  it("words closes alone, one and many", async () => {
    withLightning({ body: answer([], ["force"], 1) });
    const el = open(`/block/${HASH}`);
    await until(() => expect(el.querySelector(".blk-ln")).not.toBeNull());
    expect(summary(el)).toBe("Lightning in this block: 1 channel\u00A0closed (1\u00A0forced)");
  });

  it("shows no panel for a block with no channels", async () => {
    withLightning({ body: answer([], [], 0) });
    const el = open(`/block/${HASH}`);
    await loaded(el);
    await until(() => expect(calls).toContain(lnPath));
    await moment();
    expect(el.querySelector(".blk-ln")).toBeNull();
  });

  it.each([
    ["an error", { status: 500, body: { error: "internal error" } }],
    [
      "a graph still syncing",
      { status: 503, body: { error: "lightning graph is still syncing; retry" } },
    ],
    ["a reply it cannot read", { body: { opened: { count: 3 }, closed: [] } }],
  ] as const)("shows no panel, and the block, on %s", async (_why, reply) => {
    withLightning(reply);
    const el = open(`/block/${HASH}`);
    await loaded(el);
    await until(() => expect(calls).toContain(lnPath));
    await moment();
    expect(el.querySelector(".blk-ln")).toBeNull();
    expect(el.querySelector(".state--error, [role=alert]")).toBeNull();
    expect(text(el.querySelector("h1") as Element)).toBe("Block 975 411");
  });
});
