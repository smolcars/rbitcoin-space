import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "../../lib/api";
import type { AddressStats, Transaction, Utxo } from "../../lib/esplora";
import { FakeSocket } from "../../lib/fakes";
import { NNBSP } from "../../lib/format";
import { readHandover } from "../../lib/lookalike";
import AddressPage from "./AddressPage";

const ME = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const OTHER = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
/** BIP352's first test vector address, and the same keys on the test networks. */
const SP =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv";
const TSP =
  "tsp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc3wk4yh";
const txid = (n: number) => n.toString(16).padStart(64, "0");

type Handler = (url: string) => Response | Promise<Response>;
// A JSON body, or a handler that answers.
type Reply = Handler | object | string | number;
let calls: string[] = [];
/** How each call asked the browser's HTTP cache, in the order of `calls`. */
let caching: (RequestCache | undefined)[] = [];

const disposers: (() => void)[] = [];
/** Whether the balance chart is in view: a stand-in observer reports it, or holds it back. */
let inView = true;
const observers: { report: () => void }[] = [];
class FakeObserver {
  readonly #notify: (entries: { isIntersecting: boolean }[]) => void;
  constructor(notify: (entries: { isIntersecting: boolean }[]) => void) {
    this.#notify = notify;
  }
  observe() {
    const report = () => {
      if (!this.#stopped) this.#notify([{ isIntersecting: true }]);
    };
    if (inView) report();
    else observers.push({ report });
  }
  disconnect() {
    this.#stopped = true;
  }
  #stopped = false;
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  inView = true;
  observers.length = 0;
});
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  vi.unstubAllGlobals();
  clearApiCache();
  calls = [];
  caching = [];
  document.body.replaceChildren();
});

/**
 * Answers each API path (after the network's `/api`) from `replies`; anything else is a 404, but
 * for the balance chart's first summary page, which is empty unless a test says otherwise.
 */
function serve(replies: Record<string, Reply>) {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = input;
    calls.push(url);
    caching.push(init?.cache);
    const path = url.replace(/^(\/\w+)?\/api/, "");
    const reply =
      url === "/app/config"
        ? replies["/app/config"]
        : (replies[path] ?? (path.endsWith("/txs/summary") ? [] : undefined));
    if (reply === undefined) return Response.json({ error: "not found" }, { status: 404 });
    if (typeof reply === "function") return (reply as Handler)(url);
    return Response.json(reply);
  });
}

const refused = (status: number, error: string) => () => Response.json({ error }, { status });
const never = () => new Promise<Response>(() => {});
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Opens the page. The server's first status for the address follows at once, as it does a few
 * milliseconds after a real page subscribes, unless `first` is false.
 */
function open(url: string, first: string | null | false = "s0") {
  const Router = createRouter({
    routes: [{ path: ["/address/:address", "/:net/address/:address"], component: AddressPage }],
    history: memoryHistory(url),
  });
  const el = document.createElement("div");
  document.body.append(el);
  disposers.push(render(() => <Router>{(route) => route.children}</Router>, el));
  // A page that shows no address (malformed, another network's) follows nothing.
  if (first !== false && FakeSocket.all.length > 0) status(first);
  return el;
}

/** The server says where the address's history stands: a new status means it changed. */
function heard(m: object) {
  const ws = FakeSocket.last();
  if (!ws.sent.some((x) => (x as { op?: string }).op === "subscribe"))
    ws.hello({ network: "mainnet" });
  ws.receive({ topic: `address:${ME}`, type: "address", ...m });
}
const status = (s: string | null) => heard({ state: "watching", status: s });

const text = (el: Element) => el.textContent ?? "";
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 2000 });

const part = (funded: number, spent: number, txs: number) => ({
  funded_txo_count: funded ? 1 : 0,
  funded_txo_sum: funded,
  spent_txo_count: spent ? 1 : 0,
  spent_txo_sum: spent,
  tx_count: txs,
});
const stats = (chain = part(150_000_000, 50_000_000, 3), pool = part(0, 0, 0)): AddressStats => ({
  address: ME,
  chain_stats: chain,
  mempool_stats: pool,
});
const tx = (n: number, vin: [string, number][], vout: [string, number][], confirmed = true) =>
  ({
    txid: txid(n),
    version: 2,
    locktime: 0,
    fee: 210,
    weight: 840,
    vin: vin.map(([address, value]) => ({
      txid: txid(1000 + n),
      vout: 0,
      is_coinbase: false,
      prevout: {
        scriptpubkey: "",
        scriptpubkey_asm: "",
        scriptpubkey_type: "v0_p2wpkh",
        scriptpubkey_address: address,
        value,
      },
    })),
    vout: vout.map(([address, value]) => ({
      scriptpubkey: "",
      scriptpubkey_asm: "",
      scriptpubkey_type: "v0_p2wpkh",
      scriptpubkey_address: address,
      value,
    })),
    status: confirmed
      ? { confirmed: true, block_height: 900_000 - n, block_time: 1_700_000_000 }
      : { confirmed: false },
  }) satisfies Transaction;

