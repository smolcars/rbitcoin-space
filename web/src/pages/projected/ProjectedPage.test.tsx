import { flush } from "solid-js";
import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deltaFrame, type FakeRecord, FakeSocket, fakeTxid, snapshotFrame } from "../../lib/fakes";
import { TIMING } from "../../lib/live";
import ProjectedPage from "./ProjectedPage";

const hash = (h: number, branch = "a") => `${branch}${h.toString(16).padStart(63, "0")}`;
const totals = (txs: number) => ({
  txs,
  weight: txs * 600,
  vsize: txs * 150,
  fees: txs * 300,
  min_rate: 1000,
  median_rate: 2000,
  max_rate: 25_000,
  bands: [0, 0, 0, 0, 0, 0, txs * 150, 0, 0, 0, 0, 0],
});
const projected = (
  height: number,
  opts: { txs?: number; stale?: boolean; branch?: string } = {},
) => ({
  topic: "projected",
  type: "projected",
  seq: height,
  tip: { height, hash: hash(height, opts.branch) },
  stale: opts.stale ?? false,
  blocks: Array.from({ length: 8 }, () => totals(opts.txs ?? 3)),
});
const rec = (n: number, rate = 2000): FakeRecord => ({
  txid: fakeTxid(n),
  rate,
  vsize: 150,
  fee: 300,
});

let dispose: (() => void) | undefined;
function open(url: string) {
  const history = memoryHistory(url);
  const Router = createRouter({
    routes: [{ path: ["/regtest/block/next", "/regtest/block/next/:n"], component: ProjectedPage }],
    history,
  });
  const el = document.createElement("div");
  document.body.append(el);
  dispose = render(() => <Router>{(page) => page.children}</Router>, el);
  return el;
}

