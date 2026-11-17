import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import type { Block } from "../../lib/esplora";
import { FakeSocket, fakeBlock } from "../../lib/fakes";
import { groupDigits } from "../../lib/format";
import { type BlockSummary, clearSummaries } from "../../lib/summary";
import HomePage from "./HomePage";
import { FEES_CONFIRM_MS, FEES_POLL_MS } from "./fees";
import { PACE_MS } from "./RecentTxs";

const chain = (from: number, to: number, branch = "a") =>
  Array.from({ length: to - from + 1 }, (_, i) => fakeBlock(to - i, branch));

const MEMPOOL = {
  count: 3,
  vsize: 1500,
  total_fee: 4200,
  fee_histogram: [
    [5, 500],
    [1, 500],
    [0.15, 500],
  ],
};
/** A `fees` message: rates fastest first, in sat per 1,000 vB as on the wire. */
const feesMsg = (source: "projected" | "node", [high, medium, low, noRush]: number[]) => ({
  topic: "fees",
  type: "fees",
  source,
  tip: source === "projected" ? { height: 10, hash: fakeBlock(10).id } : null,
  levels: [
    { name: "high", blocks: 1, minutes: 10, rate: high },
    { name: "medium", blocks: 3, minutes: 30, rate: medium },
    { name: "low", blocks: 6, minutes: 60, rate: low },
    { name: "no_rush", blocks: 144, minutes: 1440, rate: noRush },
  ],
  min_fee_rate: 100,
});
const RECENT = [{ txid: "c".repeat(64), fee: 300, vsize: 150, value: 12_345 }];

let replies: Record<string, () => Response>;
/** The batch summary route; unset, it is a 404 and tiles keep their neutral gauge. */
let summaries: ((hashes: string[]) => Response | Promise<Response>) | undefined;
let blocksServed: Block[];
let requests: string[];

function serve() {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace(/^\/(regtest|signet)\/api/, "");
    requests.push(path);
    const batch = /\/app\/blocks\/summary\?hashes=(.*)$/.exec(path);
    if (batch && summaries) return summaries(batch[1]?.split(",") ?? []);
    const reply = replies[path];
    if (reply) return reply();
    return Response.json({ error: "not found" }, { status: 404 });
  });
}

beforeEach(() => {
  clearApiCache();
  clearSummaries();
  summaries = undefined;
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  requests = [];
  blocksServed = chain(1, 10);
  replies = {
    "/blocks": () => Response.json(blocksServed),
    "/mempool": () => Response.json(MEMPOOL),
    "/mempool/recent": () => Response.json(RECENT),
  };
  serve();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The mined tiles on screen, not the ones fading out. */
const tileHeights = (el: HTMLElement) =>
  [
    ...el.querySelectorAll<HTMLElement>(
      ".home-strip__lane > li[data-height]:not(.home-tile--leaving)",
    ),
  ].map((li) => Number(li.dataset["height"]));
const blocksFetches = () => requests.filter((p) => p === "/blocks").length;

/** The server says it does not track this network's mempool: every mempool topic is off. */
function mempoolOff(ws: FakeSocket) {
  for (const topic of ["mempool", "projected", "transactions"]) ws.receive({ topic, type: "off" });
}

/** Opens the page; unless `live`, the server's mempool engine is off, so the panels poll. */
async function open(live = false) {
  const el = mount(() => <HomePage />, "/regtest/");
  await vi.waitFor(() => expect(tileHeights(el)).toHaveLength(10));
  const ws = FakeSocket.last();
  ws.hello();
  if (!live) mempoolOff(ws);
  return { el, ws };
}

describe("home page", () => {
  it("shows skeletons shaped like the content while loading", () => {
    replies["/blocks"] = () => new Promise<Response>(() => {}) as unknown as Response;
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const el = mount(() => <HomePage />, "/regtest/");
    expect(el.querySelectorAll(".home-tile--skeleton")).toHaveLength(10);
    expect(el.querySelector(".home-stats")?.getAttribute("aria-busy")).toBe("true");
    expect(el.querySelectorAll(".home-recent tbody tr")).toHaveLength(6);
    expect(el.querySelector(".home-live")?.textContent).toContain("Connecting");
  });

  it("shows the blocks, the mempool, the fees and the latest transactions", async () => {
    const { el, ws } = await open();
    ws.receive(feesMsg("node", [5200, 1100, 500, 120]));
    expect(tileHeights(el)).toStrictEqual(chain(1, 10).map((b) => b.height));
    expect(el.querySelector(".home-tile--mined a")?.getAttribute("href")).toBe(
      `/regtest/block/${fakeBlock(10).id}`,
    );
    await vi.waitFor(() => expect(el.querySelector(".home-stats")?.textContent).toContain("3"));
    expect(el.querySelector(".home-stats")?.textContent).toContain("1\u202F500 vB");
    expect(el.querySelector(".home-stats")?.textContent).toContain("≈ 1 block");
    expect(el.querySelector(".home-fees__list")?.textContent).toContain("5.20");
    expect(el.querySelector(".home-fees__note")?.textContent).toContain("node's own estimates");
    await vi.waitFor(() =>
      expect(el.querySelector(".home-recent tbody")?.textContent).toContain("cccccccc"),
    );
    expect(el.querySelector(".home-live")?.textContent).toContain("Live");
  });

  it("explains a block timed before its parent, on its tile and in its label", async () => {
    // Block 8 is timed 5 s before block 7; the others are ten minutes apart.
    blocksServed = chain(1, 10);
    const early = blocksServed.find((b) => b.height === 8);
    if (early) early.timestamp = fakeBlock(7).timestamp - 5;
    const { el } = await open();
    const tile = (h: number) => el.querySelector(`.home-strip__lane > li[data-height="${h}"]`);
    const note = tile(8)?.querySelector(".note-figure .visually-hidden");
    expect(note?.textContent).toContain("Timed 5 s before block 7");
    expect(tile(8)?.querySelector("a")?.getAttribute("aria-label")).toContain(
      "timed 5 s before the block it follows",
    );
    // Its neighbours and the oldest tile, whose parent the strip has not loaded, have no note.
    for (const h of [9, 7, 1]) expect(tile(h)?.querySelector(".note-figure")).toBeNull();
  });

  it("says what failed when the node is unavailable, section by section", async () => {
    for (const path of Object.keys(replies)) {
      replies[path] = () => Response.json({ error: "upstream unavailable" }, { status: 502 });
    }
    const el = mount(() => <HomePage />, "/regtest/");
    FakeSocket.last().hello();
    mempoolOff(FakeSocket.last());
    FakeSocket.last().receive({ topic: "fees", type: "unavailable" });
    await vi.waitFor(() => expect(el.querySelectorAll('[role="alert"]')).toHaveLength(3));
    expect(el.textContent).toContain("Could not load the latest blocks");
    expect(el.textContent).toContain("Upstream unavailable.");
    expect(el.textContent).toContain("Could not load the mempool");
    expect(el.textContent).toContain("No recommendation right now");
  });

  it("shows an empty mempool as empty, not as missing", async () => {
    replies["/mempool"] = () =>
      Response.json({ count: 0, vsize: 0, total_fee: 0, fee_histogram: [] });
    replies["/mempool/recent"] = () => Response.json([]);
    const { el } = await open();
    await vi.waitFor(() =>
      expect(el.querySelector(".home-next .home-picture__meta")?.textContent).toBe(
        "Nothing waiting",
      ),
    );
    expect(el.textContent).toContain("No transactions are waiting");
    expect(el.querySelector(".home-stats")?.textContent).toContain("empty");
  });

  it("says when the live connection is down, and keeps the strip moving over HTTP", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { el, ws } = await open();
      ws.drop(1006);
      await vi.waitFor(() =>
        expect(el.querySelector(".home-live")?.textContent).toContain("Reconnecting"),
      );
      expect(el.querySelector(".home-live")?.textContent).toContain("Blocks refresh every 15 s");
      blocksServed = chain(2, 11);
      const before = blocksFetches();
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(11));
      expect(blocksFetches()).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the strip, kept live", () => {
  it("adds each block of a burst as it arrives, without asking HTTP", async () => {
    const { el, ws } = await open();
    const fetched = blocksFetches();
    for (let h = 11; h <= 14; h++)
      ws.receive({ topic: "blocks", type: "block", block: fakeBlock(h) });
    expect(tileHeights(el)).toStrictEqual(chain(5, 14).map((b) => b.height));
    expect(blocksFetches()).toBe(fetched);
  });

  it("refetches over HTTP on a gap, and the blocks it moves past the live list stay as the past", async () => {
    const { el, ws } = await open();
    blocksServed = chain(4, 13);
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(13) });
    await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(13));
    // Before layout the window is the live list's ten; the three it moved on are older blocks now,
    // kept for when the strip scrolls to them, not ghosts fading out.
    expect(tileHeights(el)).toStrictEqual(chain(4, 13).map((b) => b.height));
    expect(el.querySelectorAll(".home-strip__lane > .home-tile--leaving")).toHaveLength(0);
  });

  it("refetches on a resync whose tip differs, and not on one that matches", async () => {
    const { el, ws } = await open();
    const fetched = blocksFetches();
    ws.receive({ topic: "blocks", type: "resync", tip: { height: 10, hash: fakeBlock(10).id } });
    ws.receive({ topic: "blocks", type: "resync", tip: null });
    expect(blocksFetches()).toBe(fetched);
    blocksServed = chain(2, 11);
    ws.receive({ topic: "blocks", type: "resync", tip: { height: 11, hash: fakeBlock(11).id } });
    await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(11));
  });

  it("keeps asking after a resync until HTTP has the announced block", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { el, ws } = await open();
      // The server's cache still holds the list from before block 11, twice.
      let stale = 2;
      replies["/blocks"] = () => Response.json(stale-- > 0 ? chain(1, 10) : chain(2, 11));
      ws.receive({ topic: "blocks", type: "resync", tip: { height: 11, hash: fakeBlock(11).id } });
      await vi.waitFor(() => expect(blocksFetches()).toBeGreaterThanOrEqual(2));
      expect(tileHeights(el)[0]).toBe(10);
      vi.advanceTimersByTime(1_500);
      await vi.waitFor(() => expect(blocksFetches()).toBeGreaterThanOrEqual(3));
      vi.advanceTimersByTime(1_500);
      await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(11));
      // Caught up: no more asking.
      const settled = blocksFetches();
      vi.advanceTimersByTime(10_000);
      expect(blocksFetches()).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps asking after a failed fetch for an announced block, but not forever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { el, ws } = await open();
      replies["/blocks"] = () => Response.json({ error: "upstream unavailable" }, { status: 502 });
      ws.receive({ topic: "blocks", type: "resync", tip: { height: 11, hash: fakeBlock(11).id } });
      // The first load, the resync's fetch, then eight retries.
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1_500);
      expect(blocksFetches()).toBe(10);
      // Under the socket's 30 s ping, which this fake server would leave unanswered.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(blocksFetches()).toBe(10);

      // The next announcement starts afresh, even though the node still serves the old list.
      replies["/blocks"] = () => Response.json(chain(1, 10));
      ws.receive({ topic: "blocks", type: "resync", tip: { height: 12, hash: fakeBlock(12).id } });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(blocksFetches()).toBe(12);
      replies["/blocks"] = () => Response.json(chain(3, 12));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(12));
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches after a reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { el, ws } = await open();
      ws.drop(1001);
      blocksServed = chain(3, 12);
      vi.advanceTimersByTime(1000);
      FakeSocket.last().hello();
      await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(12));
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a reorg: drops the replaced blocks, then takes the new branch", async () => {
    const { el, ws } = await open();
    ws.receive({ topic: "blocks", type: "reorg", fork_height: 8 });
    expect(tileHeights(el)).toStrictEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(9, "b", "a") });
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(10, "b") });
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11, "b") });
    const ids = [...el.querySelectorAll<HTMLElement>(".home-strip__lane > li[data-id]")].map(
      (li) => li.dataset["id"],
    );
    expect(ids.slice(0, 3)).toStrictEqual([
      fakeBlock(11, "b").id,
      fakeBlock(10, "b").id,
      fakeBlock(9, "b").id,
    ]);
    expect(tileHeights(el)).toStrictEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it("applies a block that arrives while the first list is loading, once it lands", async () => {
    let release: (() => void) | undefined;
    replies["/blocks"] = () => Response.json(chain(1, 10));
    vi.stubGlobal("fetch", async (url: string) => {
      const path = url.replace(/^\/regtest\/api/, "");
      requests.push(path);
      if (path === "/blocks") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return (replies[path] ?? (() => Response.json({}, { status: 404 })))();
    });
    const el = mount(() => <HomePage />, "/regtest/");
    const ws = FakeSocket.last();
    ws.hello();
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(11));
    expect(tileHeights(el)).toHaveLength(10);
  });

  it("announces a new block politely", async () => {
    const { el, ws } = await open();
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    expect(el.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Block 11 mined: 1 transaction.",
    );
  });
});

