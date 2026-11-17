import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "../../lib/api";
import type { Outspend, Transaction, TxStatus } from "../../lib/esplora";
import { fakeBlock, FakeSocket } from "../../lib/fakes";
import TransactionPage, { POLL_MS } from "./TransactionPage";

const TXID = "d1d7cf2b9189a07521354c5d5012c3147d9825596b6ec6cc3100904f0785fcfe";
const SPENDER = "3207f7d34cbb4c3210986ed8f357e5ebeb8189716f571d5c08731e5e46e7fab4";
const BLOCK = "0000000000000000000159affbb5acfb646390efa277f0feeabc2429b5388c36";
const confirmed: TxStatus = {
  confirmed: true,
  block_height: 975_516,
  block_hash: BLOCK,
  block_time: 1_794_453_849,
};

const out = (value: number, scriptpubkey: string, address?: string) => ({
  scriptpubkey,
  scriptpubkey_asm: "",
  scriptpubkey_type: "unknown" as const,
  value,
  ...(address ? { scriptpubkey_address: address } : {}),
});
const P2WPKH = `001405982249066c3cabd6265565b81bb024acc28488`;
const payment = (status: TxStatus): Transaction => ({
  txid: TXID,
  version: 2,
  locktime: 0,
  size: 222,
  weight: 561,
  fee: 141,
  status,
  vin: [
    {
      txid: SPENDER,
      vout: 25,
      is_coinbase: false,
      sequence: 0xfffffffd,
      scriptsig: "",
      witness: ["3045", "02aa"],
      prevout: out(100_000, P2WPKH, "bc1qqkvzyjgxds72h43x24jmsxasyjkv9pyg4wn5uu"),
    },
  ],
  vout: [out(60_000, P2WPKH, "bc1qpay"), out(39_859, P2WPKH, "bc1qchange")],
});

type Reply = { status: number; body: unknown } | (() => { status: number; body: unknown });
let replies: Record<string, Reply>;
const fetchMock = vi.fn<(url: string) => Promise<Response>>(async (url) => {
  const r = replies[url];
  const reply =
    typeof r === "function" ? r() : (r ?? { status: 404, body: { error: "not found" } });
  const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
  return new Response(text, {
    status: reply.status,
    headers: { "cache-control": "public, max-age=1" },
  });
});