describe("address page", () => {
  it("shows the address, its type and skeletons shaped like the totals while loading", async () => {
    serve({ [`/address/${ME}`]: never, [`/address/${ME}/txs`]: never });
    const el = open(`/address/${ME}`);
    expect(el.querySelector("h1")?.textContent).toBe("Address");
    expect(text(el.querySelector(".address-type") as Element)).toBe("P2WPKH");
    expect(text(el.querySelector(".hash--full") as Element)).toContain("bc1qw508");
    const labels = [...el.querySelectorAll(".address-stat__label")].map((e) => text(e));
    expect(labels).toStrictEqual(["Balance", "Received", "Sent", "Transactions", "Unconfirmed"]);
    expect(el.querySelectorAll(".address-stat .skeleton")).toHaveLength(10);
    expect(el.querySelectorAll("tbody tr .skeleton").length).toBeGreaterThan(0);
    expect(text(el)).toContain("Loading transactions");
  });

  it("shows totals and each transaction's net change for the address", async () => {
    const page = [
      tx(
        1,
        [[OTHER, 60_000]],
        [
          [ME, 50_000],
          [OTHER, 9_790],
        ],
        false,
      ),
      tx(
        2,
        [[ME, 100_000]],
        [
          [OTHER, 40_000],
          [ME, 59_790],
        ],
      ),
      tx(
        3,
        [
          [ME, 1000],
          [ME, 2000],
        ],
        [[ME, 2790]],
      ),
    ];
    serve({
      [`/address/${ME}`]: stats(part(150_000_000, 50_000_000, 3), part(50_000, 0, 1)),
      [`/address/${ME}/txs`]: page,
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(3));
    // Totals in magnitude; the exact amount behind each, a tap away, with its own copy button.
    const shown = [
      ...el.querySelectorAll(".address-stat__value .amount, .address-stat__value > .num"),
    ];
    expect(shown.map((e) => text(e))).toStrictEqual([
      "1.00 BTC",
      "1.50 BTC",
      "0.500 BTC",
      "4",
      "+0.00050000 BTC",
    ]);
    const exact = [...el.querySelectorAll<HTMLElement>(".exact")];
    expect(exact.map((e) => [e.hidden, text(e.querySelector(".num") as Element)])).toStrictEqual([
      [true, "1.00000000"],
      [true, "1.50000000"],
      [true, "0.50000000"],
    ]);
    el.querySelector<HTMLButtonElement>(".address-total")?.click();
    await until(() => expect(exact[0]?.hidden).toBe(false));
    expect(el.querySelector(".address-total")?.getAttribute("aria-expanded")).toBe("true");
    const rows = [...el.querySelectorAll("tbody tr")];
    const change = rows.map((r) => text(r.querySelectorAll("td")[2] as Element));
    expect(change).toStrictEqual(["+0.00050000 BTC", "−0.00040210 BTC", "−0.00000210 BTC"]);
    expect(text(rows[0] as Element)).toContain("Unconfirmed");
    expect(rows[1]?.querySelector("a")?.getAttribute("href")).toBe(`/tx/${txid(2)}`);
    expect(text(el.querySelector(".address-history .section__meta") as Element)).toBe("3 of 4");
  });

  it("loads the next page after the last txid seen and appends it", async () => {
    const first = Array.from({ length: 25 }, (_, i) => tx(i + 1, [[OTHER, 2000]], [[ME, 1000]]));
    serve({
      [`/address/${ME}`]: stats(part(26_000, 0, 26)),
      [`/address/${ME}/txs`]: first,
      [`/address/${ME}/txs?after_txid=${txid(25)}`]: [tx(26, [[ME, 5000]], [[OTHER, 4000]])],
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelectorAll("tbody tr")).toHaveLength(25));
    const more = [...el.querySelectorAll("button")].find((b) => text(b) === "Show 25 more");
    more?.click();
    await until(() => expect(el.querySelectorAll("tbody tr")).toHaveLength(26));
    expect(text(el.querySelectorAll("tbody tr")[25] as Element)).toContain("−0.00005000");
    expect([...el.querySelectorAll("button")].some((b) => text(b) === "Show 25 more")).toBe(false);
  });

  it("refreshes when the address's history changes, and flashes what is new", async () => {
    let page = [tx(1, [[OTHER, 2000]], [[ME, 1000]])];
    serve({
      [`/address/${ME}`]: () => Response.json(stats()),
      [`/address/${ME}/txs`]: () => Response.json(page),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(1));
    expect(FakeSocket.last().url).toContain("/app/ws");
    const asked = () => calls.filter((c) => c.endsWith("/txs")).length;
    await until(() => expect(text(el.querySelector(".address-live") as Element)).toBe("Live"));
    // The same status again is no change.
    status("s0");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(asked()).toBe(1);
    page = [tx(2, [[OTHER, 9000]], [[ME, 8000]], false), ...page];
    status("s2");
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(2));
    const rows = el.querySelectorAll("tbody tr");
    expect(rows[0]?.classList.contains("address-row--new")).toBe(true);
    expect(rows[1]?.classList.contains("address-row--new")).toBe(false);
    // Leaving the page lets the topic go: the last subscriber gone, the socket closes.
    for (const d of disposers.splice(0)) d();
    expect(FakeSocket.last().closedWith).toBe(1000);
  });

  it("keeps an unchanged row's elements, and the focus in it, when its history is asked again", async () => {
    let page = [tx(1, [[OTHER, 2000]], [[ME, 1000]])];
    const answers: Response[] = [];
    serve({
      [`/address/${ME}`]: () => Response.json(stats()),
      // Each answer is parsed anew: the same transactions, never the same objects.
      [`/address/${ME}/txs`]: () => {
        const answer = Response.json(page);
        answers.push(answer);
        return answer;
      },
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(1));
    await until(() => expect(text(el.querySelector(".address-live") as Element)).toBe("Live"));
    /** Once the newest answer has been read and what it changed is drawn. */
    const applied = async (n: number) => {
      await until(() => expect(answers[n - 1]?.bodyUsed).toBe(true));
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        flush();
      }
    };
    const row = el.querySelector("tbody tr");
    const link = row?.querySelector<HTMLAnchorElement>(".hash a");
    link?.focus();
    expect(document.activeElement).toBe(link);
    // Asked again, and the answer is the same history: nothing is rebuilt. The very elements, not
    // ones like them, so a reader's focus, or a test's hold on a row, is not lost.
    const before = answers.length;
    status("s2");
    await applied(before + 1);
    expect([...el.querySelectorAll("tbody tr")]).toStrictEqual([row]);
    expect(row?.isConnected).toBe(true);
    expect(document.activeElement).toBe(link);
    // A payment arrives above it: its row is the same element still, moved down one.
    page = [tx(2, [[OTHER, 9000]], [[ME, 8000]], false), ...page];
    status("s3");
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(2));
    expect(el.querySelectorAll("tbody tr")[1]).toBe(row);
    // The same transaction in the same block, answered differently (a node that has since pruned
    // its inputs, say): what the answer says now is drawn, never the object held from before.
    expect(text(row as Element)).toContain("+0.00001000");
    page = [tx(2, [[OTHER, 9000]], [[ME, 8000]], false), tx(1, [[OTHER, 2000]], [[ME, 1500]])];
    status("s4");
    await until(() =>
      expect(text(el.querySelectorAll("tbody tr")[1] as Element)).toContain("+0.00001500"),
    );
  });

  it("asks again for a change heard while the last one is still being fetched", async () => {
    let page = [tx(1, [[OTHER, 2000]], [[ME, 1000]])];
    let release: (() => void) | undefined;
    serve({
      [`/address/${ME}`]: () => Response.json(stats()),
      [`/address/${ME}/txs`]: async () => {
        const answer = page;
        if (release === undefined && page.length === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Response.json(answer);
      },
    });
    const el = open(`/address/${ME}`, "s1");
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(1));
    page = [tx(2, [[OTHER, 9000]], [[ME, 8000]], false), ...page];
    status("s2"); // its answer is held back
    await until(() => expect(release).toBeDefined());
    page = [tx(3, [[OTHER, 9000]], [[ME, 7000]], false), ...page];
    status("s3"); // heard while s2's answer is still on its way
    release?.();
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(3));
  });

  describe("ends up showing what the node has, whatever the order of events", () => {
    const paid = tx(2, [[OTHER, 9000]], [[ME, 8000]], false);
    const rows = (el: Element) => el.querySelectorAll("tbody tr .hash");
    /** The node's history, which a payment changes. */
    let history: Transaction[] = [];
    beforeEach(() => {
      history = [tx(1, [[OTHER, 2000]], [[ME, 1000]])];
      serve({
        [`/address/${ME}`]: () => Response.json(stats()),
        [`/address/${ME}/txs`]: () => Response.json(history),
      });
    });

    it("asks nothing until the first status, so a payment just before it is shown", async () => {
      const el = open(`/address/${ME}`, false);
      await sleep(20);
      expect(calls.filter((c) => c.includes(ME))).toStrictEqual([]);
      // Paid before the page's subscription took effect: the first status counts the payment.
      history = [paid, ...history];
      status("s1");
      await until(() => expect(rows(el)).toHaveLength(2));
      expect(calls.filter((c) => c.endsWith("/txs"))).toHaveLength(1);
    });

    it("asks after a second without a status, and takes the late first status for a change", async () => {
      const el = open(`/address/${ME}`, false);
      await until(() => expect(rows(el)).toHaveLength(1));
      history = [paid, ...history];
      status("s1");
      await until(() => expect(rows(el)).toHaveLength(2));
    });

    it("asks at once when the node is unavailable, and refreshes on the status after it", async () => {
      const el = open(`/address/${ME}`, false);
      heard({ state: "unavailable" });
      await until(() => expect(rows(el)).toHaveLength(1));
      expect(text(el)).toContain("lost touch with its node");
      history = [paid, ...history];
      status("s1");
      await until(() => expect(rows(el)).toHaveLength(2));
    });

    it("asks the server, never the browser's cache, which can hold an answer from before", async () => {
      const el = open(`/address/${ME}`);
      await until(() => expect(rows(el)).toHaveLength(1));
      history = [paid, ...history];
      status("s1");
      await until(() => expect(rows(el)).toHaveLength(2));
      // The totals and the first page; the balance chart checks its own answers against the totals.
      const own = caching.filter((_, i) => /\/address\/\w+(\/txs)?$/.test(calls[i] ?? ""));
      expect(own.length).toBeGreaterThanOrEqual(4);
      expect(new Set(own)).toStrictEqual(new Set(["no-cache"]));
    });
  });

  it("asks again when the address index has not caught up with the change yet", async () => {
    const old = [tx(1, [[OTHER, 2000]], [[ME, 1000]])];
    let served = 0;
    serve({
      [`/address/${ME}`]: () => Response.json(stats()),
      // The index answers with the old history once more after the status changed.
      [`/address/${ME}/txs`]: () =>
        Response.json(++served < 3 ? old : [tx(2, [[OTHER, 9000]], [[ME, 8000]], false), ...old]),
    });
    const el = open(`/address/${ME}`, "s1");
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(1));
    status("s2");
    await vi.waitFor(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(2), {
      timeout: 3000,
    });
    expect(served).toBe(3);
  });

  it("says, without alarm, when the page cannot update itself", async () => {
    serve({ [`/address/${ME}`]: stats(), [`/address/${ME}/txs`]: [] });
    const el = open(`/address/${ME}`, false);
    await until(() => expect(text(el)).toContain("This address has never been used"));
    expect(el.querySelector(".address-live")).toBeNull();
    heard({ state: "refused", reason: "too_large" });
    await until(() => expect(text(el)).toContain("too much history for the node to watch"));
    heard({ state: "refused", reason: "server_full" });
    await until(() => expect(text(el)).toContain("watching as many addresses as it can"));
    heard({ type: "refused", reason: "server_full" });
    await until(() => expect(text(el)).toContain("watching as many addresses as it can"));
    // Opening addresses too fast is this visitor's own limit, not the server being full.
    heard({ type: "refused", reason: "follow_rate" });
    await until(() => expect(text(el)).toContain("Too many addresses were opened at once"));
    expect(text(el)).not.toContain("watching as many addresses as it can");
    heard({ state: "unavailable" });
    await until(() => expect(text(el)).toContain("lost touch with its node"));
    heard({ state: "refused", reason: "no_index" });
    await until(() => expect(el.querySelector(".address-live")).toBeNull());
    status("s1");
    FakeSocket.last().drop(1006);
    await until(() => expect(text(el)).toContain("The live connection dropped."));
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a transaction a refresh pushes off the first page", async () => {
    // Confirmed transactions n = 1..50, newest first; a newly confirmed n = 0 arrives later.
    const conf = (n: number) => tx(n, [[OTHER, 2000]], [[ME, 1000]]);
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => conf(from + i));
    let firstPage = range(1, 25);
    serve({
      [`/address/${ME}`]: () => Response.json(stats(part(1, 0, 50))),
      [`/address/${ME}/txs`]: () => Response.json(firstPage),
      [`/address/${ME}/txs?after_txid=${txid(25)}`]: range(26, 50),
      [`/address/${ME}/txs?after_txid=${txid(50)}`]: [],
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(25));
    [...el.querySelectorAll("button")].find((b) => text(b) === "Show 25 more")?.click();
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(50));
    firstPage = range(0, 24);
    status(`after ${String(firstPage.length)}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(51));
    const ids = [...el.querySelectorAll("tbody tr a:not(.table__rowlink)")].map((a) =>
      a.getAttribute("href"),
    );
    expect(ids).toStrictEqual(range(0, 50).map((t) => `/tx/${t.txid}`));
  });

  it("drops a page that arrives after a refresh replaced the rows it continues, and asks after the new ones", async () => {
    const conf = (n: number) => tx(n, [[OTHER, 2000]], [[ME, 1000]]);
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => conf(from + i));
    let firstPage = range(31, 55);
    let release: (r: Response) => void = () => {};
    serve({
      [`/address/${ME}`]: () => Response.json(stats(part(1, 0, 80))),
      [`/address/${ME}/txs`]: () => Response.json(firstPage),
      [`/address/${ME}/txs?after_txid=${txid(25)}`]: range(26, 50),
      [`/address/${ME}/txs?after_txid=${txid(55)}`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(25));
    [...el.querySelectorAll("button")].find((b) => text(b) === "Show 25 more")?.click();
    await until(() => expect(calls.some((c) => c.includes("after_txid"))).toBe(true));
    // Thirty new transactions arrive while the page request is in flight.
    firstPage = range(1, 25);
    status(`after ${String(firstPage.length)}`);
    await until(() =>
      expect(el.querySelector("tbody tr a")?.getAttribute("href")).toBe(`/tx/${txid(1)}`),
    );
    release(Response.json(range(56, 80)));
    // The stale page is dropped; the page the reader asked for comes after the new rows.
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(50));
    const ids = [...el.querySelectorAll("tbody tr a:not(.table__rowlink)")].map((a) =>
      a.getAttribute("href"),
    );
    expect(ids).toStrictEqual(range(1, 50).map((t) => `/tx/${t.txid}`));
  });

  it("still loads the page asked for when a payment arrives while it is on its way", async () => {
    const conf = (n: number) => tx(n, [[OTHER, 2000]], [[ME, 1000]]);
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => conf(from + i));
    const payment = tx(999, [[OTHER, 3000]], [[ME, 2000]], false);
    let firstPage = range(1, 25);
    let release: (r: Response) => void = () => {};
    let asked = 0;
    serve({
      [`/address/${ME}`]: () => Response.json(stats(part(1, 0, 113))),
      [`/address/${ME}/txs`]: () => Response.json(firstPage),
      [`/address/${ME}/txs?after_txid=${txid(25)}`]: range(26, 50),
      [`/address/${ME}/txs?after_txid=${txid(50)}`]: () => {
        asked++;
        // The first ask is held until the payment has refreshed the page; the next answers.
        return asked === 1
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : Response.json(range(51, 75));
      },
    });
    const el = open(`/address/${ME}`);
    const more = () => [...el.querySelectorAll("button")].find((b) => text(b) === "Show 25 more");
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(25));
    status("s0");
    more()?.click();
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(50));
    more()?.click();
    await until(() => expect(asked).toBe(1));
    // Another wallet pays the address while the third page is on its way.
    firstPage = [payment, ...range(1, 25)];
    status("paid");
    await until(() =>
      expect(text(el.querySelector("tbody tr") as Element)).toContain("Unconfirmed"),
    );
    release(Response.json(range(51, 75)));
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(76));
    const ids = [...el.querySelectorAll("tbody tr a:not(.table__rowlink)")].map((a) =>
      a.getAttribute("href"),
    );
    expect(ids).toStrictEqual([payment, ...range(1, 75)].map((t) => `/tx/${t.txid}`));
  });

  it("keeps a page on its way through a refresh that changed nothing", async () => {
    let reorder = false;
    const conf = (n: number) => tx(n, [[OTHER, 2000]], [[ME, 1000]]);
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => conf(from + i));
    let release: (r: Response) => void = () => {};
    serve({
      [`/address/${ME}`]: () => Response.json(stats(part(1, 0, 50))),
      [`/address/${ME}/txs`]: () =>
        Response.json(reorder ? [conf(2), conf(1), ...range(3, 25)] : range(1, 25)),
      [`/address/${ME}/txs?after_txid=${txid(25)}`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(25));
    [...el.querySelectorAll("button")].find((b) => text(b) === "Show 25 more")?.click();
    await until(() => expect(calls.some((c) => c.includes("after_txid"))).toBe(true));
    // A change heard, which the page answers with one more look: the same history, though the
    // node lists it in another order.
    status("s0");
    reorder = true;
    status("s1");
    await until(() => expect(calls.filter((c) => c.endsWith("/txs"))).toHaveLength(2));
    release(Response.json(range(26, 50)));
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(50));
  });

  it("drops a page that arrives after a refresh, even when the last row is unchanged", async () => {
    const conf = (n: number) => tx(n, [[OTHER, 2000]], [[ME, 1000]]);
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => conf(from + i));
    let firstPage = range(31, 55);
    let release: (r: Response) => void = () => {};
    serve({
      [`/address/${ME}`]: () => Response.json(stats(part(1, 0, 80))),
      [`/address/${ME}/txs`]: () => Response.json(firstPage),
      [`/address/${ME}/txs?after_txid=${txid(55)}`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(25));
    [...el.querySelectorAll("button")].find((b) => text(b) === "Show 25 more")?.click();
    await until(() => expect(calls.some((c) => c.includes("after_txid"))).toBe(true));
    // A reorg leaves only transaction 55: the whole history is now one row, the same last row.
    firstPage = [conf(55)];
    status(`after ${String(firstPage.length)}`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(1));
    release(Response.json(range(56, 80)));
    // The reply has nothing on screen to wait for, so give it time to land.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(1);
    // Nothing comes after the one row, so nothing more is asked.
    expect(calls.filter((c) => c.includes("after_txid"))).toHaveLength(1);
  });

  it("says plainly when an address has never been used", async () => {
    serve({ [`/address/${ME}`]: stats(part(0, 0, 0)), [`/address/${ME}/txs`]: [] });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("This address has never been used"));
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(text(el.querySelector(".address-stat__value .amount") as Element)).toBe("0 BTC");
  });

  it("answers a malformed address without asking the server, as text", async () => {
    serve({});
    const el = open(`/address/${encodeURIComponent('<img src=x onerror="alert(1)">')}`);
    expect(text(el)).toContain("This is not a valid address");
    expect(text(el)).toContain("Mainnet addresses start with bc1, 1 or 3");
    expect(text(el.querySelector(".address-head__raw") as Element)).toBe(
      '<img src=x onerror="alert(1)">',
    );
    expect(el.querySelector("img")).toBeNull();
    expect(calls).toStrictEqual([]);
  });

  it("treats an address the server rejects as malformed", async () => {
    serve({
      [`/address/${ME}`]: refused(400, "invalid address"),
      [`/address/${ME}/txs`]: refused(400, "invalid address"),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("This is not a valid address"));
  });

  it("points a test-network address on mainnet to the network that serves it", async () => {
    serve({ "/app/config": { networks: ["mainnet", "signet"], version: "0" } });
    const tb = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const el = open(`/address/${tb}`);
    expect(text(el)).toContain("This is a Signet, Testnet4 or Testnet5 address");
    await until(() => expect(el.querySelector(".address-elsewhere a")).not.toBeNull());
    const links = [...el.querySelectorAll(".address-elsewhere a")];
    expect(links.map((a) => [text(a), a.getAttribute("href")])).toStrictEqual([
      ["Open it on Signet", `/signet/address/${tb}`],
    ]);
    expect(calls).toStrictEqual(["/app/config"]);
  });

  describe("a silent payments address", () => {
    it("shows its keys, read from the address without asking the server anything", async () => {
      serve({});
      const el = open(`/address/${SP}`);
      expect(text(el.querySelector(".address-type") as Element)).toBe("Silent payments");
      expect(text(el)).toContain("ValidSilent payments address for Mainnet");
      expect(text(el)).toContain("There is no balance or history to show");
      const facts = [...el.querySelectorAll(".address-sp-fact")].map((f) => [
        text(f.querySelector("dt") as Element),
        text(f.querySelector(".hash__text") ?? (f.querySelector("dd") as Element)),
        f.querySelector(".copy")?.getAttribute("title"),
      ]);
      expect(facts).toStrictEqual([
        ["Network", "Mainnet (sp)", undefined],
        ["Version", "0", undefined],
        [
          "Scan key",
          "0220bcfac5b99e04ad1a06ddfb016ee13582609d60b6291e98d01a9bc9a16c96d4",
          "Copy the scan key, as hex",
        ],
        [
          "Spend key",
          "025cc9856d6f8375350e123978daac200c260cb5b5ae83106cab90484dcd8fcf36",
          "Copy the spend key, as hex",
        ],
      ]);
      await sleep(50);
      expect(calls).toStrictEqual([]);
      expect(FakeSocket.all).toStrictEqual([]);
    });

    it("reads an upper-case address as its lower-case form", () => {
      serve({});
      const el = open(`/address/${SP.toUpperCase()}`);
      expect(text(el)).toContain("Silent payments address for Mainnet");
      expect(text(el.querySelector(".address-head .hash__text") as Element)).toBe(SP);
    });

    it("decodes a test network address on a test network", () => {
      serve({});
      const el = open(`/signet/address/${TSP}`);
      expect(text(el)).toContain("Silent payments address for Signet");
      expect(text(el)).toContain("NetworkSignet (tsp)");
    });

    it("points a test network address on mainnet to the networks that serve it", async () => {
      serve({ "/app/config": { networks: ["mainnet", "regtest"], version: "0" } });
      const el = open(`/address/${TSP}`);
      expect(text(el)).toContain("This is a Signet, Testnet4, Testnet5 or Regtest address");
      await until(() => expect(el.querySelector(".address-elsewhere a")).not.toBeNull());
      expect(el.querySelector(".address-elsewhere a")?.getAttribute("href")).toBe(
        `/regtest/address/${TSP}`,
      );
      expect(el.querySelector(".address-sp-fact")).toBeNull();
    });

    it("says what is wrong with one that does not check out", () => {
      serve({});
      const el = open(`/address/${SP.slice(0, -1)}q`);
      expect(text(el)).toContain("This is not a valid silent payments address");
      expect(text(el)).toContain("Its checksum does not match");
      expect(el.querySelector(".address-sp-fact")).toBeNull();
      expect(calls).toStrictEqual([]);
    });
  });

  it("says when no enabled network serves the address", async () => {
    serve({ "/app/config": { networks: ["signet"], version: "0" } });
    const el = open(`/signet/address/${ME}`);
    await until(() => expect(text(el)).toContain("This server does not serve Mainnet."));
  });

  it("leads an address too large to total with what the node said, and asks nothing slow", async () => {
    serve({
      [`/address/${ME}`]: refused(503, "address history too large for this server"),
      [`/app/address/${ME}/size`]: { creates: 3_665_660, cap: 10_000 },
      [`/address/${ME}/txs/mempool`]: [tx(7, [[OTHER, 9000]], [[ME, 2500]], false)],
      [`/address/${ME}/txs`]: [tx(1, [[OTHER, 2000]], [[ME, 1000]])],
    });
    const el = open(`/address/${ME}?view=unspent`);
    await until(() => expect(text(el)).toContain(`3${NNBSP}665${NNBSP}660`));
    expect(text(el)).toContain("transactions paid to it, as counted by the node");
    expect(text(el)).toContain(`10${NNBSP}000`);
    await until(() => expect(el.querySelector(`a[href="/tx/${txid(7)}"]`)).not.toBeNull());
    expect(text(el)).toContain("1 transaction");
    // What is not shown, and why, once; no advice to look elsewhere, no tabs, no alarm.
    expect(text(el)).toContain(
      `The node adds up only addresses paid by at most 10${NNBSP}000 transactions`,
    );
    for (const gone of ["another explorer", "Totals are not available", "Reload"]) {
      expect(text(el)).not.toContain(gone);
    }
    expect(el.querySelector('[role="tab"]')).toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    // Past the wait for the totals too: a page of its history can keep the node busy for a minute.
    await sleep(1200);
    // Only the totals and the mempool rows: never its history, balance history or unspent outputs.
    expect(new Set(calls.filter((c) => c.startsWith("/api/")))).toStrictEqual(
      new Set([`/api/address/${ME}`, `/api/address/${ME}/txs/mempool`]),
    );
  });

  it("says what it can when the server does not know the size", async () => {
    serve({
      [`/address/${ME}`]: refused(503, "address history too large for this server"),
      [`/address/${ME}/txs/mempool`]: [],
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("Nothing waiting to confirm"));
    await until(() =>
      expect(text(el)).toContain("It has more history than this server's node adds up"),
    );
    expect(text(el)).not.toContain("Received");
    expect(el.querySelector(".skeleton")).toBeNull();
  });

  it("shows a new unconfirmed transaction of a large address without a reload", async () => {
    let pool = [tx(7, [[OTHER, 9000]], [[ME, 2500]], false)];
    serve({
      [`/address/${ME}`]: refused(503, "address history too large for this server"),
      [`/app/address/${ME}/size`]: { creates: 20_000, cap: 10_000 },
      [`/address/${ME}/txs/mempool`]: () => Response.json(pool),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(el.querySelector(`a[href="/tx/${txid(7)}"]`)).not.toBeNull());
    const row = el.querySelector(`a[href="/tx/${txid(7)}"]`)?.closest("tr");
    pool = [tx(8, [[ME, 4000]], [[OTHER, 3000]], false), ...pool];
    // The page asks every POLL_MS while in view, and at once when it comes back into view.
    document.dispatchEvent(new Event("visibilitychange"));
    await until(() => expect(el.querySelector(`a[href="/tx/${txid(8)}"]`)).not.toBeNull());
    const rows = [...el.querySelectorAll("tbody tr")];
    expect(rows[0]?.textContent).toContain(txid(8).slice(-4));
    expect(rows[0]?.classList.contains("address-row--new")).toBe(true);
    // The row already shown is the same element: nothing a reader focused is lost.
    expect(rows[1]).toBe(row);
    expect(text(el)).toContain("2 transactions");
    // Confirmed: it leaves the list.
    pool = [];
    document.dispatchEvent(new Event("visibilitychange"));
    await until(() => expect(text(el)).toContain("Nothing waiting to confirm"));
    // Each ask is one request, and a fresh one.
    const asks = calls.filter((c) => c.endsWith("/txs/mempool"));
    expect(asks).toHaveLength(3);
  });

  it("never promises an empty unconfirmed list it could not check again", async () => {
    let up = true;
    serve({
      [`/address/${ME}`]: refused(503, "address history too large for this server"),
      [`/address/${ME}/txs/mempool`]: () =>
        up ? Response.json([]) : refused(502, "upstream unavailable")(),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("shows here within 10 seconds"));
    up = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await until(() => expect(text(el)).toContain("The last check failed"));
    expect(text(el)).not.toContain("shows here within");
    // A retry in flight is no answer: the warning holds and nothing is promised until one comes.
    let answer: (r: Response) => void = () => undefined;
    serve({
      [`/address/${ME}`]: refused(503, "address history too large for this server"),
      [`/address/${ME}/txs/mempool`]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(100);
    expect(text(el)).toContain("The last check failed");
    expect(text(el)).not.toContain("shows here within");
    answer(Response.json([]));
    await until(() => expect(text(el)).toContain("shows here within 10 seconds"));
    expect(text(el)).not.toContain("The last check failed");
  });

  it("asks for the history once the totals have answered, or after a second", async () => {
    let answer: (r: Response) => void = () => undefined;
    serve({
      [`/address/${ME}`]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
      [`/address/${ME}/txs`]: [tx(1, [[OTHER, 2000]], [[ME, 1000]])],
    });
    open(`/address/${ME}`);
    await sleep(300);
    expect(calls.some((c) => c.endsWith("/txs"))).toBe(false);
    answer(Response.json(stats(part(1000, 0, 1))));
    await until(() => expect(calls.some((c) => c.endsWith("/txs"))).toBe(true));
    // Totals that never answer hold the history back for a second only.
    calls = [];
    document.body.replaceChildren();
    serve({ [`/address/${OTHER}`]: never, [`/address/${OTHER}/txs`]: [] });
    open(`/address/${OTHER}`);
    await sleep(300);
    expect(calls.some((c) => c.endsWith("/txs"))).toBe(false);
    await until(() => expect(calls.some((c) => c.endsWith("/txs"))).toBe(true));
  });

  it("says why when the server refuses the history as too large", async () => {
    serve({
      [`/address/${ME}`]: stats(part(1000, 0, 1)),
      [`/address/${ME}/txs`]: refused(503, "address history too large for this server"),
    });
    const el = open(`/address/${ME}`);
    await until(() =>
      expect(text(el)).toContain("Transactions are not available for this address"),
    );
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("says the server does not index addresses, never that the address is empty", async () => {
    const off = refused(503, "address index is disabled on this server");
    serve({ [`/address/${ME}`]: off, [`/address/${ME}/txs`]: off });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("This server does not index addresses"));
    expect(text(el)).toContain("This says nothing about this address or its funds");
    expect(text(el)).not.toContain("never been used");
    expect(el.querySelector(".address-stats")).toBeNull();
  });

  it("offers a retry when the node is unavailable", async () => {
    let up = false;
    serve({
      [`/address/${ME}`]: () =>
        up ? Response.json(stats()) : refused(502, "upstream unavailable")(),
      [`/address/${ME}/txs`]: () =>
        up ? Response.json([]) : refused(502, "upstream unavailable")(),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("Could not load this address"));
    expect(text(el)).toContain("Upstream unavailable.");
    up = true;
    const retry = [...el.querySelectorAll("button")].find((b) => text(b) === "Try again");
    retry?.click();
    await until(() => expect(text(el)).toContain("1.00 BTC"));
    expect(text(el)).not.toContain("Could not load");
  });

  it("lists unspent outputs, unconfirmed first, with confirmations from the tip", async () => {
    const utxo = (n: number, value: number, height?: number): Utxo => ({
      txid: txid(n),
      vout: n,
      value,
      status:
        height !== undefined && height !== 0
          ? { confirmed: true, block_height: height }
          : { confirmed: false },
    });
    serve({
      [`/address/${ME}`]: stats(),
      [`/address/${ME}/txs`]: [],
      [`/address/${ME}/utxo`]: [utxo(1, 1000, 100), utxo(2, 2000), utxo(3, 3000, 110)],
      "/blocks/tip/height": () => new Response("110"),
    });
    const el = open(`/address/${ME}?view=unspent`);
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Unspent outputs",
    );
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(3));
    await until(() => expect(text(el.querySelectorAll("tbody tr")[2] as Element)).toContain("11"));
    // oxlint-disable-next-line oxc/no-map-spread -- three rows of a test; prefer-spread rules out concat
    const rows = [...el.querySelectorAll("tbody tr")].map((r) => [
      text(r.querySelector(".address-outpoint") as Element),
      ...[...r.querySelectorAll("td")].slice(1).map((e) => text(e)),
    ]);
    expect(rows).toStrictEqual([
      ["00000000…00000002:2", "0.00002000 BTC", "Unconfirmed"],
      ["00000000…00000003:3", "0.00003000 BTC", "1"],
      ["00000000…00000001:1", "0.00001000 BTC", "11"],
    ]);
    expect(text(el.querySelector(".address-history .section__meta") as Element)).toBe("3 outputs");
  });

  it("draws at most 100 unspent outputs at once", async () => {
    const many: Utxo[] = Array.from({ length: 201 }, (_, i) => ({
      txid: txid(i + 1),
      vout: 0,
      value: 1000,
      status: { confirmed: true, block_height: 1000 - i },
    }));
    serve({
      [`/address/${ME}`]: stats(),
      [`/address/${ME}/txs`]: [],
      [`/address/${ME}/utxo`]: many,
      "/blocks/tip/height": () => new Response("1000"),
    });
    const el = open(`/address/${ME}?view=unspent`);
    await until(() => expect(el.querySelectorAll("tbody tr .hash")).toHaveLength(100));
    const next = () => [...el.querySelectorAll("button")].find((b) => text(b) === "Next");
    next()?.click();
    await until(() =>
      expect(text(el.querySelector(".pagination__status") as Element)).toBe("Page 2 of 3"),
    );
    expect(el.querySelectorAll("tbody tr")).toHaveLength(100);
    next()?.click();
    await until(() => expect(el.querySelectorAll("tbody tr")).toHaveLength(1));
    expect(next()?.disabled).toBe(true);
  });

  it("shows a failed tip height as an error and retries it", async () => {
    let up = false;
    serve({
      [`/address/${ME}`]: stats(),
      [`/address/${ME}/txs`]: [],
      [`/address/${ME}/utxo`]: [
        { txid: txid(1), vout: 0, value: 1000, status: { confirmed: true, block_height: 10 } },
      ],
      "/blocks/tip/height": () =>
        up ? new Response("12") : Response.json({ error: "node unavailable" }, { status: 502 }),
    });
    const el = open(`/address/${ME}?view=unspent`);
    await until(() => expect(text(el)).toContain("Could not load the unspent outputs"));
    up = true;
    [...el.querySelectorAll("button")].find((b) => text(b) === "Try again")?.click();
    await until(() => expect(text(el.querySelectorAll("tbody td")[2] as Element)).toBe("3"));
  });

  it("moves between the views with the arrow keys", async () => {
    serve({
      [`/address/${ME}`]: never,
      [`/address/${ME}/txs`]: never,
      [`/address/${ME}/utxo`]: never,
    });
    const el = open(`/address/${ME}`);
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0]?.focus();
    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await until(() => expect(tabs[1]?.getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0]?.tabIndex).toBe(-1);
  });

  it("groups digits in counts", async () => {
    serve({
      [`/address/${ME}`]: stats(part(1, 0, 12_345)),
      [`/address/${ME}/txs`]: never,
    });
    const el = open(`/address/${ME}`);
    await until(() =>
      expect(text(el.querySelectorAll(".address-stat__value")[3] as Element)).toBe(`12${NNBSP}345`),
    );
  });
});

describe("lookalike addresses", () => {
  // Agrees with ME on "w5" after "bc1q" and on the last four, "f3t4".
  const FAKE = `bc1qw5${"q".repeat(32)}f3t4`;
  const PAYEE = `bc1pdcl${"q".repeat(51)}4uu7`;
  const FAKE_PAYEE = `bc1pdcl${"p".repeat(51)}4uu7`;
  const rows = (el: Element) => el.querySelectorAll(".address-txs tbody tr:not(.table__note)");
  const notes = (el: Element) => [...el.querySelectorAll(".address-txs .table__note")];

  it("warns under a row that names a lookalike of the page's own address, as text", async () => {
    serve({
      [`/address/${ME}`]: stats(part(2000, 0, 2)),
      [`/address/${ME}/txs`]: [
        tx(1, [[FAKE, 1000]], [[ME, 546]]),
        tx(2, [[OTHER, 2000]], [[ME, 1454]]),
      ],
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(rows(el)).toHaveLength(2));
    const [note] = notes(el);
    expect(notes(el)).toHaveLength(1);
    // Right under the row of the transaction that names it.
    expect(note?.previousElementSibling?.textContent).toContain(txid(1).slice(0, 8));
    expect(note?.querySelector("td")?.getAttribute("colspan")).toBe("4");
    const warning = note?.querySelector('[role="note"]') as Element;
    expect(text(warning)).toContain("An address here looks like this page's address");
    expect(text(warning)).toContain(FAKE);
    expect(text(warning)).toContain(ME);
    expect(text(warning)).toContain("Check every character");
    expect(text(warning)).toContain("may be address poisoning");
    expect(text(warning)).toContain("agree on the first 2 and last 4 characters after bc1q");
    const agree = [...warning.querySelectorAll(".lookalike__agree")].map((e) => text(e));
    expect(agree).toStrictEqual(["w5", "f3t4", "w5", "f3t4"]);
    // Nothing in it is a link or markup: the addresses are chain data.
    expect(warning.querySelector("a, img, script")).toBeNull();
  });

  it("hands a flagged row's findings to its transaction page in history state, not the URL", async () => {
    const one = tx(1, [[FAKE, 1000]], [[ME, 546]]);
    serve({
      [`/address/${ME}`]: stats(part(2000, 0, 2)),
      [`/address/${ME}/txs`]: [one, tx(2, [[OTHER, 2000]], [[ME, 1454]])],
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(rows(el)).toHaveLength(2));
    const [flagged, plain] = [...rows(el)];
    // The txid's link and the whole row's link both carry it.
    const links = [...(flagged?.querySelectorAll("a") ?? [])];
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute("href")).toBe(`/tx/${txid(1)}`);
      const h = readHandover(JSON.parse(a.getAttribute("state") ?? "null"), one, "mainnet");
      expect(h?.from).toBe(ME);
      expect(h?.found.map((l) => [l.here, l.like, l.own, l.head, l.tail])).toStrictEqual([
        [FAKE, ME, true, 2, 4],
      ]);
    }
    // A row without a lookalike carries nothing, and no link anywhere names the address in its URL.
    expect(plain?.querySelector("a[state]")).toBeNull();
    for (const a of el.querySelectorAll(".address-txs a")) {
      expect(a.getAttribute("href")).not.toContain(ME);
    }
  });

  it("marks an earlier row once a later page brings a lookalike of its payee", async () => {
    const first = Array.from({ length: 25 }, (_, i) =>
      i === 3 ? tx(4, [[ME, 9000]], [[PAYEE, 8000]]) : tx(i + 1, [[OTHER, 2000]], [[ME, 1000]]),
    );
    serve({
      [`/address/${ME}`]: stats(part(26_000, 9000, 26)),
      [`/address/${ME}/txs`]: first,
      [`/address/${ME}/txs?after_txid=${txid(25)}`]: [tx(26, [[FAKE_PAYEE, 1000]], [[ME, 546]])],
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(rows(el)).toHaveLength(25));
    expect(el.querySelector(".lookalike")).toBeNull();
    [...el.querySelectorAll("button")].find((b) => text(b) === "Show 25 more")?.click();
    await until(() => expect(notes(el)).toHaveLength(2));
    const [paid, poison] = notes(el);
    expect(paid?.previousElementSibling?.textContent).toContain(txid(4).slice(0, 8));
    expect(text(paid as Element)).toContain("looks like another in this history");
    expect(text(paid as Element)).toContain(FAKE_PAYEE);
    expect(text(poison as Element)).toContain(PAYEE);
    expect(text(poison as Element)).toContain("Elsewhere in this history");
  });

  it("adds nothing to an ordinary history", async () => {
    serve({
      [`/address/${ME}`]: stats(part(2000, 0, 2)),
      [`/address/${ME}/txs`]: [
        tx(1, [[OTHER, 1000]], [[ME, 546]]),
        tx(2, [[ME, 546]], [[OTHER, 300]]),
      ],
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(rows(el)).toHaveLength(2));
    expect(notes(el)).toHaveLength(0);
    expect(text(el)).not.toContain("poisoning");
  });

  describe("the notice at the top", () => {
    const poison = (el: Element) => el.querySelector(".address-poison");
    const live = (el: Element) => text(el.querySelector(".address-announce") as Element);
    const button = (el: Element, name: string) =>
      [...el.querySelectorAll("button")].find((b) => text(b) === name);

    it("says nothing, and announces nothing, for an ordinary history", async () => {
      serve({
        [`/address/${ME}`]: stats(part(2000, 0, 2)),
        [`/address/${ME}/txs`]: [tx(1, [[OTHER, 1000]], [[ME, 546]])],
      });
      const el = open(`/address/${ME}`);
      await until(() => expect(rows(el)).toHaveLength(1));
      expect(poison(el)).toBeNull();
      expect(live(el)).toBe("");
    });

    it("leads the page with a lookalike of its own address, shown whole, and says it once", async () => {
      serve({
        [`/address/${ME}`]: stats(part(2000, 0, 2)),
        [`/address/${ME}/txs`]: [
          tx(1, [[FAKE, 1000]], [[ME, 546]]),
          tx(2, [[OTHER, 2000]], [[ME, 1454]]),
        ],
      });
      const el = open(`/address/${ME}`);
      await until(() => expect(poison(el)).not.toBeNull());
      const notice = poison(el) as Element;
      // Above the totals, outside the history's tabs.
      expect(notice.nextElementSibling?.classList.contains("address-totals")).toBe(true);
      expect(notice.closest(".address-history")).toBeNull();
      expect(text(notice.querySelector("h2") as Element)).toBe(
        "Someone may be imitating this address",
      );
      expect(text(notice)).toContain(
        "1 of the 2 transactions in the history names an address that starts and ends like this one.",
      );
      expect(text(notice)).toContain(FAKE);
      expect(text(notice)).toContain("Check every character, not just the ends");
      // The whole history is loaded: it does not say older ones are unchecked.
      expect(text(notice)).not.toContain("Older transactions");
      const agree = [...notice.querySelectorAll(".lookalike__agree")].map((e) => text(e));
      expect(agree).toStrictEqual(["w5", "f3t4", "w5", "f3t4"]);
      expect(notice.querySelector("a, img, script")).toBeNull();
      expect(button(el, "Go to the transaction")).toBeDefined();
      expect(live(el)).toBe("Someone may be imitating this address");
    });

    it("counts only the pages loaded, and counts again as more load", async () => {
      const first = Array.from({ length: 25 }, (_, i) =>
        i === 3 ? tx(4, [[ME, 9000]], [[PAYEE, 8000]]) : tx(i + 1, [[OTHER, 2000]], [[ME, 1000]]),
      );
      first[0] = tx(1, [[FAKE, 1000]], [[ME, 546]]);
      serve({
        [`/address/${ME}`]: stats(part(30_000, 9000, 30)),
        [`/address/${ME}/txs`]: first,
        [`/address/${ME}/txs?after_txid=${txid(25)}`]: [
          tx(26, [[FAKE_PAYEE, 1000]], [[ME, 546]]),
          tx(27, [[OTHER, 1000]], [[ME, 546]]),
        ],
      });
      const el = open(`/address/${ME}`);
      await until(() => expect(poison(el)).not.toBeNull());
      expect(text(poison(el) as Element)).toContain(
        "1 of the 25 transactions loaded so far names an address that starts and ends like this one.",
      );
      expect(text(poison(el) as Element)).toContain(
        "Older transactions are checked as you load them.",
      );
      button(el, "Show 25 more")?.click();
      await until(() =>
        expect(text(poison(el) as Element)).toContain(
          "3 of the 27 transactions in the history name an address that starts and ends like this one, or like another address in this history.",
        ),
      );
      // The second page was short, so the history has no more: said of the list, whatever the
      // totals (30 here) say, and without the line about older transactions.
      expect(text(poison(el) as Element)).not.toContain("Older transactions");
      expect(button(el, "Go to the first of them")).toBeDefined();
      // Announced when it appeared, and not again for the new count.
      expect(live(el)).toBe("Someone may be imitating this address");
    });

    it("stops promising older transactions once a later page answers empty", async () => {
      // Exactly one full page: only asking for more can tell there are none.
      const first = Array.from({ length: 25 }, (_, i) => tx(i + 1, [[OTHER, 2000]], [[ME, 1000]]));
      first[0] = tx(1, [[FAKE, 1000]], [[ME, 546]]);
      serve({
        [`/address/${ME}`]: stats(part(30_000, 9000, 25)),
        [`/address/${ME}/txs`]: first,
        [`/address/${ME}/txs?after_txid=${txid(25)}`]: [],
      });
      const el = open(`/address/${ME}`);
      await until(() => expect(poison(el)).not.toBeNull());
      expect(text(poison(el) as Element)).toContain("1 of the 25 transactions loaded so far");
      button(el, "Show 25 more")?.click();
      await until(() =>
        expect(text(poison(el) as Element)).toContain("1 of the 25 transactions in the history"),
      );
      expect(text(poison(el) as Element)).not.toContain("Older transactions");
      expect(button(el, "Show 25 more")).toBeUndefined();
      // That answer came from the server, not the browser's cache: an old empty one would hide
      // rows a reorg added.
      expect(caching[calls.findIndex((c) => c.includes("after_txid"))]).toBe("no-cache");
    });

    it("names a lookalike of another address in the history without showing it", async () => {
      serve({
        [`/address/${ME}`]: stats(part(9000, 9000, 2)),
        [`/address/${ME}/txs`]: [
          tx(1, [[FAKE_PAYEE, 1000]], [[ME, 546]]),
          tx(2, [[ME, 9000]], [[PAYEE, 8000]]),
        ],
      });
      const el = open(`/address/${ME}`);
      await until(() => expect(poison(el)).not.toBeNull());
      const notice = poison(el) as Element;
      expect(text(notice.querySelector("h2") as Element)).toBe(
        "Lookalike addresses in this history",
      );
      expect(text(notice)).toContain(
        "2 of the 2 transactions in the history name addresses that look like one another: one of each pair may have been made to imitate the other.",
      );
      expect(text(notice)).not.toContain(PAYEE);
      expect(notice.querySelector(".lookalike__pair")).toBeNull();
    });

    it("goes to the first marked row from the unspent outputs view, and focuses its warning", async () => {
      serve({
        [`/address/${ME}`]: stats(part(2000, 0, 2)),
        [`/address/${ME}/txs`]: [
          tx(1, [[OTHER, 2000]], [[ME, 1454]]),
          tx(2, [[FAKE, 1000]], [[ME, 546]]),
        ],
        [`/address/${ME}/utxo`]: [],
        "/blocks/tip/height": () => new Response("110"),
      });
      const scrolled: Element[] = [];
      Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
        scrolled.push(this);
      };
      vi.stubGlobal("matchMedia", () => ({ matches: true }));
      try {
        const el = open(`/address/${ME}?view=unspent`);
        await until(() => expect(poison(el)).not.toBeNull());
        expect(el.querySelector(".address-txs")).toBeNull();
        button(el, "Go to the transaction")?.click();
        await until(() => expect(el.querySelector(".address-txs")).not.toBeNull());
        const tab = el.querySelector("#address-tab-transactions");
        expect(tab?.getAttribute("aria-selected")).toBe("true");
        const warning = document.activeElement as Element;
        expect(warning.id).toBe(`lookalike-${txid(2)}`);
        // The row above the warning is brought into view, not the warning alone.
        expect(scrolled[0]?.textContent).toContain(txid(2).slice(0, 8));
      } finally {
        delete (Element.prototype as Partial<Element>).scrollIntoView;
      }
    });
  });
});

describe("balance chart", () => {
  const T = 1_794_000_000;
  const TIP = "e".repeat(64);
  /** A summary row: transaction `n` in block `height`, ten minutes a block after T. */
  const sum = (n: number, value: number, height: number) => ({
    txid: txid(n),
    value,
    height,
    time: T + (height - 100) * 600,
    tx_position: 1,
  });
  const stamped = (body: unknown) => () =>
    Response.json(body, {
      headers: { "x-bitcoin-chain-tip": TIP, "x-bitcoin-chain-tip-height": "200" },
    });
  const slider = (el: Element) =>
    el.querySelector<HTMLElement>("[role=slider][aria-label^='Confirmed balance']");
  const key = (target: Element, k: string) => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    flush();
  };
  const summaries = () => calls.filter((c) => c.includes("/txs/summary"));

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("steps through a receive, a spend and a receive, read by keyboard and pointer", async () => {
    serve({
      [`/address/${ME}`]: stats(part(80_000, 50_000, 3)),
      [`/address/${ME}/txs`]: [],
      [`/address/${ME}/txs/summary`]: stamped([
        sum(3, 30_000, 102),
        sum(2, -50_000, 101),
        sum(1, 50_000, 100),
      ]),
    });
    const el = open(`/address/${ME}`);
    const chart = await vi.waitFor(() => slider(el) ?? Promise.reject(new Error("no chart")), {
      timeout: 2000,
    });
    expect(text(el.querySelector(".address-balance .section__meta") as Element)).toBe(
      "3 confirmed transactions",
    );
    expect(chart.getAttribute("aria-valuemax")).toBe("2");
    // The latest step first: the time, the balance, the block and what it changed.
    expect(chart.getAttribute("aria-valuetext")).toBe(
      "6 Nov 2026, 21:40 UTC: Balance 0.00030000 BTC, Block 102, Change +0.00030000 BTC",
    );
    key(chart, "ArrowLeft");
    expect(chart.getAttribute("aria-valuetext")).toContain(
      "Balance 0.00000000 BTC, Block 101, Change −0.00050000 BTC",
    );
    key(chart, "Home");
    expect(chart.getAttribute("aria-valuetext")).toContain("21:20 UTC: Balance 0.00050000 BTC");
    key(chart, "Escape");
    expect(chart.getAttribute("aria-valuetext")).toContain("Block 102");
    // The plot starts 66 px in, with the first step at its left edge: left of that is the first.
    const svg = chart.querySelector("svg") as SVGSVGElement;
    svg.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 40,
        clientY: 100,
        bubbles: true,
        pointerType: "mouse",
      }),
    );
    flush();
    expect(chart.getAttribute("aria-valuetext")).toContain("Block 100");
    expect(text(el.querySelector(".chart__readout") as Element)).toContain("0.00050000 BTC");
    // One summary page held the whole history: nothing else was asked.
    expect(summaries()).toStrictEqual([`/api/address/${ME}/txs/summary`]);
    expect(calls.filter((c) => c.includes("asof"))).toStrictEqual([]);
  });

  it("asks for its history only after the page's own transactions have answered", async () => {
    let release: (r: Response) => void = () => {};
    serve({
      [`/address/${ME}`]: stats(),
      [`/address/${ME}/txs`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("Balance over time"));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(summaries()).toStrictEqual([]);
    release(Response.json([]));
    await until(() => expect(summaries()).toHaveLength(1));
  });

  it("asks for its history only when it is about to be seen", async () => {
    inView = false;
    serve({ [`/address/${ME}`]: stats(), [`/address/${ME}/txs`]: [] });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("Balance over time"));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(summaries()).toStrictEqual([]);
    for (const o of observers) o.report();
    await until(() => expect(summaries()).toHaveLength(1));
  });

  it("draws no chart, and asks for nothing, for an address with no history", async () => {
    serve({ [`/address/${ME}`]: stats(part(0, 0, 0)), [`/address/${ME}/txs`]: [] });
    const el = open(`/address/${ME}`);
    await until(() => expect(text(el)).toContain("This address has never been used"));
    expect(text(el)).not.toContain("Balance over time");
    expect(summaries()).toStrictEqual([]);
  });

  it("says when it shows only the newest part of a long history, ending at the true balance", async () => {
    const replies: Record<string, Reply> = {
      [`/address/${ME}`]: stats(part(9_000_000, 0, 5598)),
      [`/address/${ME}/txs`]: [],
      [`/address/${ME}?asof=${TIP}`]: stamped(stats(part(9_000_000, 0, 5598))),
    };
    // 5 598 rows of 100 sats, newest first; only eight pages may be asked for.
    const row = (i: number) => sum(10_000 - i, 100, 10_000 - i);
    for (let p = 0; p < 8; p++) {
      const page = Array.from({ length: 25 }, (_, i) => row(p * 25 + i));
      const cursor = p === 0 ? "" : `/${txid(10_000 - p * 25 + 1)}?asof=${TIP}`;
      replies[`/address/${ME}/txs/summary${cursor}`] = stamped(page);
    }
    serve(replies);
    const el = open(`/address/${ME}`);
    const chart = await vi.waitFor(() => slider(el) ?? Promise.reject(new Error("no chart")), {
      timeout: 2000,
    });
    expect(summaries()).toHaveLength(8);
    expect(text(el.querySelector(".address-balance .section__meta") as Element)).toBe(
      `The last 200 of 5${NNBSP}598 confirmed transactions`,
    );
    expect(chart.getAttribute("aria-label")).toContain("the last 200 transactions");
    expect(chart.getAttribute("aria-valuetext")).toContain("Balance 0.09000000 BTC");
    key(chart, "Home");
    // The oldest loaded block: its balance follows from the true one; its change may be partial.
    expect(chart.getAttribute("aria-valuetext")).toContain(
      `Balance 0.08980100 BTC, Block 9${NNBSP}801, Change no data`,
    );
  });

  it("follows a new payment with one request, not the whole history again", async () => {
    let rows = [sum(2, -10_000, 101), sum(1, 50_000, 100)];
    serve({
      [`/address/${ME}`]: stats(part(50_000, 10_000, 2)),
      [`/address/${ME}/txs`]: [],
      [`/address/${ME}/txs/summary`]: () => stamped(rows)(),
    });
    const el = open(`/address/${ME}`);
    const chart = await vi.waitFor(() => slider(el) ?? Promise.reject(new Error("no chart")), {
      timeout: 2000,
    });
    expect(chart.getAttribute("aria-valuemax")).toBe("1");
    // The first status asked nothing more; a change asks for one summary page.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(summaries()).toHaveLength(1);
    rows = [sum(3, 25_000, 102), ...rows];
    status("s2");
    await until(() => expect(chart.getAttribute("aria-valuemax")).toBe("2"));
    expect(chart.getAttribute("aria-valuetext")).toContain(
      "Balance 0.00065000 BTC, Block 102, Change +0.00025000 BTC",
    );
    expect(text(el.querySelector(".address-balance .section__meta") as Element)).toBe(
      "3 confirmed transactions",
    );
  });

  describe("a kept address", () => {
    const keptLedger = (history: string, again: number | null = null) => ({
      state: "tracked",
      chain_stats: part(150_000_000, 50_000_000, 30),
      balance: 100_000_000,
      at: { height: 900_000, hash: "00", time: 1_700_000_000 },
      seeded: { height: 899_000, time: 1_699_000_000 },
      window: 200,
      filling: false,
      history,
      history_again: again,
      txs: [{ txid: txid(7), height: 899_500, position: 3, value: 5000, time: 1_699_500_000 }],
      points: [],
    });
    const chain = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => tx(from + i, [[OTHER, 6000]], [[ME, 5000]]));

    it("pages every confirmed transaction once its whole history is kept", async () => {
      const first = chain(1, 25);
      serve({
        [`/app/address/${ME}/ledger`]: keptLedger("whole"),
        [`/address/${ME}`]: stats(part(150_000_000, 50_000_000, 30)),
        [`/address/${ME}/txs/chain`]: first,
        [`/address/${ME}/txs/chain/${txid(25)}`]: chain(26, 5),
        [`/address/${ME}/txs/mempool`]: [],
      });
      const el = open(`/address/${ME}`);
      await until(() => expect(el.querySelectorAll(".address-txs tbody tr")).toHaveLength(25));
      expect(el.querySelector("#address-history-title")?.textContent).toBe("Transactions");
      expect(el.querySelector('[role="tablist"]')).toBeNull();
      expect(text(el)).toContain("25 of 30");
      expect(text(el)).not.toContain("newest 200");
      [...el.querySelectorAll("button")].find((b) => text(b) === "Show 25 more")?.click();
      await until(() => expect(el.querySelectorAll(".address-txs tbody tr")).toHaveLength(30));
      expect(calls).toContain(`/api/address/${ME}/txs/chain/${txid(25)}`);
      // Neither the node's mixed first page nor the unspent outputs, which are not kept.
      expect(calls.some((c) => c.endsWith("/txs") || c.includes("/utxo"))).toBe(false);
    });

    it("shows the whole history once the server has it, while the page is open", async () => {
      let history = "taking";
      serve({
        [`/app/address/${ME}/ledger`]: () => Response.json(keptLedger(history)),
        [`/address/${ME}`]: stats(part(150_000_000, 50_000_000, 30)),
        [`/address/${ME}/txs/chain`]: chain(1, 25),
        [`/address/${ME}/txs/mempool`]: [],
      });
      const el = open(`/address/${ME}`, false);
      heard({ state: "ledger", height: 900_000 });
      await until(() => expect(text(el)).toContain("is getting this address's whole history"));
      expect(calls.some((c) => c.includes("/txs/chain"))).toBe(false);
      // The server is done: it tells the address's followers, and the page asks again.
      history = "whole";
      heard({ state: "ledger", height: 900_000 });
      await until(() => expect(el.querySelectorAll(".address-txs tbody tr")).toHaveLength(25));
      expect(el.querySelector("#address-history-title")?.textContent).toBe("Transactions");
      expect(text(el)).not.toContain("is getting this address's whole history");
    });

    it("counts a kept history's lookalikes as confirmed, and drops its notice with the history", async () => {
      const fake = `bc1qw5${"q".repeat(32)}f3t4`;
      let history = "whole";
      serve({
        [`/app/address/${ME}/ledger`]: () => Response.json(keptLedger(history)),
        [`/address/${ME}`]: stats(part(150_000_000, 50_000_000, 1)),
        [`/address/${ME}/txs/chain`]: [tx(1, [[fake, 1000]], [[ME, 546]])],
        // One more waits, listed apart: the notice's count is of the confirmed list alone.
        [`/address/${ME}/txs/mempool`]: [tx(2, [[OTHER, 6000]], [[ME, 5000]])],
      });
      const el = open(`/address/${ME}`);
      await until(() => expect(el.querySelector(".address-poison")).not.toBeNull());
      expect(text(el.querySelector(".address-poison") as Element)).toContain(
        "The only confirmed transaction in the history names an address that starts and ends like this one.",
      );
      // The server drops the history: its rows go, and the notice that pointed at them with them.
      history = "dropped";
      heard({ state: "ledger", height: 900_001 });
      await until(() => expect(text(el)).toContain("and is getting it again"));
      expect(el.querySelector(".lookalike")).toBeNull();
      expect(el.querySelector(".address-poison")).toBeNull();
    });

    it("says truthfully why it lists only the newest transactions", async () => {
      for (const [history, again, says] of [
        ["taking", null, "is getting this address's whole history from its node"],
        ["none", null, "is getting this address's whole history from its node"],
        ["refused", null, "Its node declines to list this address's whole history"],
        ["dropped", null, "make room for addresses viewed more lately, and is getting it again"],
        [
          "dropped",
          1_767_300_000,
          "takes it again when this page is open after 1 Jan 2026, 20:40 UTC",
        ],
        ["too_large", null, "whole history is larger than this server keeps"],
      ] as const) {
        serve({
          [`/app/address/${ME}/ledger`]: keptLedger(history, again),
          [`/address/${ME}`]: stats(part(150_000_000, 50_000_000, 30)),
          [`/address/${ME}/txs/mempool`]: [],
        });
        const el = open(`/address/${ME}`);
        await until(() => expect(text(el)).toContain(says));
        expect(text(el)).toContain("newest 200 confirmed transactions");
        expect(calls.some((c) => c.includes("/txs/chain"))).toBe(false);
        for (const d of disposers.splice(0)) d();
        clearApiCache();
        calls = [];
        document.body.replaceChildren();
      }
    });
  });
});