describe("the strip's past", () => {
  // A desktop strip, laid out by hand: the lane starts 600 px in, tiles are 132 px wide with
  // 12 px between, the view is 1,000 px wide, and the "now" line ends at 582 px.
  const restore: (() => void)[] = [];
  const stub = (proto: object, key: string, d: PropertyDescriptor) => {
    const was = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, ...d });
    restore.push(() =>
      was ? Object.defineProperty(proto, key, was) : Reflect.deleteProperty(proto, key),
    );
  };
  let scrolled = new WeakMap<Element, number>();
  beforeEach(() => {
    scrolled = new WeakMap();
    const has = (el: Element, c: string) => el.classList.contains(c);
    stub(HTMLElement.prototype, "offsetLeft", {
      get(this: HTMLElement) {
        return has(this, "home-strip__mined") ? 600 : has(this, "home-strip__now") ? 580 : 0;
      },
    });
    stub(HTMLElement.prototype, "offsetWidth", {
      get(this: HTMLElement) {
        return has(this, "home-strip__now") ? 2 : 0;
      },
    });
    stub(HTMLElement.prototype, "clientWidth", {
      get(this: Element) {
        return has(this, "home-strip__scroller") ? 1000 : 0;
      },
    });
    stub(Element.prototype, "scrollLeft", {
      get(this: Element) {
        return scrolled.get(this) ?? 0;
      },
      set(this: Element, v: number) {
        scrolled.set(this, Math.max(0, v));
        // As in a browser, the scroll event comes after, not inside, whatever scrolled.
        setTimeout(() => this.dispatchEvent(new Event("scroll")), 0);
      },
    });
    stub(Element.prototype, "scrollTo", {
      value(this: Element, o: ScrollToOptions) {
        (this as HTMLElement).scrollLeft = o.left ?? 0;
      },
    });
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      const width = el.classList.contains("home-tile") ? "132px" : undefined;
      const gap = el.classList.contains("home-strip__lane") ? "12px" : undefined;
      return new Proxy(style, {
        get: (t, k) => {
          if (k === "width" && width) return width;
          if (k === "columnGap" && gap) return gap;
          const v: unknown = Reflect.get(t, k);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    });
    restore.push(() => spy.mockRestore());
    replies["/v1/blocks/10"] = () => Response.json(chain(0, 10));
  });
  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
  });

  const scroller = (el: HTMLElement) => el.querySelector(".home-strip__scroller") as HTMLElement;
  const back = (el: HTMLElement) =>
    el.querySelector<HTMLButtonElement>('button[aria-label="Back to now"]') ?? undefined;

  it("loads older blocks ahead of the view, down to block 0, in one request", async () => {
    const { el } = await open();
    // Four tiles in view and six beyond: block 0 is just past the window, and already loaded.
    await vi.waitFor(() => expect(requests).toContain("/v1/blocks/10"));
    expect(tileHeights(el)).toStrictEqual(chain(1, 10).map((b) => b.height));
    scroller(el).scrollLeft = 600 + 8 * 144;
    await vi.waitFor(() => expect(tileHeights(el)).toContain(0));
    expect(requests.filter((p) => /^\/(v1\/)?blocks\//.test(p))).toStrictEqual(["/v1/blocks/10"]);
    // Its facts are asked for once the strip stops: one batch for the older tiles in the page.
    await vi.waitFor(() => expect(summaryRequests().at(-1)).toContain(fakeBlock(0).id));
    // The lane ends at block 0: eleven slots, and nothing after.
    expect(
      (el.querySelector(".home-strip__lane") as HTMLElement).style.getPropertyValue("--slots"),
    ).toBe("11");
    // Scrolled that far, the way back shows.
    expect(back(el)).toBeDefined();
  });

  it("keeps the view still when a block or a reorg comes while away, and plays it at now", async () => {
    const { el, ws } = await open();
    await vi.waitFor(() => expect(requests).toContain("/v1/blocks/10"));
    const s = scroller(el);
    // Into the past: tile 5 (block 5) at the left edge.
    s.scrollLeft = 600 + 5 * 144;
    await vi.waitFor(() => expect(back(el)).toBeDefined());
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    await vi.waitFor(() => expect(s.scrollLeft).toBe(600 + 6 * 144));
    // Nothing flew in: the new tile is simply there, and the reader is still told.
    expect(el.querySelector(".home-tile--landing")).toBeNull();
    expect(el.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Block 11 mined: 1 transaction.",
    );
    // A reorg takes 10 and 11 away: the view moves back with the tip, by two tiles.
    ws.receive({ topic: "blocks", type: "reorg", fork_height: 9 });
    await vi.waitFor(() => expect(s.scrollLeft).toBe(600 + 4 * 144));
    // Back to now: the line in the middle again, and the next block crosses it.
    back(el)?.click();
    await vi.waitFor(() => expect(back(el)).toBeUndefined());
    expect(s.scrollLeft).toBe(81);
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(10, "b", "a") });
    await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(10));
    expect(el.querySelector(".home-tile--landing")).not.toBeNull();
  });

  it("keeps a focused tile in the page when the strip scrolls away from it, and Home goes back", async () => {
    const { el } = await open();
    await vi.waitFor(() => expect(requests).toContain("/v1/blocks/10"));
    // One Tab stop: the newest tile, until another has focus. Arrow keys walk from it.
    const stops = () => [...el.querySelectorAll('.home-strip__lane a[tabindex="0"]')];
    expect(stops()).toStrictEqual([tile(el, 10)?.querySelector("a")]);
    tile(el, 9)?.querySelector("a")?.focus();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    const link = tile(el, 8)?.querySelector("a") as HTMLElement;
    expect(document.activeElement).toBe(link);
    await vi.waitFor(() => expect(stops()).toStrictEqual([link]));
    scroller(el).scrollLeft = 600 + 10 * 144;
    await vi.waitFor(() => expect(back(el)).toBeDefined());
    expect(link.isConnected).toBe(true);
    expect(document.activeElement).toBe(link);
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await vi.waitFor(() => expect(back(el)).toBeUndefined());
    expect(document.activeElement).toBe(tile(el, 10)?.querySelector("a"));
  });
});