const disposers: (() => void)[] = [];
beforeEach(() => {
  clearApiCache();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function page(path: string): HTMLElement {
  const history = memoryHistory(path);
  const Router = createRouter({
    routes: [{ path: ["/tx/:txid", "/regtest/tx/:txid"], component: TransactionPage }],
    history,
  });
  const el = document.createElement("div");
  document.body.append(el);
  disposers.push(render(() => <Router>{(route) => route.children}</Router>, el));
  return el;
}

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};
const text = (el: Element) => el.textContent?.replaceAll(/\s+/g, " ") ?? "";
const api = (path: string) => `/api${path}`;
const serve = (tx: Transaction, spends: Outspend[] = [], tip = "975518") => {
  replies = {
    [api(`/tx/${tx.txid}`)]: { status: 200, body: tx },
    [api(`/tx/${tx.txid}/status`)]: { status: 200, body: tx.status },
    [api(`/tx/${tx.txid}/outspends`)]: { status: 200, body: spends },
    [api("/blocks/tip/height")]: { status: 200, body: tip },
    [`/app/tx/${tx.txid}/replacements`]: {
      status: 200,
      body: { txid: tx.txid, truncated: false, replaced_by: [], replaces: [] },
    },
  };
};
/** Every topic the page asked the socket for, sorted. */
const subscribed = (ws: FakeSocket): string[] => {
  const topics = ws.sent.flatMap((m) =>
    (m as { op: string }).op === "subscribe" ? (m as { topics: string[] }).topics : [],
  );
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; toSorted is past this lib target
  return topics.sort();
};
/** The polite live region's text. */
const live = (el: Element) => text(el.querySelector("p[aria-live=polite]") as Element);
/** A `tx:` message for the page's transaction, as the server sends it. */
const msg = (m: Record<string, unknown>) => ({
  topic: `tx:${TXID}`,
  type: "tx",
  stale: false,
  ...m,
});
const mempoolMsg = (block: number, extra: Record<string, unknown> = {}, effective = 1000) =>
  msg({
    state: "mempool",
    time: 1_794_461_221,
    fee: 141,
    vsize: 141,
    rate: 1000,
    position: {
      block,
      blocks: 8,
      effective_rate: effective,
      ahead_vsize: 412_311,
      ahead_txs: 1022,
    },
    ...extra,
  });

describe("TransactionPage", () => {
  it("shows a confirmed payment: status, block, confirmations, fee and where the money went", async () => {
    serve(payment(confirmed), [
      { spent: true, txid: SPENDER, vin: 0, status: confirmed },
      { spent: false },
    ]);
    const el = page(`/tx/${TXID}`);
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Confirmed");
    const block = el.querySelector<HTMLAnchorElement>(".tx-answer__cell--where a");
    expect(block?.getAttribute("href")).toBe(`/block/${BLOCK}`);
    expect(text(el)).toContain("3 of 6 confirmations");
    // Mined three blocks ago: across the "now" line, two blocks found since beside it.
    expect(el.querySelectorAll(".tx-strip__slot--mined")).toHaveLength(3);
    // Its own block is drawn farthest right (the lane runs right to left).
    expect(el.querySelector(".tx-strip__slot--mined:first-child")?.classList).toContain("is-here");
    // 141 sats over ceil(561 / 4) = 141 vB, said once, in the fee rate's figure.
    const fee = text(el.querySelector(".tx-answer__cell--fee") as Element);
    expect(fee).toContain("1.00 sat/vB");
    expect(fee).toContain("141 sats, 141 vB");
    expect(text(el)).toContain("1 input to 2 outputs");
    // Settled: the summary says what the steps would, so they are left out.
    expect(el.querySelector(".tx-timeline")).toBeNull();
    expect(text(el)).toContain("No: it is confirmed");
    const outs = el.querySelectorAll(".tx-flow__col--out .tx-flow__item");
    expect(outs).toHaveLength(3); // two outputs and the fee
    expect(outs[0]?.querySelector("a.tx-flow__spent")?.getAttribute("href")).toBe(`/tx/${SPENDER}`);
    expect(text(outs[1] as Element)).toContain("Unspent");
    expect(el.querySelector('.tx-flow__col--out a[href="/address/bc1qpay"]')).not.toBeNull();
  });

  it("names a coinbase as what it is", async () => {
    const coinbase: Transaction = {
      ...payment(confirmed),
      fee: 0,
      vin: [
        {
          txid: "00".repeat(32),
          vout: 0xffffffff,
          is_coinbase: true,
          sequence: 0,
          scriptsig: "039ce20e",
        },
      ],
      vout: [out(314_059_121, `a914${"0b".repeat(20)}87`, "32i1m6gNcSHwiPX9nfTNXVjme9j5DU8y5g")],
    };
    serve(coinbase, [{ spent: false }], "975517");
    const el = page(`/tx/${TXID}`);
    await settle();
    expect(text(el.querySelector(".tx-flow__col--in") as Element)).toContain("Coinbase");
    expect(text(el.querySelector(".tx-answer__cell--fee") as Element)).toContain(
      "NoneA coinbase, 141 vB",
    );
    expect(text(el)).toContain("2 of 100 confirmations");
    expect(text(el)).toContain("When it can be spent");
    el.querySelector<HTMLButtonElement>(".tx-flow__col--in .tx-flow__open")?.click();
    await settle();
    expect(text(el.querySelector("#tx-inspector") as Element)).toContain(
      "Block height in script975 516",
    );
  });

  it("never calls the genesis coinbase or an OP_RETURN output spendable or unspent", async () => {
    const genesis: Transaction = {
      ...payment({ ...confirmed, block_height: 0 }),
      fee: 0,
      vin: [{ txid: "00".repeat(32), vout: 0xffffffff, is_coinbase: true, sequence: 0 }],
      vout: [out(5_000_000_000, `41${"04".repeat(65)}ac`), out(0, "6a0568656c6c6f")],
    };
    // The node reports both as not spent, which is true and misleading.
    serve(genesis, [{ spent: false }, { spent: false }], "975517");
    const el = page(`/tx/${TXID}`);
    await settle();
    expect(text(el)).toContain("Never spendable");
    expect(text(el)).not.toContain("its outputs can be spent");
    const outs = text(el.querySelector(".tx-flow__col--out") as Element);
    expect(outs).not.toContain("Unspent");
    expect(outs.match(/Unspendable/g)).toHaveLength(2);
    el.querySelector<HTMLButtonElement>(".tx-flow__col--out .tx-flow__open")?.click();
    await settle();
    expect(text(el.querySelector("#tx-inspector") as Element)).toContain(
      "Unspendable: the genesis block's reward was never added to the coins that can be spent",
    );
  });

  it("follows an unconfirmed transaction live: where it waits, then the moment it confirms", async () => {
    serve(payment({ confirmed: false }));
    const el = page(`/tx/${TXID}`);
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Unconfirmed");
    expect(text(el)).toContain("Yes, until it confirms");
    const ws = FakeSocket.last();
    ws.hello({ network: "mainnet" });
    expect(subscribed(ws)).toStrictEqual(["blocks", `tx:${TXID}`]);
    expect(text(el)).toContain("Connecting");

    ws.receive(mempoolMsg(2));
    await settle();
    expect(text(el.querySelector(".tx-live") as Element)).toBe("Live");
    const where = el.querySelector(".tx-answer__cell--where") as Element;
    expect(where.querySelector("a")?.getAttribute("href")).toBe("/block/next/3");
    expect(text(where)).toContain("Projected~3 blocks");
    expect(text(where)).toContain("1 022 txs ahead");
    const more = text(el.querySelector(".more") as Element);
    expect(more).toContain("1 022 transactions (412.31 kvB) would be mined before it.");
    expect(more).toContain("Roughly 30 minutes");
    // Third of eight from the "now" line: the sixth slot from the left.
    const marker = el.querySelector<HTMLElement>(".tx-strip__marker");
    expect(marker?.style.getPropertyValue("--i")).toBe("5");
    // A position that only moves is not announced.
    expect(live(el)).toBe("");
    ws.receive(mempoolMsg(1));
    await settle();
    expect(live(el)).toBe("");
    ws.receive(mempoolMsg(0));
    await settle();
    expect(live(el)).toBe("Now projected for the next block.");
    expect(where.querySelector("a")?.getAttribute("href")).toBe("/block/next");
    expect(text(where)).toContain("Next block");
    expect(marker?.style.getPropertyValue("--i")).toBe("7");

    replies[api(`/tx/${TXID}/status`)] = { status: 200, body: confirmed };
    ws.receive(msg({ state: "confirmed", height: 975_516, hash: BLOCK }));
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Confirmed");
    // The square crosses the line and lands in its block, once.
    expect(el.querySelector(".tx-strip__marker")).toBeNull();
    const landed = el.querySelector(".tx-strip__slot.is-landed");
    expect(landed).not.toBeNull();
    expect(text(el.querySelector(".tx-answer__cell--where") as Element)).toContain("block 975 516");
    expect(live(el)).toBe("Confirmed in block 975 516.");
    // The tip from the blocks topic counts the confirmations, and the strip follows.
    ws.receive({ topic: "blocks", type: "block", block: fakeBlock(975_517) });
    await settle();
    expect(text(el)).toContain("2 of 6 confirmations");
    expect(el.querySelectorAll(".tx-strip__slot--mined")).toHaveLength(2);
    // It landed once: a later block adds a cell, and the one that landed is the same element.
    expect(el.querySelectorAll(".tx-strip__slot.is-landed")).toHaveLength(1);
    expect(el.querySelector(".tx-strip__slot.is-landed")).toBe(landed);
  });

  it("falls back to checking over HTTP when the live channel drops, and says so", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    serve(payment({ confirmed: false }));
    const el = page(`/tx/${TXID}`);
    await settle();
    const ws = FakeSocket.last();
    ws.hello({ network: "mainnet" });
    ws.receive(mempoolMsg(0));
    await settle();
    ws.drop(1006);
    await settle();
    expect(text(el.querySelector(".tx-live") as Element)).toBe(
      "Not liveThe live connection dropped. Checking every 10 s instead.",
    );
    // Without the topic there is no position to vouch for.
    expect(text(el)).toContain("Its place in the queue shows while the page is live.");
    expect(fetchMock.mock.calls.some(([u]) => u === api(`/tx/${TXID}/status`))).toBe(true);

    replies[api(`/tx/${TXID}/status`)] = { status: 200, body: confirmed };
    replies[api("/blocks/tip/height")] = { status: 200, body: "975516" };
    vi.advanceTimersByTime(POLL_MS);
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Confirmed");
    expect(text(el)).toContain("1 of 6 confirmations");
  });

  it("after a reconnect, checks over HTTP while the topic has said nothing yet", async () => {
    vi.useFakeTimers();
    serve(payment({ confirmed: false }));
    const el = page(`/tx/${TXID}`);
    await vi.advanceTimersByTimeAsync(50);
    const first = FakeSocket.last();
    first.hello({ network: "mainnet" });
    first.receive(mempoolMsg(0));
    await vi.advanceTimersByTimeAsync(50);
    expect(el.querySelector(".tx-strip__marker")).not.toBeNull();
    first.drop(1006);
    await vi.advanceTimersByTimeAsync(1100); // the reconnect's backoff
    const second = FakeSocket.last();
    expect(second).not.toBe(first);
    second.hello({ network: "mainnet" }); // a restarted server, still on its first mempool cycle
    await vi.advanceTimersByTimeAsync(50);
    // What the topic said before the drop no longer vouches for a position.
    expect(el.querySelector(".tx-strip__marker")).toBeNull();
    const asked = () =>
      fetchMock.mock.calls.filter(([u]) => u === api(`/tx/${TXID}/status`)).length;
    const before = asked();
    await vi.advanceTimersByTimeAsync(5100);
    expect(text(el.querySelector(".tx-live") as Element)).toContain(
      "The server has not caught up with the mempool yet.",
    );
    expect(asked()).toBeGreaterThan(before);
  });

  it("says when the server does not follow this network's mempool, and polls instead", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    serve(payment({ confirmed: false }));
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().hello({ network: "mainnet" });
    FakeSocket.last().receive({ topic: `tx:${TXID}`, type: "off" });
    await settle();
    expect(text(el)).toContain("This server does not follow the Mainnet mempool.");
    expect(el.querySelector(".tx-strip__marker")).toBeNull();
    expect(text(el.querySelector(".tx-answer__cell--where") as Element)).toContain(
      "Not followed here",
    );
    const asked = () =>
      fetchMock.mock.calls.filter(([u]) => u === api(`/tx/${TXID}/status`)).length;
    const before = asked();
    vi.advanceTimersByTime(POLL_MS);
    await settle();
    expect(asked()).toBe(before + 1);
    // Nor does it ask the routes that need the mempool engine.
    expect(fetchMock.mock.calls.some(([u]) => u.startsWith("/app/"))).toBe(false);
  });

  it("says when the node is not answering, and when the server is following too many", async () => {
    serve(payment({ confirmed: false }));
    const el = page(`/tx/${TXID}`);
    await settle();
    const ws = FakeSocket.last();
    ws.hello({ network: "mainnet" });
    ws.receive(mempoolMsg(0, { stale: true }));
    await settle();
    expect(text(el.querySelector(".tx-live") as Element)).toContain("Node not answering");
    ws.receive({ topic: `tx:${TXID}`, type: "refused", reason: "server_full" });
    await settle();
    expect(text(el.querySelector(".tx-live") as Element)).toContain(
      "The server is following as many transactions as it can.",
    );
  });

  it("shows the rate a child lifts its parent to, and who they are", async () => {
    serve(payment({ confirmed: false }));
    replies[`/app/tx/${TXID}/relatives`] = {
      status: 200,
      body: {
        txid: TXID,
        stale: false,
        chunk: 0,
        parents: [],
        children: [SPENDER],
        chunks: [{ fee: 3316, vsize: 267, rate: 12_419, txs: [TXID, SPENDER] }],
        txs: [
          { txid: TXID, chunk: 0, time: 1, fee: 141, vsize: 141, block: 0, parents: [] },
          { txid: SPENDER, chunk: 0, time: 1, fee: 3175, vsize: 126, block: 0, parents: [TXID] },
        ],
      },
    };
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().hello({ network: "mainnet" });
    FakeSocket.last().receive(mempoolMsg(0, {}, 12_419));
    await settle();
    expect(text(el.querySelector(".tx-answer__cell--fee") as Element)).toContain(
      "Effective 12.4 sat/vB",
    );
    const group = el.querySelector(".tx-group") as Element;
    expect(text(group)).toContain(
      "On its own it pays 1.00 sat/vB, but its child pays enough to lift the group to 12.4 sat/vB as a whole.",
    );
    expect(text(group)).toContain("child pays for parent");
    expect(group.querySelector("a")?.getAttribute("href")).toBe(`/tx/${SPENDER}`);
  });

  it("lists a large group eight at a time, itself always among them, and the rest on asking", async () => {
    serve(payment({ confirmed: false }));
    const kids = Array.from({ length: 11 }, (_, i) => (i + 1).toString(16).padStart(64, "c"));
    replies[`/app/tx/${TXID}/relatives`] = {
      status: 200,
      body: {
        txid: TXID,
        stale: false,
        chunk: 0,
        parents: [],
        children: kids,
        // Itself last in mining order, past the first eight.
        chunks: [{ fee: 30_000, vsize: 1500, rate: 20_000, txs: [...kids, TXID] }],
        txs: [
          ...kids.map((k) => ({
            txid: k,
            chunk: 0,
            time: 1,
            fee: 2700,
            vsize: 120,
            block: 0,
            parents: [TXID],
          })),
          { txid: TXID, chunk: 0, time: 1, fee: 141, vsize: 141, block: 0, parents: [] },
        ],
      },
    };
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().hello({ network: "mainnet" });
    FakeSocket.last().receive(mempoolMsg(0, {}, 20_000));
    await settle();
    const group = el.querySelector(".tx-group") as Element;
    const rows = () => group.querySelectorAll('[aria-label^="Mined together"] li');
    expect(rows()).toHaveLength(9);
    expect(text(group)).toContain(TXID.slice(-8));
    const more = group.querySelector(".tx-group__more") as HTMLButtonElement;
    expect(text(more)).toBe("Show all 12");
    more.click();
    await settle();
    expect(rows()).toHaveLength(12);
    expect(group.querySelector(".tx-group__more")).toBeNull();
  });

  it("names what replaced it and follows the chain to the newest version", async () => {
    serve(payment({ confirmed: false }));
    const el = page(`/tx/${TXID}`);
    await settle();
    const ws = FakeSocket.last();
    ws.hello({ network: "mainnet" });
    const first = {
      txid: TXID,
      by: SPENDER,
      seen: 1_794_461_300,
      fee: 141,
      vsize: 141,
      rate: 1000,
      by_fee: 900,
      by_vsize: 141,
      by_rate: 6383,
    };
    ws.receive(msg({ state: "replaced", by: SPENDER, truncated: false, chain: [first] }));
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Replaced");
    expect(live(el)).toBe(
      "Replaced by another transaction spending the same coins, at 6.38 sat/vB.",
    );
    const notice = el.querySelector(".tx-notice") as Element;
    expect(text(notice)).toContain("paying 6.38 sat/vB where this one paid 1.00 sat/vB");
    expect(notice.querySelector(`a[href="/tx/${SPENDER}"]`)).not.toBeNull();
    expect(text(el)).toContain("No: it was replaced");
    expect(text(el)).toContain("Will not confirm");

    const NEWER = "e".repeat(64);
    ws.receive(
      msg({
        state: "replaced",
        by: SPENDER,
        truncated: false,
        chain: [first, { txid: SPENDER, by: NEWER }],
      }),
    );
    await settle();
    expect(live(el)).toBe("Its replacement was replaced too.");
    expect(text(el)).toContain("It was replaced 2 times.");
    // Only the newest version is followed, to say where it is.
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(ws.sent).toContainEqual({ op: "subscribe", topics: [`tx:${NEWER}`] });
    ws.receive({
      topic: `tx:${NEWER}`,
      type: "tx",
      stale: false,
      state: "confirmed",
      height: 975_520,
      hash: BLOCK,
    });
    await settle();
    expect(text(el.querySelector(".tx-chain__newest") as Element)).toContain(
      "It confirmed in block 975 520.",
    );
  });

  it("explains a replaced transaction opened later, from the server's record", async () => {
    replies = {
      [api("/blocks/tip/height")]: { status: 200, body: "975518" },
      [`/app/tx/${TXID}/replacements`]: {
        status: 200,
        body: {
          txid: TXID,
          truncated: false,
          replaces: [],
          replaced_by: [
            {
              txid: TXID,
              by: SPENDER,
              seen: 1_794_461_300,
              fee: 141,
              vsize: 141,
              rate: 1000,
              by_fee: null,
              by_vsize: null,
              by_rate: null,
            },
          ],
        },
      },
    };
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().hello({ network: "mainnet" });
    FakeSocket.last().receive(msg({ state: "unknown" }));
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Replaced");
    expect(text(el)).toContain("This version was replaced");
    expect(el.querySelector(`.tx-notice a[href="/tx/${SPENDER}"]`)).not.toBeNull();
    expect(text(el)).not.toContain("Transaction not found");
  });

  it("says only what is known when nothing remembers the transaction", async () => {
    replies = {
      [api("/blocks/tip/height")]: { status: 200, body: "975518" },
      [`/app/tx/${TXID}/replacements`]: {
        status: 200,
        body: { txid: TXID, truncated: false, replaces: [], replaced_by: [] },
      },
    };
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().hello({ network: "mainnet" });
    FakeSocket.last().receive(msg({ state: "unknown" }));
    await settle();
    expect(el.querySelector(".tx-status")).toBeNull();
    expect(text(el)).toContain("Transaction not found");
    expect(text(el)).toContain("it has none for this transaction");
  });

  it("says a dropped transaction was dropped, not replaced", async () => {
    serve(payment({ confirmed: false }));
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().hello({ network: "mainnet" });
    FakeSocket.last().receive(msg({ state: "evicted" }));
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Dropped");
    expect(text(el)).toContain("Dropped from the mempool without being mined");
    expect(text(el)).toContain("replaced by a transaction this server did not see");
    expect(text(el)).not.toContain("This version was replaced");
  });

  it("asks again when it left the mempool between the page's answer and its first word", async () => {
    serve(payment({ confirmed: false }));
    const el = page(`/tx/${TXID}`);
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Unconfirmed");
    // Confirmed before the page followed it: the topic never saw it leave.
    replies[api(`/tx/${TXID}/status`)] = { status: 200, body: confirmed };
    FakeSocket.last().hello({ network: "mainnet" });
    FakeSocket.last().receive(msg({ state: "unknown" }));
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Confirmed");
  });

  it("trusts HTTP for a transaction confirmed before anyone followed it", async () => {
    serve(payment(confirmed));
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().hello({ network: "mainnet" });
    FakeSocket.last().receive(msg({ state: "unknown" }));
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Confirmed");
    expect(text(el)).toContain("3 of 6 confirmations");
  });

  it("states plainly when a reorganisation sends it back to the mempool", async () => {
    serve(payment(confirmed), [], "975516");
    const el = page(`/tx/${TXID}`);
    await settle();
    const ws = FakeSocket.last();
    ws.hello({ network: "mainnet" });
    ws.receive(msg({ state: "confirmed", height: 975_516, hash: BLOCK }));
    await settle();
    ws.receive(mempoolMsg(0));
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Unconfirmed");
    expect(text(el)).toContain("Back in the mempool");
    expect(text(el)).toContain("is no longer part of the chain");
    expect(live(el)).toMatch(/^Unconfirmed again: block 975 516 left the chain/);
  });

  it("handles a transaction that vanishes while the page checks over HTTP", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    serve(payment({ confirmed: false }));
    replies[api(`/tx/${TXID}/status`)] = { status: 404, body: { error: "not found" } };
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().drop(1006);
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Removed");
    expect(text(el)).toContain("No longer in the mempool");
    expect(text(el)).toContain("No: it is no longer in the mempool");
    // The page keeps what it knew; it does not fall back to "not found".
    expect(el.querySelectorAll(".tx-flow__item")).not.toHaveLength(0);
    // And it stops asking.
    const calls = fetchMock.mock.calls.filter(([u]) => u.startsWith("/api/")).length;
    vi.advanceTimersByTime(POLL_MS * 3);
    await settle();
    expect(fetchMock.mock.calls.filter(([u]) => u.startsWith("/api/"))).toHaveLength(calls);
  });

  it("shows a transaction the node did not know, once it is broadcast, without the live channel", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    replies = {
      [api("/blocks/tip/height")]: { status: 200, body: "975518" },
      [`/app/tx/${TXID}/replacements`]: {
        status: 200,
        body: { txid: TXID, truncated: false, replaced_by: [], replaces: [] },
      },
    };
    const el = page(`/tx/${TXID}`);
    await settle();
    FakeSocket.last().drop(1006);
    await settle();
    expect(text(el)).toContain("Transaction not found");
    serve(payment({ confirmed: false }));
    vi.advanceTimersByTime(POLL_MS);
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Unconfirmed");
    expect(el.querySelectorAll(".tx-flow__item")).not.toHaveLength(0);
  });

  it("follows nothing for a settled transaction, and lets go of what it follows on leaving", async () => {
    serve(payment(confirmed), [], "975600");
    page(`/tx/${TXID}`);
    await settle();
    expect(FakeSocket.all).toHaveLength(0);

    serve(payment({ confirmed: false }));
    page(`/tx/${TXID}`);
    await settle();
    const ws = FakeSocket.last();
    ws.hello({ network: "mainnet" });
    expect(subscribed(ws)).toStrictEqual(["blocks", `tx:${TXID}`]);
    for (const d of disposers.splice(0)) d();
    expect(ws.closedWith).toBe(1000);
  });

  it("reveals a long witness a hundred items at a time", async () => {
    const witness = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(2, "0"));
    const tx = payment(confirmed);
    const first = tx.vin?.[0];
    if (!first) throw new Error("fixture has an input");
    serve({ ...tx, vin: [{ ...first, witness }] });
    const el = page(`/tx/${TXID}`);
    await settle();
    el.querySelector<HTMLButtonElement>(".tx-flow__col--in .tx-flow__open")?.click();
    await settle();
    const items = () => el.querySelectorAll(".tx-witness .tx-code").length;
    const more = () => el.querySelector<HTMLButtonElement>(".tx-witness > .btn");
    expect(items()).toBe(24);
    expect(more()?.textContent).toBe("Show 100 more of 300 items");
    more()?.click();
    await settle();
    expect(items()).toBe(124);
    more()?.click();
    more()?.click();
    await settle();
    expect(items()).toBe(300);
    expect(more()).toBeNull();
  });

  it("says when the transaction is not found", async () => {
    replies = {};
    const el = page(`/tx/${TXID}`);
    await settle();
    expect(text(el)).toContain("Transaction not found");
    expect(text(el)).toContain("belong to another network");
  });

  it("refuses bad input without asking the server", async () => {
    replies = {};
    const el = page("/tx/not-a-txid");
    await settle();
    expect(text(el)).toContain("That is not a transaction ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers a retry when the node is unavailable, and retries every request that failed", async () => {
    const down = { status: 502, body: { error: "node unavailable" } };
    replies = {
      [api(`/tx/${TXID}`)]: down,
      [api(`/tx/${TXID}/outspends`)]: down,
      [api("/blocks/tip/height")]: down,
    };
    const el = page(`/tx/${TXID}`);
    await settle();
    expect(text(el)).toContain("Could not load this transaction");
    expect(text(el)).toContain("Node unavailable.");
    serve(payment(confirmed), [
      { spent: true, txid: SPENDER, vin: 0, status: confirmed },
      { spent: false },
    ]);
    el.querySelector<HTMLButtonElement>(".state--error .btn")?.click();
    await settle();
    expect(el.querySelector(".tx-status")?.textContent).toBe("Confirmed");
    expect(el.querySelector("a.tx-flow__spent")?.getAttribute("href")).toBe(`/tx/${SPENDER}`);
    expect(text(el)).toContain("3 of 6 confirmations");
  });

  it("keeps loading while the server says it is busy, then shows the transaction", async () => {
    vi.useFakeTimers();
    serve(payment(confirmed));
    let asked = 0;
    replies[api(`/tx/${TXID}`)] = () =>
      ++asked === 1
        ? { status: 503, body: { error: "node busy; retry" } }
        : { status: 200, body: payment(confirmed) };
    const el = page(`/tx/${TXID}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(text(el)).toContain("Loading transaction");
    expect(el.querySelector(".state--error")).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toBe(2);
    expect(el.querySelector(".tx-status")?.textContent).toBe("Confirmed");
  });

  it("says when spending could not be checked instead of waiting forever", async () => {
    serve(payment(confirmed));
    replies[api(`/tx/${TXID}/outspends`)] = { status: 502, body: { error: "node unavailable" } };
    const el = page(`/tx/${TXID}`);
    await settle();
    el.querySelector<HTMLButtonElement>(".tx-flow__col--out .tx-flow__open")?.click();
    await settle();
    expect(text(el.querySelector("#tx-inspector") as Element)).toContain(
      "Could not check right now",
    );
  });

  it("opens a card's inspector in the side panel, over the details it hides until it closes", async () => {
    serve(payment(confirmed), [{ spent: false }, { spent: false }]);
    const el = page(`/tx/${TXID}`);
    await settle();
    const rail = el.querySelector(".tx-rail") as Element;
    const open = el.querySelectorAll<HTMLButtonElement>(".tx-flow__col--out .tx-flow__open")[1];
    open?.click();
    await settle();
    // In the panel beside the flow, not under it: the details stay, holding the panel's room.
    const inspector = rail.querySelector(".tx-rail__over #tx-inspector");
    expect(text(inspector as Element)).toContain("Output 1");
    expect(rail.classList).toContain("tx-rail--open");
    expect(rail.querySelector(".tx-rail__details")).not.toBeNull();
    expect(el.querySelector(".tx-main__flow #tx-inspector")).toBeNull();
    expect(open?.getAttribute("aria-expanded")).toBe("true");
    // Another card swaps it; the same card again closes it.
    el.querySelector<HTMLButtonElement>(".tx-flow__col--in .tx-flow__open")?.click();
    await settle();
    expect(text(rail.querySelector("#tx-inspector") as Element)).toContain("Input 0");
    el.querySelector<HTMLButtonElement>(".tx-flow__col--in .tx-flow__open")?.click();
    await settle();
    expect(rail.querySelector("#tx-inspector")).toBeNull();
    expect(rail.classList).not.toContain("tx-rail--open");
  });

  it("names what it replaced in the details", async () => {
    const OLD = "e".repeat(64);
    serve(payment({ confirmed: false }));
    replies[`/app/tx/${TXID}/replacements`] = {
      status: 200,
      body: {
        txid: TXID,
        truncated: false,
        replaced_by: [],
        replaces: [{ txid: OLD, by: TXID, rate: 500, by_rate: 1000, fee: 70, by_fee: 141 }],
      },
    };
    const el = page(`/tx/${TXID}`);
    await settle();
    const ws = FakeSocket.last();
    ws.hello({ network: "mainnet" });
    ws.receive(mempoolMsg(0));
    await settle();
    const facts = text(el.querySelector(".tx-rail__details") as Element);
    expect(facts).toContain("Replaces");
    expect(facts).toContain("which paid 0.50 sat/vB");
    expect(el.querySelector(`.tx-rail__details a[href="/tx/${OLD}"]`)).not.toBeNull();
  });

  it("shows ten outputs of a big transaction, then a hundred more per press", async () => {
    const big = {
      ...payment(confirmed),
      vout: Array.from({ length: 1500 }, (_, i) => out(1000 + i, P2WPKH, `bc1q${i}`)),
    };
    serve(big);
    const el = page(`/tx/${TXID}`);
    await settle();
    const count = () =>
      el.querySelectorAll(
        ".tx-flow__col--out .tx-flow__item[data-key]:not([data-key=more]):not([data-key=fee])",
      ).length;
    expect(count()).toBe(10);
    const more = el.querySelector<HTMLButtonElement>(".tx-flow__col--out .tx-flow__more");
    expect(more?.textContent).toBe("Show 100 more");
    expect(text(el.querySelector(".tx-flow__item--more") as Element)).toContain(
      "1 490 more outputs",
    );
    more?.click();
    await settle();
    expect(count()).toBe(110);
  });

  it("renders hostile OP_RETURN text as inert text and opens its details", async () => {
    const hostile = '<img src=x onerror="alert(1)">‮';
    const bytes = [...new TextEncoder().encode(hostile)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const tx = {
      ...payment(confirmed),
      vout: [out(0, `6a${(bytes.length / 2).toString(16)}${bytes}`)],
    };
    serve(tx);
    const el = page(`/tx/${TXID}`);
    await settle();
    expect(el.querySelector("img")).toBeNull();
    const card = el.querySelector(".tx-flow__col--out .tx-flow__item") as Element;
    expect(text(card)).toContain('OP_RETURN “<img src=x onerror="alert(1)">\\u{202e}”');
    expect(text(card)).toContain("Unspendable");
    const open = card.querySelector<HTMLButtonElement>(".tx-flow__open");
    open?.click();
    await settle();
    expect(open?.getAttribute("aria-expanded")).toBe("true");
    const inspector = el.querySelector("#tx-inspector") as Element;
    expect(text(inspector)).toContain("Output 0");
    expect(inspector.querySelector(".tx-code__text")?.textContent).toBe(
      '<img src=x onerror="alert(1)">\\u{202e}',
    );
    expect(el.querySelector("img")).toBeNull();
  });
});