/** Opens the page and greets its socket, which subscribes at once. */
function live(url = "/regtest/block/next") {
  const el = open(url);
  const ws = FakeSocket.last();
  ws.hello();
  return { el, ws };
}

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll(".projected-txs tbody tr")].map((r) =>
    r.querySelector("a")?.getAttribute("href"),
  );

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("projected-block page", () => {
  it("connects, subscribes to the totals and the block's transactions, and says it is waiting", () => {
    const el = open("/regtest/block/next");
    expect(el.textContent).toContain("Connecting");
    expect(el.textContent).toContain("Waiting for the server’s projection");
    const ws = FakeSocket.last();
    ws.hello();
    expect(ws.sent).toStrictEqual([{ op: "subscribe", topics: ["projected", "projected-txs:0"] }]);
    expect(el.querySelector("h1")?.textContent).toBe("Next block");
  });

  it("shows the block's facts, and its transactions highest rate first", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    ws.receive(snapshotFrame(0, 1, [rec(1, 1500), rec(2, 25_000), rec(3, 2000)]));
    expect(el.textContent).toContain("block 101 would hold if it were mined now");
    expect(el.querySelector(".projected-facts")?.textContent).toContain("Transactions3");
    expect(rows(el)).toStrictEqual([2, 3, 1].map((n) => `/regtest/tx/${fakeTxid(n)}`));
    // A size keeps its unit in the cell, as on every other page.
    const table = el.querySelector(".projected-txs table") as HTMLElement;
    expect(table.querySelector("thead")?.textContent).toContain("Virtual size");
    expect(table.querySelector("tbody tr td:last-child")?.textContent).toMatch(
      /^\d[\d\u202F]* vB$/,
    );
    const prev = el.querySelector("a[rel=prev]");
    expect(prev?.getAttribute("href")).toBe(`/regtest/block/${hash(100)}`);
  });

  it("applies deltas, flashing rows that came in, and says what changed", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    ws.receive(snapshotFrame(0, 1, [rec(1), rec(2)]));
    expect(el.querySelectorAll(".projected-txs__row--new")).toHaveLength(0);
    ws.receive(deltaFrame(0, 2, 1, [fakeTxid(1)], [rec(4, 9000)]));
    expect(rows(el)).toStrictEqual([`/regtest/tx/${fakeTxid(4)}`, `/regtest/tx/${fakeTxid(2)}`]);
    expect(el.querySelectorAll(".projected-txs__row--new")).toHaveLength(1);
    expect(el.querySelector(".projected-core__change")?.textContent).toMatch(/1 came in, 1 left/);
  });

  it("asks for a reload when the server sends a format this page does not read", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    const newer = snapshotFrame(0, 1, [rec(1)]);
    new Uint8Array(newer)[1] = 3;
    ws.receive(newer);
    expect(el.textContent).toContain("Reload the page to update it.");
  });

  it("subscribes again when it loses its place, and starts over from the snapshot", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    ws.receive(snapshotFrame(0, 5, [rec(1)]));
    ws.sent.length = 0;
    ws.receive(deltaFrame(0, 8, 7, [], [rec(2)]));
    vi.advanceTimersByTime(TIMING.controlGapMs);
    expect(ws.sent).toStrictEqual([
      { op: "unsubscribe", topics: ["projected-txs:0"] },
      { op: "subscribe", topics: ["projected-txs:0"] },
    ]);
    ws.receive(snapshotFrame(0, 9, [rec(3)]));
    expect(rows(el)).toStrictEqual([`/regtest/tx/${fakeTxid(3)}`]);
  });

  it("says when the next block was found, offers it, announces it once, and carries on", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    const status = el.querySelector("[role=status]");
    expect(status?.textContent).toBe("");
    ws.receive(projected(101));
    const notice = el.querySelector(".projected-found");
    expect(notice?.textContent).toContain("Block 101 was found");
    expect(notice?.textContent).toContain("This page now shows the next block after it");
    expect(notice?.querySelector("a")?.getAttribute("href")).toBe(`/regtest/block/${hash(101)}`);
    expect(status?.textContent).toBe(
      "Block 101 was found. This page now shows the next block after it.",
    );
    expect(el.textContent).toContain("block 102 would hold if it were mined now");
    // Further updates on the same tip are not announced again.
    ws.receive(projected(101, { txs: 5 }));
    expect(status?.textContent).toBe(
      "Block 101 was found. This page now shows the next block after it.",
    );
    notice?.querySelector("button")?.click();
    flush();
    expect(el.querySelector(".projected-found")).toBeNull();
  });

  it("waits for the block's new picture when the tip moves before the mined transactions leave", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    ws.receive(snapshotFrame(0, 100, [rec(1), rec(2)]));
    // The projection on the new tip still holds the mined transactions: not told yet.
    ws.receive(projected(101));
    ws.receive(deltaFrame(0, 101, 100, [], [rec(3)]));
    expect(el.querySelector(".projected-found")).toBeNull();
    expect(el.querySelector("[role=status]")?.textContent).toBe("");
    // The next projection replaces the block: now it is told, once.
    ws.receive(projected(101, { txs: 5 }));
    ws.receive(snapshotFrame(0, 102, [rec(3), rec(4)]));
    expect(el.querySelector(".projected-found")?.textContent).toContain("Block 101 was found");
    expect(el.querySelector("[role=status]")?.textContent).toContain("Block 101 was found.");
  });

  it("tells a found block after a while even when the block's picture does not change", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    ws.receive(snapshotFrame(0, 100, [rec(1)]));
    ws.receive(projected(101));
    expect(el.querySelector(".projected-found")).toBeNull();
    vi.advanceTimersByTime(8000);
    flush();
    expect(el.querySelector(".projected-found")?.textContent).toContain("Block 101 was found");
  });

  it("tells a later block where its transactions went when blocks are found in a burst", () => {
    const { el, ws } = live("/regtest/block/next/4");
    expect(ws.sent).toStrictEqual([{ op: "subscribe", topics: ["projected", "projected-txs:3"] }]);
    ws.receive(projected(100));
    ws.receive(projected(102));
    const notice = el.querySelector(".projected-found");
    expect(notice?.textContent).toContain("Blocks 101 to 102 were found");
    const moved = notice?.querySelector(".projected-found__text a");
    expect(moved?.textContent).toBe("the second block from now");
    expect(moved?.getAttribute("href")).toBe("/regtest/block/next/2");
  });

  it("tells the second block that what it showed is now the next block", () => {
    const { el, ws } = live("/regtest/block/next/2");
    ws.receive(projected(100));
    ws.receive(projected(101));
    const moved = el.querySelector(".projected-found__text a");
    expect(moved?.textContent).toBe("the next block");
    expect(moved?.getAttribute("href")).toBe("/regtest/block/next");
  });

  it("tells the rest of the mempool that only part of it moved up", () => {
    const { el, ws } = live("/regtest/block/next/8");
    ws.receive(projected(100));
    ws.receive(projected(101));
    const text = el.querySelector(".projected-found__text")?.textContent ?? "";
    expect(text).toContain("some of what waited here now fills the seventh block from now");
    expect(text).toContain("the rest still waits here");
  });

  it("comes back from `off` when the server's mempool is switched on again", () => {
    const { el, ws } = live();
    ws.receive({ topic: "projected", type: "off" });
    ws.receive({ topic: "projected-txs:0", type: "off" });
    expect(el.textContent).toContain("The live mempool is off");
    ws.receive(projected(100));
    ws.receive(snapshotFrame(0, 1, [rec(1)]));
    expect(el.textContent).not.toContain("The live mempool is off");
    expect(rows(el)).toHaveLength(1);
  });

  it("says when the chain switched branches", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    ws.receive(projected(100, { branch: "b" }));
    expect(el.querySelector(".projected-found")?.textContent).toContain(
      "The chain switched branches",
    );
    expect(el.querySelector(".projected-found a")?.getAttribute("href")).toBe(
      `/regtest/block/${hash(100, "b")}`,
    );
  });

  it("says when the server's mempool is off on this network, and offers mined blocks", () => {
    const { el, ws } = live();
    ws.receive({ topic: "projected", type: "off" });
    expect(el.textContent).toContain("The live mempool is off on Regtest");
    expect(el.querySelector(".projected-off a")?.getAttribute("href")).toBe("/regtest/blocks");
    expect(el.querySelector(".projected-core")).toBeNull();
  });

  it("keeps the last picture when the server loses its node, and says so", () => {
    const { el, ws } = live();
    ws.receive(projected(100));
    ws.receive(snapshotFrame(0, 1, [rec(1)]));
    ws.receive(projected(100, { stale: true }));
    expect(el.textContent).toContain("The server lost touch with its node");
    expect(el.textContent).toContain("Node not answering");
    expect(rows(el)).toHaveLength(1);
  });

  it("makes an empty block look intended", () => {
    const { el, ws } = live();
    ws.receive(projected(100, { txs: 0 }));
    ws.receive(snapshotFrame(0, 1, []));
    expect(el.textContent).toContain("Nothing waiting here");
    expect(el.textContent).toContain("The mempool is empty");
    expect(el.textContent).toContain("None: this block is empty for now.");
  });

  it("shows the rest of the mempool as totals and layers only, without asking for its transactions", () => {
    const { el, ws } = live("/regtest/block/next/8");
    expect(ws.sent).toStrictEqual([{ op: "subscribe", topics: ["projected"] }]);
    ws.receive(projected(100));
    expect(el.querySelector("h1")?.textContent).toBe("The rest of the mempool");
    expect(el.textContent).toContain("No map here");
    expect(el.querySelector(".projected-txs")).toBeNull();
    expect(el.querySelector("a[rel=next]")).toBeNull();
  });

  it("refuses a place that does not exist", () => {
    for (const n of ["9", "0", "abc"]) {
      const el = open(`/regtest/block/next/${n}`);
      expect(el.querySelector("h1")?.textContent).toBe("No such projected block");
      dispose?.();
      document.body.replaceChildren();
    }
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("releases its subscriptions when the page is left", () => {
    const { ws } = live();
    dispose?.();
    dispose = undefined;
    expect(ws.closedWith).toBe(1000);
  });
});