describe("the live indicator", () => {
  it("says the node is not answering when the socket is up but the panels fail", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { el } = await open();
      await vi.waitFor(() => expect(el.querySelector(".home-live")?.textContent).toBe("Live"));
      replies["/mempool/recent"] = () =>
        Response.json({ error: "upstream unavailable" }, { status: 502 });
      vi.advanceTimersByTime(5_000);
      await vi.waitFor(() =>
        expect(el.querySelector(".home-live")?.textContent).toContain("Node not answering"),
      );
      expect(el.querySelector(".home-live")?.textContent).toContain("Figures may be out of date.");
      replies["/mempool/recent"] = () => Response.json(RECENT);
      vi.advanceTimersByTime(5_000);
      await vi.waitFor(() => expect(el.querySelector(".home-live")?.textContent).toBe("Live"));
    } finally {
      vi.useRealTimers();
    }
  });
});

const facts = (id: string, over: Partial<BlockSummary> = {}): BlockSummary => ({
  id,
  height: 0,
  tx_count: 3,
  fees: 900,
  vsize: 400,
  weight: 1600,
  fee_rate: { min: 0.1, p10: 0.1, p25: 0.15, median: 1.234, p75: 3, p90: 4, max: 12.5 },
  fee_bands: [100, 0, 0, 0, 200, 0, 0, 0, 0, 100],
  ...over,
});
const tile = (el: HTMLElement, height: number) =>
  el.querySelector<HTMLElement>(`.home-strip__lane > li[data-height="${height}"]`);
const summaryRequests = () => requests.filter((p) => p.includes("/app/blocks/summary"));

describe("the tiles' fee facts", () => {
  it("loads every tile's facts in one request on first paint, and settles their layers in", async () => {
    summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
    const { el } = await open();
    // The block's fee make-up: a layer for each band that holds any of it.
    await vi.waitFor(() =>
      expect(tile(el, 10)?.querySelectorAll(".strata__layer")).toHaveLength(3),
    );
    expect(summaryRequests()).toHaveLength(1);
    expect(summaryRequests()[0]?.split(",")).toHaveLength(10);
    const t = tile(el, 10) as HTMLElement;
    expect(t.querySelector(".home-tile__fee")?.textContent).toBe("1.23 sat/vB");
    expect(t.querySelector(".home-tile__range")?.textContent).toBe("0.10 – 12.5");
    expect(t.querySelector(".strata--settle")).not.toBeNull();
    // The gauge the layers settle over clears away.
    expect(t.querySelector(".home-tile__fill--gone")).not.toBeNull();
    expect(t.querySelector("a")?.getAttribute("aria-label")).toContain(
      "median fee 1.23 sat/vB, fee range 0.10 to 12.5 sat/vB",
    );
    // The layers carry the colour; the median beside them is a number alone, and the tile states its fees.
    expect(t.querySelector(".fee__swatch")).toBeNull();
    expect(t.querySelector(".home-tile__fees")?.textContent).toMatch(/ BTC$/);
  });

  it("shows the neutral gauge and loading lines while the facts are on their way", async () => {
    summaries = () => new Promise<Response>(() => {});
    const { el } = await open();
    const t = tile(el, 10) as HTMLElement;
    expect(t.querySelector(".home-tile__fill")).not.toBeNull();
    expect(t.querySelectorAll(".home-tile__bone--line")).toHaveLength(2);
    expect(t.querySelector(".strata")).toBeNull();
    expect(t.querySelector("a")?.getAttribute("aria-label")).not.toContain("fee");
  });

  it("says plainly when a block holds only its coinbase", async () => {
    summaries = (hashes) =>
      Response.json(
        hashes.map((h) =>
          facts(h, { fee_rate: null, fee_bands: Array.from({ length: 10 }, () => 0) }),
        ),
      );
    const { el } = await open();
    const t = tile(el, 10) as HTMLElement;
    await vi.waitFor(() => expect(t.querySelector(".home-tile__fee")?.textContent).toBe("No fees"));
    expect(t.querySelector(".home-tile__range")?.textContent).toBe("Coinbase only");
    expect(t.querySelector(".strata")).toBeNull();
    expect(t.querySelector(".home-tile__fill:not(.home-tile__fill--gone)")).not.toBeNull();
    expect(t.querySelector("a")?.getAttribute("aria-label")).toContain(
      "only the coinbase, no fees",
    );
  });

  it("keeps the gauge and the block's size when the facts cannot be had", async () => {
    const { el } = await open();
    const t = tile(el, 10) as HTMLElement;
    await vi.waitFor(() => expect(t.querySelector(".home-tile__fee")?.textContent).toBe("250 B"));
    expect(t.querySelector(".home-tile__range")?.textContent).toBe("under 1% full");
  });

  it("gives a block's size as its serialized size, in B, kB or MB", async () => {
    const sizes = [9_999, 10_000, 999_994, 999_995, 1_690_000];
    blocksServed = chain(1, 10);
    for (const [i, size] of sizes.entries()) Object.assign(blocksServed[i] ?? {}, { size });
    const { el } = await open();
    const shown = () =>
      [10, 9, 8, 7, 6].map((h) => tile(el, h)?.querySelector(".home-tile__fee")?.textContent);
    await vi.waitFor(() =>
      expect(shown()).toStrictEqual([
        "9\u202F999 B",
        "10.00 kB",
        "999.99 kB",
        "1.00 MB",
        "1.69 MB",
      ]),
    );
  });

  it("fills a new block's tile from the WebSocket, without asking HTTP", async () => {
    summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
    const { el, ws } = await open();
    await vi.waitFor(() => expect(summaryRequests()).toHaveLength(1));
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    const t = tile(el, 11) as HTMLElement;
    expect(t.querySelectorAll(".home-tile__bone--line")).toHaveLength(2);
    ws.receive({
      topic: "blocks",
      type: "summary",
      summary: facts(fakeBlock(11).id, {
        fee_rate: { min: 0.1, p10: 0.1, p25: 0.2, median: 0.5, p75: 1, p90: 2, max: 3 },
      }),
    });
    expect(t.querySelector(".home-tile__fee")?.textContent).toBe("0.50 sat/vB");
    expect(t.querySelector(".strata--settle")).not.toBeNull();
    // The other tiles keep their layers' elements, so they do not settle in a second time.
    const older = tile(el, 10)?.querySelector(".strata__layer");
    expect(older).not.toBeNull();
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(12) });
    ws.receive({ topic: "blocks", type: "summary", summary: facts(fakeBlock(12).id) });
    expect(tile(el, 10)?.querySelector(".strata__layer")).toBe(older);
    // A malformed push is ignored, and a push for a block not shown is kept for later.
    ws.receive({ topic: "blocks", type: "summary", summary: { id: fakeBlock(10).id } });
    expect(summaryRequests()).toHaveLength(1);
  });

  it("asks HTTP for a new block's facts when the push does not come", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
      const { el, ws } = await open();
      await vi.waitFor(() => expect(summaryRequests()).toHaveLength(1));
      ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
      vi.advanceTimersByTime(3_000);
      expect(summaryRequests()).toHaveLength(1);
      vi.advanceTimersByTime(1_500);
      await vi.waitFor(() => expect(summaryRequests()).toHaveLength(2));
      expect(summaryRequests()[1]).toContain(fakeBlock(11).id);
      await vi.waitFor(() =>
        expect(tile(el, 11)?.querySelector(".home-tile__fee")?.textContent).toBe("1.23 sat/vB"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the tiles' miners", () => {
  const FOUNDRY = { name: "Foundry USA", slug: "foundryusa" };
  const pool = (el: HTMLElement, h: number) => tile(el, h)?.querySelector(".home-tile__pool");

  it("names each tile's miner from the batch, under the tile and in its link", async () => {
    summaries = (hashes) =>
      Response.json(
        hashes.map((h, i) =>
          facts(h, { miner: i === 0 ? FOUNDRY : { name: "Unknown", slug: "unknown" } }),
        ),
      );
    const { el } = await open();
    await vi.waitFor(() => expect(pool(el, 10)?.textContent).toBe("Foundry USA"));
    expect(pool(el, 9)?.textContent).toBe("Unknown");
    // Screen readers hear it with the tile, once.
    expect(pool(el, 10)?.getAttribute("aria-hidden")).toBe("true");
    expect(tile(el, 10)?.querySelector("a")?.getAttribute("aria-label")).toMatch(
      /^Block 10, mined by Foundry USA, /,
    );
  });

  it("keeps the line empty, and its space, until the facts come or when the server does not say", async () => {
    summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
    const { el } = await open();
    await vi.waitFor(() => expect(tile(el, 10)?.querySelector(".strata")).not.toBeNull());
    expect(pool(el, 10)).not.toBeNull();
    expect(pool(el, 10)?.textContent).toBe("");
    expect(tile(el, 10)?.querySelector("a")?.getAttribute("aria-label")).not.toContain("mined by");
  });

  it("names a new block's miner from the WebSocket's summary", async () => {
    summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
    const { el, ws } = await open();
    await vi.waitFor(() => expect(summaryRequests()).toHaveLength(1));
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    expect(pool(el, 11)?.textContent).toBe("");
    ws.receive({
      topic: "blocks",
      type: "summary",
      summary: facts(fakeBlock(11).id, { miner: FOUNDRY }),
    });
    expect(pool(el, 11)?.textContent).toBe("Foundry USA");
    expect(summaryRequests()).toHaveLength(1);
  });
});

describe("the tiles' fee facts, racing", () => {
  it("keeps a pushed summary when the HTTP fallback for it fails afterwards", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let failFallback: (r: Response) => void = () => {};
      summaries = (hashes) =>
        hashes.includes(fakeBlock(11).id)
          ? new Promise<Response>((resolve) => {
              failFallback = resolve;
            })
          : Response.json(hashes.map((h) => facts(h)));
      const { el, ws } = await open();
      await vi.waitFor(() => expect(summaryRequests()).toHaveLength(1));
      ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
      vi.advanceTimersByTime(4_500);
      await vi.waitFor(() => expect(summaryRequests()).toHaveLength(2));
      ws.receive({ topic: "blocks", type: "summary", summary: facts(fakeBlock(11).id) });
      failFallback(Response.json({ error: "upstream failed" }, { status: 502 }));
      const t = tile(el, 11) as HTMLElement;
      await vi.waitFor(() =>
        expect(t.querySelector(".home-tile__fee")?.textContent).toBe("1.23 sat/vB"),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(t.querySelector(".home-tile__fee")?.textContent).toBe("1.23 sat/vB");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the difficulty adjustment", () => {
  const ADJUSTMENT = {
    progressPercent: 89.0377,
    difficultyChange: -7.046,
    estimatedRetargetDate: Date.now() + 39 * 3_600_000 + 30 * 60_000 + 30_000,
    remainingBlocks: 221,
    remainingTime: 1,
    previousRetarget: 5.539,
    previousTime: 1,
    nextRetargetHeight: 975_744,
    timeAvg: 1,
    adjustedTimeAvg: 1,
    timeOffset: 0,
    expectedBlocks: 1932.47,
  };

  it("says regtest never adjusts, rather than show a change of zero", async () => {
    const { el } = await open();
    expect(el.querySelector(".home-difficulty")?.textContent).toContain(
      "Regtest never adjusts its difficulty",
    );
    expect(requests.some((p) => p.includes("difficulty"))).toBe(false);
  });

  it("shows the period, the expected change, when, and the previous change", async () => {
    replies["/v1/difficulty-adjustment"] = () => Response.json(ADJUSTMENT);
    const el = mount(() => <HomePage />, "/signet/");
    const panel = () => el.querySelector(".home-difficulty")?.textContent ?? "";
    await vi.waitFor(() => expect(panel()).toContain("Down 7.05%"));
    expect(panel()).toContain("1\u202F795 of 2\u202F016 blocks");
    expect(panel()).toContain("137 blocks behind");
    expect(panel()).toContain("at block 975\u202F744");
    expect(panel()).toContain("in 39 h 30 min");
    expect(panel()).toContain("Up 5.54%");
  });

  it("asks again while its answer is as of an older tip than the strip shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const stamp = (hash: string) => ({
        "x-bitcoin-chain-tip": hash,
        "x-bitcoin-chain-tip-height": "9",
      });
      let n = 0;
      replies["/v1/difficulty-adjustment"] = () =>
        Response.json(ADJUSTMENT, {
          headers: stamp(n++ === 0 ? "ab".repeat(32) : fakeBlock(10).id),
        });
      mount(() => <HomePage />, "/signet/");
      await vi.waitFor(() => expect(n).toBe(1));
      vi.advanceTimersByTime(1_600);
      await vi.waitFor(() => expect(n).toBe(2));
      // Caught up with the strip's tip: no more asking.
      vi.advanceTimersByTime(10_000);
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits out the server's 503 before its first answer without showing an error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let n = 0;
      replies["/v1/difficulty-adjustment"] = () =>
        n++ === 0
          ? Response.json(
              { error: "not ready yet; retry" },
              { status: 503, headers: { "retry-after": "1" } },
            )
          : Response.json(ADJUSTMENT);
      const el = mount(() => <HomePage />, "/signet/");
      const panel = () => el.querySelector(".home-difficulty");
      await vi.waitFor(() => expect(n).toBe(1));
      expect(panel()?.querySelector('[role="alert"]')).toBeNull();
      expect(panel()?.querySelector(".difficulty__stats")?.getAttribute("aria-busy")).toBe("true");
      vi.advanceTimersByTime(1_300);
      await vi.waitFor(() => expect(panel()?.textContent).toContain("Down 7.05%"));
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A `projected` message on `tip`: eight blocks, the next first, rates in sat per 1,000 vB. */
function projectedMsg(tip: number, blocks = 8, txs = 3000, stale = false) {
  const block = (i: number) => ({
    txs: i < blocks ? txs : 0,
    weight: i < blocks ? 3_990_000 : 0,
    vsize: i < blocks ? 997_500 : 0,
    fees: i < blocks ? txs * 200 : 0,
    min_rate: i < blocks ? 500 : 0,
    median_rate: i < blocks ? 1000 * (8 - i) : 0,
    max_rate: i < blocks ? 50_000 : 0,
    bands: Array.from({ length: 12 }, (_, b) => (i < blocks && b === 6 ? 997_500 : 0)),
  });
  return {
    topic: "projected",
    type: "projected",
    seq: tip,
    tip: { height: tip, hash: fakeBlock(tip).id },
    stale,
    blocks: Array.from({ length: 8 }, (_, i) => block(i)),
  };
}
const MEMPOOL_MSG = {
  topic: "mempool",
  type: "mempool",
  seq: 1,
  count: 4321,
  vsize: 2_500_000,
  fees: 123_456,
  min_fee_rate: 100,
  bands: [1_000_000, 0, 0, 0, 0, 0, 500_000, 0, 0, 0, 0, 1_000_000],
  stale: false,
};
const seenTx = (n: number) => ({
  txid: n.toString(16).padStart(64, "d"),
  time: 1_800_000_000 + n,
  fee: 500,
  vsize: 250,
  value: 10_000,
});
const txsMsg = (ns: number[]) => ({
  topic: "transactions",
  type: "transactions",
  txs: ns.map((n) => seenTx(n)),
});
const projectedTiles = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLElement>(".home-strip__projected > li[data-key]"),
];
const count = (path: string) => requests.filter((p) => p === path).length;

/** A stand-in for the browser's observer: it reports the panel in view at once, or when told. */
let reportView: (() => void) | undefined;
class FakeObserver {
  static atOnce = false;
  readonly #notify: (entries: { isIntersecting: boolean }[]) => void;
  #stopped = false;
  constructor(notify: (entries: { isIntersecting: boolean }[]) => void) {
    this.#notify = notify;
  }
  observe() {
    reportView = () => {
      if (!this.#stopped) this.#notify([{ isIntersecting: true }]);
    };
    if (FakeObserver.atOnce) reportView();
  }
  disconnect() {
    this.#stopped = true;
  }
}

describe("the mempool panel's pictures", () => {
  beforeEach(() => {
    reportView = undefined;
    FakeObserver.atOnce = false;
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  });

  it("wait until the panel comes near the view: no map topic and no history before", async () => {
    const { ws } = await open(true);
    const asked = () => JSON.stringify(ws.sent).includes("projected-txs:0");
    const history = () => requests.filter((p) => p.endsWith("/app/mempool/history/2h")).length;
    await vi.waitFor(() => expect(reportView).toBeDefined());
    expect(asked()).toBe(false);
    expect(history()).toBe(0);
    reportView?.();
    await vi.waitFor(() => expect(asked()).toBe(true));
    await vi.waitFor(() => expect(history()).toBe(1));
  });

  it("say why the map is empty while its data cannot come, never a blank frame", async () => {
    FakeObserver.atOnce = true;
    const { el, ws } = await open(true);
    const note = () => el.querySelector(".home-next__note")?.textContent;
    await vi.waitFor(() => expect(note()).toBe("Loading the next block…"));
    ws.drop(1006);
    await vi.waitFor(() => expect(note()).toBe("The map shows while the page is live."));
  });
});

describe("the live mempool", () => {
  it("makes each request once on a cold load, and none the topics answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
      const { ws } = await open(true);
      ws.receive(MEMPOOL_MSG);
      ws.receive(txsMsg([1, 2]));
      ws.receive(projectedMsg(10));
      ws.receive(feesMsg("projected", [2001, 1031, 126, 100]));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(count("/blocks")).toBe(1);
      expect(summaryRequests()).toHaveLength(1);
      expect(count("/mempool")).toBe(0);
      expect(count("/mempool/recent")).toBe(0);
      expect(count("/v1/fees/precise")).toBe(0);
      // A new tip asks for none of the panels: their topics bring what changed.
      ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
      await vi.advanceTimersByTimeAsync(100);
      expect(count("/v1/fees/precise") + count("/mempool") + count("/mempool/recent")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fills the mempool panel and the latest transactions from the topics", async () => {
    const { el, ws } = await open(true);
    ws.receive(MEMPOOL_MSG);
    ws.receive(txsMsg([2, 1]));
    const stats = el.querySelector(".home-stats")?.textContent ?? "";
    expect(stats).toContain("4 321");
    expect(stats).toContain("2.50 MvB");
    expect(stats).toContain("≈ 3 blocks");
    expect(stats).toContain("0.10 sat/vB");
    expect(stats).toContain("node minimum");
    // The next block's map is headed by the fee rate its worth reaches down to: here the dearest band.
    expect(el.querySelector(".home-next .home-picture__meta")?.textContent).toBe(
      "down to 10+ sat/vB",
    );
    expect(el.querySelector(".home-recent tbody")?.textContent).toContain("dddddddd");
    expect(el.querySelector(".home-recent tbody")?.textContent).toContain("250 vB");
    expect(el.querySelector(".home-recent thead")?.textContent).toContain("Virtual size");
    expect(el.querySelectorAll(".home-recent tbody tr")).toHaveLength(2);
  });

  it("lets new transactions in one at a time, at a pace a person can read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { el, ws } = await open(true);
      ws.receive(txsMsg([2, 1]));
      const rows = () => el.querySelectorAll(".home-recent tbody tr").length;
      expect(rows()).toBe(2);
      ws.receive(txsMsg([6, 5, 4, 3, 2, 1]));
      expect(rows()).toBe(3);
      expect(el.querySelector(".home-recent__new")?.textContent).toContain("3");
      await vi.advanceTimersByTimeAsync(PACE_MS);
      expect(rows()).toBe(4);
      await vi.advanceTimersByTimeAsync(PACE_MS * 2);
      expect(rows()).toBe(6);
      // Newest first once all are in.
      expect(el.querySelector(".home-recent tbody tr")?.textContent).toContain(
        seenTx(6).txid.slice(0, 8),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to polling, with the placeholder tile, when the server does not track the mempool", async () => {
    const { el } = await open();
    await vi.waitFor(() => expect(el.querySelector(".home-stats")?.textContent).toContain("3"));
    expect(count("/mempool")).toBe(1);
    expect(el.querySelector(".home-strip__projected")).toBeNull();
    expect(el.querySelector(".home-tile__since-label")?.textContent).toBe("since last block");
    expect(el.querySelector(".home-strip__pending")?.textContent).toContain("does not track");
    expect(el.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("polls when the topics stay silent after the socket is up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await open(true);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(count("/mempool")).toBe(0);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(count("/mempool")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls a panel whose topic is silent, even when the other topics have spoken", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { ws } = await open(true);
      ws.receive(projectedMsg(10));
      ws.receive(txsMsg([1]));
      await vi.advanceTimersByTimeAsync(5_500);
      expect(count("/mempool")).toBe(1);
      expect(count("/mempool/recent")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on a new tip asks only for the panel that is being polled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { ws } = await open(true);
      ws.receive(MEMPOOL_MSG);
      await vi.advanceTimersByTimeAsync(5_500);
      expect(count("/mempool/recent")).toBe(1);
      ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
      await vi.advanceTimersByTimeAsync(100);
      expect(count("/mempool/recent")).toBe(2);
      expect(count("/mempool")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says quietly when the server has lost its node, and keeps the last state", async () => {
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10, 8, 3000, true));
    ws.receive({ ...MEMPOOL_MSG, stale: true });
    expect(el.querySelector(".home-live")?.textContent).toContain("Node not answering");
    expect(projectedTiles(el)).toHaveLength(4);
    expect(el.querySelector(".home-strip__pending")?.textContent).toContain("lost touch");
  });
});

describe("the projected tiles", () => {
  it("line up next to the line: next, in ~20 and ~30 min, and the rest", async () => {
    const el = mount(() => <HomePage />, "/signet/");
    const ws = FakeSocket.last();
    ws.hello({ network: "signet" });
    await vi.waitFor(() => expect(tileHeights(el)).toHaveLength(10));
    ws.receive(projectedMsg(10));
    const tiles = projectedTiles(el);
    expect(tiles.map((t) => t.querySelector(".home-tile__title")?.textContent)).toStrictEqual([
      "Next block",
      "In ~20 min",
      "In ~30 min",
      "+5 blocks",
    ]);
    const next = tiles[0] as HTMLElement;
    expect(next.querySelector(".home-tile__fee")?.textContent).toBe("~8.00 sat/vB");
    expect(next.querySelector(".home-tile__range")?.textContent).toBe("0.50 – 50.0");
    expect(next.querySelector(".home-tile__foot")?.textContent).toBe("3 000 tx~10 min");
    const link = next.querySelector("a");
    expect(link?.getAttribute("aria-label")).toBe(
      "Next block, projected: 3 000 transactions, median fee about 8.00 sat/vB, fee range 0.50 to 50.0 sat/vB",
    );
    // Each opens its projected block's page; the last opens the first block it holds.
    expect(tiles.map((t) => t.querySelector("a")?.getAttribute("href"))).toStrictEqual([
      "/signet/block/next",
      "/signet/block/next/2",
      "/signet/block/next/3",
      "/signet/block/next/4",
    ]);
    // Its layers show the projection's fee make-up; the median itself is a number.
    expect(next.querySelector(".fee__swatch")).toBeNull();
    expect(next.querySelectorAll(".strata__layer").length).toBeGreaterThan(0);
  });

  it("make a small mempool one short tile, and an empty one an empty tile that says so", async () => {
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10, 1, 4));
    expect(projectedTiles(el)).toHaveLength(1);
    expect(el.querySelector(".home-strip__pending")?.textContent).toBe(
      "Everything waiting fits in the next block.",
    );
    ws.receive(projectedMsg(10, 0));
    const [empty] = projectedTiles(el);
    expect(empty?.textContent).toContain("Nothing waiting");
    expect(empty?.querySelector(".home-tile__fill--floor")).not.toBeNull();
    expect(el.querySelector(".home-strip__pending")?.textContent).toContain("Nothing is waiting");
  });

  it("update in place: the same elements, new figures, nothing replayed", async () => {
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10));
    const first = projectedTiles(el);
    const layer = first[0]?.querySelector(".strata__layer");
    ws.receive({ ...projectedMsg(10), seq: 99 });
    expect(projectedTiles(el)).toStrictEqual(first);
    // Same layers: the same elements, so no settling plays again.
    expect(first[0]?.querySelector(".strata__layer")).toBe(layer);
  });

  it("when a block is mined: the next tile becomes it, shows what was projected, then its facts", async () => {
    summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10));
    expect(projectedTiles(el).map((t) => t.dataset["key"])).toStrictEqual(["11", "12", "13", "14"]);
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    // The old projection, shifted: its block 1 is next now.
    expect(projectedTiles(el).map((t) => t.dataset["key"])).toStrictEqual(["12", "13", "14", "15"]);
    const mined = tile(el, 11) as HTMLElement;
    expect(mined.querySelector(".home-tile__fee")?.textContent).toBe("~8.00 sat/vB");
    expect(mined.querySelector(".home-tile__foot")?.textContent).toContain("~3\u202F000 tx");
    expect(mined.querySelector(".home-tile__guess")).not.toBeNull();
    ws.receive({ topic: "blocks", type: "summary", summary: facts(fakeBlock(11).id) });
    await vi.waitFor(() =>
      expect(mined.querySelector(".home-tile__fee")?.textContent).toBe("1.23 sat/vB"),
    );
    expect(mined.querySelector(".home-tile__guess--gone")).not.toBeNull();
    expect(mined.querySelector(".strata--morph")).not.toBeNull();
    expect(mined.querySelector(".home-tile__foot")?.textContent).toContain("1 tx");
    // The new projection arrives: same places, its own figures.
    ws.receive(projectedMsg(11, 8));
    expect(projectedTiles(el).map((t) => t.dataset["key"])).toStrictEqual(["12", "13", "14", "15"]);
    expect(el.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Block 11 mined: 1 transaction.",
    );
    // A refetch keeps the tile, settled: what was projected is not shown again.
    blocksServed = chain(4, 13);
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(13) });
    await vi.waitFor(() => expect(tileHeights(el)[0]).toBe(13));
    const redrawn = tile(el, 11) as HTMLElement;
    expect(redrawn.querySelector(".home-tile__fee")?.textContent).toBe("1.23 sat/vB");
    expect(redrawn.querySelector(".home-tile__guess:not(.home-tile__guess--gone)")).toBeNull();
  });

  it("when the projection comes before its block, the old next tile still crosses", async () => {
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10));
    ws.receive(projectedMsg(11));
    expect(projectedTiles(el).map((t) => t.dataset["key"])).toStrictEqual(["11", "12", "13", "14"]);
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    expect(projectedTiles(el).map((t) => t.dataset["key"])).toStrictEqual(["12", "13", "14", "15"]);
    expect(tile(el, 11)?.querySelector(".home-tile__fee")?.textContent).toBe("~8.00 sat/vB");
  });

  it("keeps showing the projection until the tile lands, even when its facts came first", async () => {
    summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10));
    ws.receive({ topic: "blocks", type: "summary", summary: facts(fakeBlock(11).id) });
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    const mined = tile(el, 11) as HTMLElement;
    expect(mined.querySelector(".home-tile__fee")?.textContent).toBe("~8.00 sat/vB");
    await vi.waitFor(() =>
      expect(mined.querySelector(".home-tile__fee")?.textContent).toBe("1.23 sat/vB"),
    );
  });

  it("an empty mined block drops what was projected for it", async () => {
    summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10));
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    ws.receive({
      topic: "blocks",
      type: "summary",
      summary: facts(fakeBlock(11).id, {
        fee_rate: null,
        fee_bands: Array.from({ length: 10 }, () => 0),
      }),
    });
    const mined = tile(el, 11) as HTMLElement;
    await vi.waitFor(() =>
      expect(mined.querySelector(".home-tile__fee")?.textContent).toBe("No fees"),
    );
    expect(mined.querySelector(".home-tile__guess--gone")).not.toBeNull();
    expect(mined.querySelector(".strata--morph")).toBeNull();
  });
});

const feeList = (el: HTMLElement) =>
  [...el.querySelectorAll(".home-fees__item")].map((i) => i.textContent);
/** The fastest answer: the last, as the panel goes slowest first. */
const highest = (el: HTMLElement) => feeList(el).at(-1);
const feeNote = (el: HTMLElement) => el.querySelector(".home-fees__note")?.textContent ?? "";

describe("the fee panel", () => {
  it("shows the server's own recommendation, rounded up, slowest first", async () => {
    const { el, ws } = await open(true);
    ws.receive(feesMsg("projected", [2001, 1031, 199, 100]));
    expect(feeList(el)).toStrictEqual([
      "No rushwithin a day0.10 sat/vB",
      "Lowwithin an hour0.20 sat/vB",
      "Mediumwithin 30 min1.04 sat/vB",
      "Highnext block2.01 sat/vB",
    ]);
    // The rates are numbers alone: colour belongs to the drawings.
    expect(el.querySelector(".home-fees .fee__swatch")).toBeNull();
    // Separate answers need no line under them.
    expect(el.querySelector(".home-fees__note")).toBeNull();
    expect(feeNote(el)).not.toContain("node");
    expect(count("/v1/fees/precise")).toBe(0);
  });

  it("reads levels that print the same rate as one answer, never stacked labels", async () => {
    const { el, ws } = await open(true);
    // Signet's usual answer: 0.100 on every level.
    ws.receive(feesMsg("projected", [100, 100, 100, 100]));
    expect(feeList(el)).toStrictEqual(["Any waitnext block0.10 sat/vB"]);
    // What one answer means, in the panel's one line of text.
    expect(feeNote(el)).toBe("Every wait pays the same: the next block has room at this rate.");
    // The node's estimates are history, not a look at the next block: no claim about its room.
    ws.receive(feesMsg("node", [100, 100, 100, 100]));
    expect(feeList(el)).toStrictEqual(["Any waitnext block0.10 sat/vB"]);
    expect(feeNote(el)).toContain("The node's own estimates");
    // Low and Medium alone stay apart: merged, they would straddle the panel's two rows.
    ws.receive(feesMsg("projected", [1500, 1000, 1000, 120]));
    expect(feeList(el)).toStrictEqual([
      "No rushwithin a day0.12 sat/vB",
      "Lowwithin an hour1.00 sat/vB",
      "Mediumwithin 30 min1.00 sat/vB",
      "Highnext block1.50 sat/vB",
    ]);
  });

  it("says when the figures are the node's estimates rather than its own", async () => {
    const { el, ws } = await open(true);
    ws.receive(feesMsg("node", [1500, 1000, 1000, 120]));
    expect(highest(el)).toBe("Highnext block1.50 sat/vB");
    expect(feeNote(el)).toBe(
      "The node's own estimates: this server has none of its own right now.",
    );
  });

  it("follows each update on the topic, and shows no number when the answer is withdrawn", async () => {
    const { el, ws } = await open(true);
    ws.receive(feesMsg("node", [1500, 1000, 1000, 120]));
    ws.receive(feesMsg("projected", [3000, 2000, 1000, 100]));
    expect(highest(el)).toBe("Highnext block3.00 sat/vB");
    // Separate answers need no line under them.
    expect(el.querySelector(".home-fees__note")).toBeNull();
    ws.receive({ topic: "fees", type: "unavailable" });
    const panel = el.querySelector(".home-fees") as HTMLElement;
    expect(panel.textContent).toContain("No recommendation right now");
    expect(feeList(el).every((t) => t?.endsWith("–"))).toBe(true);
    // A malformed message changes nothing.
    ws.receive({ ...feesMsg("projected", [3000, 2000, 1000, 100]), levels: [] });
    expect(panel.textContent).toContain("No recommendation right now");
    ws.receive(feesMsg("projected", [1200, 1100, 1000, 100]));
    expect(highest(el)).toBe("Highnext block1.20 sat/vB");
  });

  it("waits with empty places, not a number, before the first answer", async () => {
    const { el } = await open(true);
    expect(el.querySelector(".home-fees__list")?.getAttribute("aria-busy")).toBe("true");
    expect(feeList(el).every((t) => t?.endsWith("–"))).toBe(true);
  });

  it("drops the topic's answer when the socket drops, and asks over HTTP until it is back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reply = () =>
        Response.json({
          fastestFee: 5.2,
          halfHourFee: 1.1,
          hourFee: 0.5,
          economyFee: 0.12,
          minimumFee: 0.1,
        });
      replies["/v1/fees/precise"] = () => reply();
      const { el, ws } = await open(true);
      ws.receive(feesMsg("projected", [3000, 2000, 1000, 100]));
      ws.drop(1006);
      // The node's estimates carry no chain tip: marked as the node's.
      await vi.waitFor(() => expect(highest(el)).toBe("Highnext block5.20 sat/vB"));
      expect(feeNote(el)).toContain("node's own estimates");
      expect(count("/v1/fees/precise")).toBe(1);
      // Ours carries the tip it was projected on.
      reply = () =>
        Response.json(
          { fastestFee: 2.5, halfHourFee: 1.1, hourFee: 0.5, economyFee: 0.12, minimumFee: 0.1 },
          {
            headers: {
              "x-bitcoin-chain-tip": fakeBlock(10).id,
              "x-bitcoin-chain-tip-height": "10",
            },
          },
        );
      await vi.advanceTimersByTimeAsync(FEES_POLL_MS);
      await vi.waitFor(() => expect(highest(el)).toBe("Highnext block2.50 sat/vB"));
      // Separate answers need no line under them.
      expect(el.querySelector(".home-fees__note")).toBeNull();
      // A failed ask shows no number rather than the last one.
      reply = () => Response.json({ error: "upstream unavailable" }, { status: 502 });
      await vi.advanceTimersByTimeAsync(FEES_POLL_MS);
      await vi.waitFor(() =>
        expect(el.querySelector(".home-fees")?.textContent).toContain("No recommendation"),
      );
      // Back: the snapshot is the topic's answer, and the asking stops. Greet the next socket as it
      // opens: one left unanswered for 10 s is given up on.
      const sockets = FakeSocket.all.length;
      for (let i = 0; i < 120 && FakeSocket.all.length === sockets; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      FakeSocket.last().hello();
      FakeSocket.last().receive(feesMsg("projected", [4000, 2000, 1000, 100]));
      expect(highest(el)).toBe("Highnext block4.00 sat/vB");
      const asked = count("/v1/fees/precise");
      // A whole poll interval, ending before the fake socket's unanswered ping would drop it.
      await vi.advanceTimersByTimeAsync(FEES_POLL_MS + 5_000);
      expect(count("/v1/fees/precise")).toBe(asked);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps its figures through a tab hidden and back, and blames the node only on the server's word", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // While away the reader's own connection fails: no reply at all, which is not the node.
      replies["/v1/fees/precise"] = () => new Promise<Response>(() => {}) as unknown as Response;
      const { el, ws } = await open(true);
      ws.receive(feesMsg("projected", [3000, 2000, 1000, 100]));
      expect(highest(el)).toBe("Highnext block3.00 sat/vB");
      replies["/blocks"] = () => {
        throw new TypeError("Load failed");
      };
      ws.drop(1006);
      // The last answer stays while the page reconnects.
      expect(highest(el)).toBe("Highnext block3.00 sat/vB");
      await vi.advanceTimersByTimeAsync(2000);
      expect(highest(el)).toBe("Highnext block3.00 sat/vB");
      // Back: the socket greets again, and the page is live, the node not blamed for the failure.
      const sockets = FakeSocket.all.length;
      for (let i = 0; i < 120 && FakeSocket.all.length === sockets; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      FakeSocket.last().hello();
      expect(el.querySelector(".home-live")?.textContent).not.toContain("Node not answering");
      // A tab woken by the phone: the socket looks live while a request gets no reply at all.
      FakeSocket.last().receive({
        topic: "blocks",
        type: "resync",
        tip: { height: 12, hash: fakeBlock(12).id },
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(requests.filter((r) => r === "/blocks").length).toBeGreaterThan(0);
      expect(el.querySelector(".home-live")?.textContent).not.toContain("Node not answering");
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes down an HTTP answer the next ask cannot confirm, while the server refuses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let ok = true;
      replies["/v1/fees/precise"] = () =>
        ok
          ? Response.json({
              fastestFee: 5.2,
              halfHourFee: 1.1,
              hourFee: 0.5,
              economyFee: 0.12,
              minimumFee: 0.1,
            })
          : Response.json(
              { error: "no fee recommendation" },
              { status: 503, headers: { "retry-after": "1" } },
            );
      const { el, ws } = await open(true);
      ws.drop(1006);
      await vi.waitFor(() => expect(highest(el)).toBe("Highnext block5.20 sat/vB"));
      // The server withdraws its answer: every ask is refused, and retried, from now on.
      ok = false;
      await vi.advanceTimersByTimeAsync(FEES_POLL_MS + FEES_CONFIRM_MS);
      expect(feeList(el).every((t) => t?.endsWith("–"))).toBe(true);
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(FEES_POLL_MS);
        expect(el.querySelector(".home-fees")?.textContent).not.toContain("5.200");
      }
      // Once the retries give up, it says there is no answer.
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() =>
        expect(el.querySelector(".home-fees")?.textContent).toContain("No recommendation"),
      );
      // And keeps saying so through the asks that follow, without flickering back to waiting.
      await vi.advanceTimersByTimeAsync(FEES_POLL_MS + FEES_CONFIRM_MS);
      expect(el.querySelector(".home-fees")?.textContent).toContain("No recommendation");
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks over HTTP when the topic says nothing 5 s after the socket is up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      replies["/v1/fees/precise"] = () =>
        Response.json({ error: "upstream unavailable" }, { status: 502 });
      const { el } = await open(true);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(count("/v1/fees/precise")).toBe(0);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(count("/v1/fees/precise")).toBe(1);
      await vi.waitFor(() =>
        expect(el.querySelector(".home-fees")?.textContent).toContain("No recommendation"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/** What the strip shows: mined heights, projected keys and the next tile's figures. */
function strip(el: HTMLElement) {
  const tiles = projectedTiles(el);
  return {
    mined: tileHeights(el),
    projected: tiles.map((t) => Number(t.dataset["key"])),
    next: tiles[0]?.querySelector(".home-tile__foot")?.textContent ?? "",
  };
}
const descending = (from: number, n: number) => Array.from({ length: n }, (_, i) => from - i);

describe("the strip, in the order the server promises (docs/WS.md)", () => {
  it("a block, then the projection on it, then its summary: one crossing, nothing mined left behind", async () => {
    summaries = (hashes) => Response.json(hashes.map((h) => facts(h)));
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10, 8, 3000));
    expect(strip(el)).toStrictEqual({
      mined: descending(10, 10),
      projected: [11, 12, 13, 14],
      next: `${groupDigits(3000)} tx`,
    });
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(11) });
    // At once: block 11 crosses as what was projected for it, the old second block is next.
    expect(strip(el)).toStrictEqual({
      mined: descending(11, 10),
      projected: [12, 13, 14, 15],
      next: `${groupDigits(3000)} tx`,
    });
    expect(tile(el, 11)?.querySelector(".home-tile__fee")?.textContent).toBe("~8.00 sat/vB");
    expect(projectedTiles(el)[0]?.querySelector(".home-tile__fee")?.textContent).toBe(
      "~7.00 sat/vB",
    );
    // The projection on 11: the same tiles, its own figures.
    const nextTile = projectedTiles(el)[0];
    ws.receive(projectedMsg(11, 8, 2000));
    expect(strip(el)).toStrictEqual({
      mined: descending(11, 10),
      projected: [12, 13, 14, 15],
      next: `${groupDigits(2000)} tx`,
    });
    expect(projectedTiles(el)[0]).toBe(nextTile);
    ws.receive({ topic: "blocks", type: "summary", summary: facts(fakeBlock(11).id) });
    await vi.waitFor(() =>
      expect(tile(el, 11)?.querySelector(".home-tile__fee")?.textContent).toBe("1.23 sat/vB"),
    );
    expect(strip(el).mined).toStrictEqual(descending(11, 10));
  });

  it("a burst: each block and the projection on it in turn, each block shown once", async () => {
    const { el, ws } = await open(true);
    ws.receive(projectedMsg(10, 8, 3000));
    for (const h of [11, 12, 13]) {
      ws.receive({ topic: "blocks", type: "block", block: fakeBlock(h) });
      expect(strip(el).mined).toStrictEqual(descending(h, 10));
      expect(strip(el).projected).toStrictEqual([h + 1, h + 2, h + 3, h + 4]);
      ws.receive(projectedMsg(h, 8, 1000 * h));
      expect(strip(el)).toStrictEqual({
        mined: descending(h, 10),
        projected: [h + 1, h + 2, h + 3, h + 4],
        next: `${groupDigits(1000 * h)} tx`,
      });
    }
    // Each crossed as what the projection before it said: the next block of the one on its parent.
    for (const h of [11, 12, 13]) {
      expect(tile(el, h)?.querySelector(".home-tile__foot")?.textContent).toContain(
        `~${groupDigits(h === 11 ? 3000 : 1000 * (h - 1))} tx`,
      );
    }
  });

  it("a reconnect that missed blocks: the new projection waits until the strip has them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { el, ws } = await open(true);
      ws.receive(projectedMsg(10, 8, 3000));
      let release: (() => void) | undefined;
      replies["/blocks"] = () => Response.json(chain(3, 12));
      const served = serveHeld("/blocks", (r) => (release = r));
      ws.drop(1006);
      await vi.advanceTimersByTimeAsync(1_000);
      const again = FakeSocket.last();
      again.hello();
      // The snapshots: the tip, two blocks on, then the projection on it.
      again.receive({ topic: "blocks", type: "block", block: fakeBlock(12) });
      again.receive(projectedMsg(12, 8, 1000));
      await vi.waitFor(() => expect(release).toBeDefined());
      // Held: the strip still ends at 10, so the projection on 10 stays beside it.
      expect(strip(el)).toStrictEqual({
        mined: descending(10, 10),
        projected: [11, 12, 13, 14],
        next: `${groupDigits(3000)} tx`,
      });
      release?.();
      await vi.waitFor(() => expect(strip(el).mined).toStrictEqual(descending(12, 10)));
      expect(strip(el)).toStrictEqual({
        mined: descending(12, 10),
        projected: [13, 14, 15, 16],
        next: `${groupDigits(1000)} tx`,
      });
      // Both crossed as projected on 10: its next block and the one after.
      expect(tile(el, 11)?.querySelector(".home-tile__fee")?.textContent).toBe("~8.00 sat/vB");
      expect(tile(el, 12)?.querySelector(".home-tile__fee")?.textContent).toBe("~7.00 sat/vB");
      expect(served()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Serves `path` as `replies` does, but holds each answer until `hold` is given its release. */
function serveHeld(path: string, hold: (release: () => void) => void): () => number {
  let n = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    const p = url.replace(/^\/(regtest|signet)\/api/, "");
    requests.push(p);
    if (p === path) {
      n += 1;
      await new Promise<void>((resolve) => {
        hold(resolve);
      });
    }
    return (replies[p] ?? (() => Response.json({ error: "not found" }, { status: 404 })))();
  });
  return () => n;
}
