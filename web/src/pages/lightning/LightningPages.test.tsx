import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import { FakeSocket } from "../../lib/fakes";
import ChannelPage from "./ChannelPage";
import LightningPage from "./LightningPage";
import NodePage from "./NodePage";
import PenaltiesPage from "./PenaltiesPage";
import RankingsPage from "./RankingsPage";
import type { ChannelDetail, NodeDetail, Policy } from "./lightning";
import { LightningNav } from "./parts";
import SearchPage from "./SearchPage";
import { TxLightning } from "./TxLightning";
import {
  ACINQ,
  acinq,
  at,
  BFX,
  channel,
  CLOSING,
  closedChannel,
  closedOf,
  closeRecord,
  closeEvent,
  closes,
  EARLIER,
  feeEvent,
  FUNDING,
  LNFI,
  movers,
  NEXT,
  openEvent,
  opened,
  openChannel,
  overview,
  PENUMBRA,
  recordPeer,
  series,
  stats,
  SWEEP,
  synced,
  syncing,
  T0,
  tally,
  top,
} from "./testdata";

type Reply = () => Response;
let replies: Record<string, Reply>;
let requests: string[];

const json =
  (v: unknown, status = 200) =>
  () =>
    Response.json(v, { status });

beforeEach(() => {
  clearApiCache();
  requests = [];
  replies = { "/app/lightning/status": json(synced) };
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    const reply = replies[url.replace(/^\/(regtest|signet|testnet4|testnet5)/, "")];
    return reply ? reply() : Response.json({ error: "not found" }, { status: 404 });
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of disposers.splice(0)) d();
});

const disposers: (() => void)[] = [];

/** Renders the section's routes at `url`, so pages read their parameters as in the app. */
function open(url: string): HTMLElement {
  const pages = [
    { path: "/lightning/node/:key", component: NodePage },
    { path: "/lightning/channel/:id", component: ChannelPage },
  ];
  const Router = createRouter({
    routes: [{ path: ["/", "/signet", "/testnet4", "/testnet5", "/regtest"], children: pages }],
    history: memoryHistory(url),
  });
  const el = document.createElement("div");
  document.body.append(el);
  disposers.push(render(() => <Router>{(page) => page.children}</Router>, el));
  return el;
}

// Figures group digits with a narrow no-break space; the tests write a plain one.
const text = (el: HTMLElement) => (el.textContent ?? "").replaceAll("\u202F", " ");
const shows = async (el: HTMLElement, s: string) => vi.waitFor(() => expect(text(el)).toContain(s));
const links = (el: HTMLElement) => [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));

describe("the Lightning section's states", () => {
  it("says Lightning is switched off, and asks for nothing more", async () => {
    replies["/app/lightning/status"] = json({ state: "off" });
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    await shows(el, "Lightning is switched off on Regtest");
    expect(requests).toStrictEqual(["/regtest/app/lightning/status"]);
    expect(el.querySelector("[role=slider]")).toBeNull();
  });

  it("asks each network's own server: signet's status under /signet", async () => {
    replies["/app/lightning/status"] = json({ state: "off" });
    const el = mount(() => <LightningPage />, "/signet/lightning");
    await shows(el, "switched off on Signet");
    expect(requests).toStrictEqual(["/signet/app/lightning/status"]);
  });

  it("says Testnet 5 has no Lightning, not that it is switched off", async () => {
    replies["/app/lightning/status"] = json({ state: "off" });
    const el = mount(() => <LightningPage />, "/testnet5/lightning");
    await shows(el, "There is no Lightning on Testnet5 here");
    expect(text(el)).not.toContain("switched off");
  });

  it("shows how far a sync has come, then the pages once it is done, without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    replies["/app/lightning/status"] = json(syncing);
    replies["/app/lightning/overview"] = json(overview());
    replies["/app/lightning/statistics/1w"] = json(series());
    const el = mount(() => <LightningPage />, "/lightning");
    await shows(el, "Syncing the Lightning network");
    expect(text(el)).toContain("Channels checked26 704");
    expect(text(el)).toContain("Waiting to be checked5 000");
    expect(text(el)).toContain("Peers connected3 of 6");
    expect(requests).not.toContain("/app/lightning/overview");
    replies["/app/lightning/status"] = json(synced);
    await vi.advanceTimersByTimeAsync(5000);
    await shows(el, "The network now");
    expect(text(el)).not.toContain("Syncing");
  });

  it("says when a synced graph cannot be indexed yet, then shows the pages once it is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    replies["/app/lightning/status"] = json({ ...synced, state: "failed", synced: true });
    replies["/app/lightning/overview"] = json(overview());
    replies["/app/lightning/statistics/1w"] = json(series());
    const el = mount(() => <LightningPage />, "/lightning");
    await shows(el, "This server cannot show its Lightning graph yet");
    expect(text(el)).not.toContain("not running");
    replies["/app/lightning/status"] = json(synced);
    await vi.advanceTimersByTimeAsync(5000);
    await shows(el, "The network now");
  });

  it("says a failed peer is not running", async () => {
    replies["/app/lightning/status"] = json({ state: "failed" });
    const el = mount(() => <LightningPage />, "/lightning");
    await shows(el, "This server's Lightning peer is not running");
    expect(requests).not.toContain("/app/lightning/overview");
  });
});

describe("the overview", () => {
  beforeEach(() => {
    replies["/app/lightning/overview"] = json(
      overview({
        before: {
          "24h": { ...stats, channels: 36_200, capacity: 322_000_000_000 },
          "1w": null,
          "1m": null,
        },
      }),
    );
    replies["/app/lightning/statistics/1w"] = json(series());
    replies["/app/lightning/statistics/24h"] = json(series({ interval: "24h" }));
    replies["/app/lightning/movers?period=1w"] = json(movers());
    replies["/app/lightning/movers?period=24h"] = json(movers({ period: "24h" }));
    replies["/app/lightning/closes?days=30"] = json(closes());
    replies["/app/lightning/feed"] = json({ events: [] });
  });

  it("shows the network now, each total's change over the period, from the record's start where it is short", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning?interval=24h");
    await shows(el, "Channels36 228↑Up 28");
    expect(text(el)).toContain("Nodes13 639No change");
    expect(text(el)).toContain("↑Up 0.854\u00A0BTC");
    expect(text(el)).toContain("Median fee rate130 ppm");
    expect(text(el)).toContain("As of 12 Nov 2026, 18:30 UTC");
    expect(text(el)).not.toContain("when the record began");
    // A week back is before the record: changes run from its first point, and say so.
    const week = mount(() => <LightningPage />, "/regtest/lightning");
    await shows(week, "Changes since 12 Nov, when the record began.");
    expect(text(week)).toContain("Channels36 228No change");
    expect(text(week)).not.toContain("↑");
  });

  it("charts the figure pressed, keeping it across periods", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    await vi.waitFor(() => expect(el.querySelector("[role=slider] svg")).not.toBeNull());
    const fee = [...el.querySelectorAll<HTMLButtonElement>(".ln-ov-fig")].find((b) =>
      b.textContent?.startsWith("Median fee rate"),
    );
    fee?.click();
    flush();
    await shows(el, "Median fee rate, over time");
    expect(fee?.getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector("[role=slider]")?.getAttribute("aria-label")).toContain(
      "Lightning median fee rate",
    );
    const day = el.querySelector<HTMLAnchorElement>(".periods a[href*='24h']");
    expect(day?.getAttribute("href")).toBe("/regtest/lightning?interval=24h&figure=med_fee_rate");
  });

  it("shows each kind of event, with its channel, its ends and what moved", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    (await socket()).hello();
    await vi.waitFor(() =>
      expect(FakeSocket.last().sent).toContainEqual({
        op: "subscribe",
        topics: ["lightning-feed"],
      }),
    );
    recent([
      openEvent(1),
      closeEvent(2, "penalty"),
      closeEvent(3, "other"),
      feeEvent(1, 100, 250),
      feeEvent(2, 0, -200, true),
    ]);
    const feed = await feedOf(el);
    expect(text(feed)).toContain("Opened");
    expect(text(feed)).toContain("Penalty");
    expect(text(feed)).toContain("Other close");
    expect(text(feed)).toContain("100 ppm→to250 ppm");
    expect(text(feed)).toContain("Inboundnone→to−200 ppm");
    expect(links(feed)).toContain(`/regtest/lightning/channel/${openEvent(1).id}`);
    expect(links(feed)).toContain(`/regtest/lightning/node/${ACINQ}`);
    // No assertive live region: a reader is not read every row.
    expect(el.querySelector("[aria-live=assertive]")).toBeNull();
    expect(feed.querySelector("[aria-live]")).toBeNull();
  });

  it("puts a batch on top at once, says how many it left out, and drops a reconnect's repeats", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    (await socket()).hello();
    recent([openEvent(1), feeEvent(1)]);
    const feed = await feedOf(el);
    const first = feed.querySelector("li");
    FakeSocket.last().receive({
      topic: "lightning-feed",
      type: "events",
      more: 23,
      events: Array.from({ length: 40 }, (_, i) => feeEvent(10 + i)),
    });
    expect(feed.querySelectorAll("li")).toHaveLength(30);
    expect(text(feed)).toContain("and 34 more in this batch, not listed");
    expect(first?.isConnected).toBe(false);
    // The opens stay a filter away.
    click(el, "Opens");
    expect(feed.querySelectorAll("li")).toHaveLength(1);
    expect(text(feed)).toContain(openEvent(1).id);
    click(el, "All");
    // A reconnect: the snapshot again, one missed open in it.
    FakeSocket.last().drop();
    await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(1), { timeout: 3000 });
    (await socket()).hello();
    recent([openEvent(1), openEvent(2), feeEvent(1)]);
    click(el, "Opens");
    expect(feed.querySelectorAll("li")).toHaveLength(2);
  });

  it("holds arrivals while paused, saying how many wait, and shows them on resume", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    (await socket()).hello();
    recent([feeEvent(1)]);
    const feed = await feedOf(el);
    click(el, "Pause");
    events([openEvent(5), feeEvent(9)]);
    expect(feed.querySelectorAll("li")).toHaveLength(1);
    expect(text(el)).toContain("Paused, 2 waiting");
    click(el, "Resume");
    expect(feed.querySelectorAll("li")).toHaveLength(3);
    expect(text(el)).toContain("Live");
  });

  it("holds no more while paused than the list can show, the rest a line of its own", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    (await socket()).hello();
    recent([feeEvent(1)]);
    const feed = await feedOf(el);
    click(el, "Pause");
    for (let i = 0; i < 4; i++) events(Array.from({ length: 20 }, (_, k) => openEvent(i * 20 + k)));
    expect(text(el)).toContain("Paused, 80 waiting");
    click(el, "Resume");
    expect(feed.querySelectorAll("li")).toHaveLength(30);
    expect(text(feed)).toContain("and 51 more in this batch, not listed");
  });

  it("adds what the HTTP fallback finds after the list was there", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    (await socket()).hello();
    recent([feeEvent(1)]);
    await feedOf(el);
    FakeSocket.last().drop();
    replies["/app/lightning/feed"] = json({ events: [feeEvent(1), openEvent(3)] });
    await vi.advanceTimersByTimeAsync(30_000);
    await shows(el, openEvent(3).id);
    expect(requests).toContain("/regtest/app/lightning/feed");
  });

  it("starts paused under reduced motion", async () => {
    vi.spyOn(globalThis, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    await shows(el, "As it happens");
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Resume");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
  });

  // A one-second clock read while building a list once replaced its buttons every second.
  it("keeps a focused control in the feed through a tick and an arriving batch", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    (await socket()).hello();
    recent([openEvent(1), feeEvent(1)]);
    const feed = await feedOf(el);
    const link = feed.querySelector("a") as HTMLAnchorElement;
    link.focus();
    link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(3000);
    flush();
    events([feeEvent(7)]);
    expect(link.isConnected).toBe(true);
    expect(document.activeElement).toBe(link);
    // Focus in the list holds the batch until it leaves.
    expect(text(el)).toContain("Paused, 1 waiting");
  });

  it("asks over HTTP when the topic sends nothing, and says the feed is empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    (await socket()).hello();
    await vi.advanceTimersByTimeAsync(3100);
    await shows(el, "Nothing yet");
    expect(requests).toContain("/regtest/app/lightning/feed");
  });

  it("switches movers without a request, and lists the newest nodes and those that left", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    await shows(el, "Net change, the last week");
    const section = el.querySelector("[aria-labelledby=ln-movers-title]") as HTMLElement;
    expect(text(section)).toContain("+5.56 BTC");
    click(section, "Lost");
    await shows(section, "−9.00 BTC");
    click(section, "Channels");
    await shows(section, "−1 channels");
    click(section, "Either way");
    click(section, "Capacity");
    await vi.waitFor(() =>
      expect(rowsOf(section, "Nodes by capacity moved")).toStrictEqual([
        "Binance",
        "ACINQ",
        "bfx-lnd0",
      ]),
    );
    expect(requests.filter((r) => r.includes("/movers"))).toStrictEqual([
      "/regtest/app/lightning/movers?period=1w",
    ]);
    const lists = el.querySelector(".ln-lists") as HTMLElement;
    expect(text(lists)).toContain("penumbra");
    // A node gone from the graph is not linked to a page that would say so.
    expect(links(lists)).not.toContain(`/regtest/lightning/node/${LNFI}`);
    expect(links(lists)).toContain(`/regtest/lightning/node/${PENUMBRA}`);
  });

  it("says when a period moved nothing, and asks for a period's movers once", async () => {
    replies["/app/lightning/movers?period=24h"] = json(
      movers({
        period: "24h",
        capacity_up: [],
        capacity_down: [],
        channels_up: [],
        channels_down: [],
        new: [],
        left: [],
      }),
    );
    const el = mount(() => <LightningPage />, "/regtest/lightning?interval=24h");
    await shows(el, "No change in this period");
    expect(text(el)).toContain("None in this period");
  });

  it("draws closes from the first recorded day, a week at least, and gives the same days' figures", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    // The record began on the last of the 30 days: a week is drawn, its first six days unknown.
    const section = await vi.waitFor(() => {
      const s = el.querySelector("[aria-labelledby=ln-closes-title]") as HTMLElement;
      expect(s.querySelectorAll(".ln-bars__day")).toHaveLength(7);
      return s;
    });
    await shows(section, "Since 12 Nov: 9 cooperative, 1 force, 1 penalty, 0.270\u00A0BTC.");
    expect(section.querySelectorAll(".ln-bars__day--unknown")).toHaveLength(6);
    expect(text(section.querySelector(".ln-bars__ends") as HTMLElement)).toBe("6 Nov12 Nov");
    expect(text(section.querySelector(".ln-bars__readout") as HTMLElement)).toBe(
      "12 NovCooperative 3Force 1Penalty 0Other 00.0900\u00A0BTC",
    );
    expect(section.querySelector(".ln-bars")?.getAttribute("aria-hidden")).toBe("true");
    const details = section.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    flush();
    await vi.waitFor(() => expect(section.querySelectorAll("tbody tr")).toHaveLength(7));
    // The days before the record are unknown in the figures too, never "0".
    const rows = [...section.querySelectorAll("tbody tr")].map((r) => text(r as HTMLElement));
    expect(rows[0]).toBe("12 Nov 20263100");
    expect(rows[6]).toBe("6 Nov 2026––––");
  });
  it("keeps no node list of another period when the chosen one fails", async () => {
    replies["/app/lightning/movers?period=24h"] = json({ error: "still syncing" }, 404);
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    await shows(el, "penumbra");
    el.querySelector<HTMLAnchorElement>(".periods a[href*='24h']")?.click();
    flush();
    await shows(el, "Could not load the movers");
    const lists = el.querySelector(".ln-lists") as HTMLElement;
    expect(text(lists)).not.toContain("penumbra");
    expect(text(lists)).toContain("Not loaded.");
  });

  it("shows a section that could not load as such, and the rest of the page", async () => {
    replies["/app/lightning/movers?period=1w"] = json({ error: "still syncing" }, 404);
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    await shows(el, "Could not load the movers");
    await shows(el, "Channels36 228");
    await shows(el, "Closes by kind");
    expect(text(el)).toContain("Largest nodes");
  });

  it("says so when no snapshot is stored yet", async () => {
    replies["/app/lightning/overview"] = json(overview({ statistics: null }));
    replies["/app/lightning/statistics/1w"] = json(series({ first: null, points: [] }));
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    await shows(el, "No snapshot yet");
    await shows(el, "Nothing recorded yet");
    expect(el.querySelector("[role=slider]")).toBeNull();
  });

  it("draws the period's whole width, hatching before the first record", async () => {
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    await shows(el, "Recorded from 12 Nov");
    await vi.waitFor(() => expect(el.querySelector("[role=slider] svg")).not.toBeNull());
    expect(el.querySelector(".periods [aria-current=page]")?.textContent).toBe(
      "1 w: the last week",
    );
  });

  it("draws a missing ten minutes as a gap, never a line across it", async () => {
    replies["/app/lightning/statistics/24h"] = json(
      series({
        interval: "24h",
        first: T0 - 3600,
        from: T0 - 86_400,
        points: [-3600, -3000, -1200, -600].map((d) => at(T0 + d)),
      }),
    );
    const el = mount(() => <LightningPage />, "/regtest/lightning?interval=24h");
    await vi.waitFor(() => expect(el.querySelector("[role=slider] svg")).not.toBeNull());
    const line = el.querySelector("[role=slider] .chart__line")?.getAttribute("d") ?? "";
    expect(line.match(/M/g)).toHaveLength(2);
    expect(requests).toContain("/regtest/app/lightning/statistics/24h");
  });
});

/** The page's socket, once the status has let the page open it. */
const socket = () => vi.waitFor(() => FakeSocket.last());
const recent = (evs: unknown[]) =>
  FakeSocket.last().receive({ topic: "lightning-feed", type: "recent", events: evs });
const events = (evs: unknown[], more = 0) =>
  FakeSocket.last().receive({ topic: "lightning-feed", type: "events", events: evs, more });
const feedOf = (el: HTMLElement) =>
  vi.waitFor(() => {
    const f = el.querySelector(".ln-feed");
    expect(f).not.toBeNull();
    return f as HTMLElement;
  });
function click(el: HTMLElement, label: string) {
  const b = [...el.querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button ${label}`);
  b.click();
  flush();
}
const rowsOf = (el: HTMLElement, caption: string) => {
  const t = [...el.querySelectorAll("table")].find(
    (x) => x.caption?.textContent?.startsWith(caption) === true,
  );
  return [...(t?.querySelectorAll("tbody tr") ?? [])].map(
    (r) => r.querySelector("bdi")?.textContent,
  );
};

describe("a node", () => {
  const node = `/app/lightning/nodes/${ACINQ}`;
  const list = (q: string) => `${node}/channels?${q}`;
  const page = (n: number, id: string, more: Record<string, unknown> = {}) => ({
    ...acinq().open_channels,
    page: n,
    channels: [openChannel(0, { id })],
    ...more,
  });
  const press = (el: HTMLElement, label: string) => {
    const b = [...el.querySelectorAll<HTMLElement>("button, a")].find(
      (x) => x.textContent?.trim() === label,
    );
    if (!b) throw new Error(`no control named ${label}`);
    b.click();
    flush();
  };

  it("shows its name and key, its rank, the glance, what it announces and its first page", async () => {
    replies[node] = json(acinq());
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "3rd by capacity");
    expect(el.querySelector("h1")?.textContent).toBe("ACINQ");
    expect(text(el)).toContain("03864ef0…7a3f8f");
    expect(text(el)).toContain("1 807 open channels, 1st by channels");
    expect(text(el)).toContain("Channel size, median1 956 163 sats");
    expect(text(el)).toContain("First seen26 Feb 2019");
    expect(text(el)).toContain(`${ACINQ}@3.33.236.230:9735`);
    expect(text(el)).toContain("#49daaa");
    expect(text(el)).toContain("data-loss-protect (required)");
    // Addresses are text, never links.
    expect(links(el).some((h) => (h ?? "").includes("9735"))).toBe(false);
    // The first page and when its policies changed are the node's own answer: no list asked.
    expect(el.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(text(el)).toContain("Page 1 of 73");
    expect(text(el)).toContain("Policies updated");
    expect(requests.filter((r) => r.includes("/channels"))).toStrictEqual([]);
    // Each header that sorts says so; the one in force says how.
    expect(el.querySelector("th[aria-sort]")?.textContent).toContain("Capacity");
    expect(el.querySelector("th[aria-sort]")?.getAttribute("aria-sort")).toBe("descending");
  });

  it("asks the server for each sort, page and filter, and keeps the rows until they come", async () => {
    replies[node] = json(acinq());
    let answer: (r: Response) => void = () => undefined;
    replies[list("sort=out")] = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }) as unknown as Response;
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Page 1 of 73");
    const header = [...el.querySelectorAll("th button")].find((b) =>
      b.textContent?.startsWith("Fee out"),
    ) as HTMLElement;
    header.click();
    flush();
    await vi.waitFor(() => expect(requests).toContain(list("sort=out")));
    // Still the last rows, marked busy, until the answer comes.
    expect(el.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(el.querySelector(".ln-busy")?.getAttribute("aria-busy")).toBe("true");
    answer(Response.json(page(0, "900000x1x1", { sort: "out", dir: "asc" })));
    await shows(el, "900000x1x1");
    expect(el.querySelector("th[aria-sort]")?.getAttribute("aria-sort")).toBe("ascending");
    expect(el.querySelector(".ln-busy")?.getAttribute("aria-busy")).toBe("false");
    // Pressed again, the other way.
    replies[list("sort=out&dir=desc")] = json(page(0, "900001x1x1"));
    (
      [...el.querySelectorAll("th button")].find((b) =>
        b.textContent?.startsWith("Fee out"),
      ) as HTMLElement
    ).click();
    flush();
    await shows(el, "900001x1x1");
  });

  it("filters by state, peer and fee row, says what is in force, and pages", async () => {
    replies[node] = json(acinq());
    replies[list("state=here")] = json(page(0, "900002x1x1", { total: 42 }));
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Off here42");
    press(el, "Off here42");
    await shows(el, "42 of 1 807 open channels match");
    expect(text(el)).toContain("900002x1x1");

    replies[list(`peer=${BFX}`)] = json(page(0, "900003x1x1", { total: 10 }));
    const peer = el.querySelector<HTMLElement>(`a[href*="peer=${BFX}"]`);
    peer?.click();
    flush();
    await shows(el, "10 channels with bfx-lnd0");
    expect(text(el)).toContain("All peers");

    // A bar of the histogram is a row of rates: the server is asked for its run of buckets.
    replies[list("fee=out%3A10-40")] = json(page(0, "900004x1x1", { total: 3 }));
    const fees = open(`/lightning/node/${ACINQ}?fee=out:10`);
    await shows(fees, "It charges 10–49 ppm");
    await shows(fees, "900004x1x1");

    replies[list("page=1")] = json(page(1, "900005x1x1"));
    const later = open(`/lightning/node/${ACINQ}?page=2`);
    await shows(later, "900005x1x1");
    expect(text(later)).toContain("Page 2 of 73");
  });

  it("asks for the text filter once typing pauses", async () => {
    replies[node] = json(acinq());
    replies[list("q=bfx")] = json(page(0, "900006x1x1", { total: 10 }));
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Page 1 of 73");
    const field = el.querySelector<HTMLInputElement>("input[type=search]");
    if (!field) throw new Error("no filter");
    for (const v of ["b", "bf", "bfx"]) {
      field.value = v;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(requests.some((r) => r.includes("q="))).toBe(false);
    await shows(el, "900006x1x1");
    expect(requests.filter((r) => r.includes("q="))).toStrictEqual([list("q=bfx")]);
  });

  it("drops typing still waiting when the filter is cleared", async () => {
    replies[node] = json(acinq());
    replies[list("q=old")] = json(page(0, "900009x1x1", { total: 1 }));
    const el = open(`/lightning/node/${ACINQ}?q=old`);
    await shows(el, "900009x1x1");
    const field = el.querySelector<HTMLInputElement>("input[type=search]");
    if (!field) throw new Error("no filter");
    field.value = "newer";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    press(el, "Clear");
    await shows(el, "Page 1 of 73");
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    flush();
    expect(field.value).toBe("");
    expect(requests.some((r) => r.includes("q=newer"))).toBe(false);
  });

  it("never lets a slower earlier page replace a newer one", async () => {
    replies[node] = json(acinq());
    let slow: (r: Response) => void = () => undefined;
    replies[list("page=1")] = () =>
      new Promise<Response>((resolve) => {
        slow = resolve;
      }) as unknown as Response;
    replies[list("page=2")] = json(page(2, "900008x1x1"));
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Page 1 of 73");
    press(el, "Next");
    await vi.waitFor(() => expect(requests).toContain(list("page=1")));
    press(el, "Next");
    await shows(el, "900008x1x1");
    slow(Response.json(page(1, "900007x1x1")));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    flush();
    expect(text(el)).toContain("900008x1x1");
    expect(text(el)).not.toContain("900007x1x1");
  });

  it("says a page failed, rather than keep the last one under its number", async () => {
    replies[node] = json(acinq());
    replies[list("page=1")] = json({ error: "the node is not answering" }, 502);
    const el = open(`/lightning/node/${ACINQ}?page=2`);
    await shows(el, "Could not load these channels");
    expect(text(el)).toContain("Try again");
  });

  it("lists its closes by kind, with the channel a close continued as", async () => {
    replies[node] = json(
      acinq({ channels: { ...acinq().channels, closed: 2, force: 1, other: 1 } }),
    );
    const row = (id: string, kind: string, continued: string | null) => ({
      id,
      scid: "1",
      capacity: 400_000,
      state: "closed",
      peer: { id: BFX, alias: "bfx-lnd0", capacity: null, channels: null },
      fee_rate: null,
      funded: 1_657_986_467,
      closed: {
        block: { height: 975_867, hash: "00".repeat(32), time: 1_794_400_000 },
        txid: "a5".repeat(32),
        kind,
        fee: 304,
      },
      continued_as: continued,
    });
    replies[list("status=closed")] = json({
      status: "closed",
      page: 0,
      per_page: 25,
      total: 2,
      sort: "closed",
      dir: "desc",
      channels: [
        row("745253x717x0", "force", null),
        row("948730x2215x0", "other", "975402x1310x1"),
      ],
    });
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "Continued as 975402x1310x1");
    expect(text(el)).toContain("Force1");
    expect(text(el)).toContain("Other1");
    expect(links(el)).toContain("/lightning/channel/975402x1310x1");
    replies[list("status=closed&kind=force")] = json({
      status: "closed",
      page: 0,
      per_page: 25,
      total: 1,
      sort: "closed",
      dir: "desc",
      channels: [row("745253x717x0", "force", null)],
    });
    press(el, "Force1");
    await shows(el, "1 of 2 closes match");
  });

  it("shows a closing fee of 0 on a phone's card as 0 sats, not as missing", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("max-width"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    replies[node] = json(acinq({ channels: { ...acinq().channels, closed: 1, cooperative: 1 } }));
    const block = { height: 975_867, hash: "00".repeat(32), time: 1_794_400_000 };
    replies[list("status=closed")] = json({
      status: "closed",
      page: 0,
      per_page: 25,
      total: 1,
      sort: "closed",
      dir: "desc",
      channels: [
        {
          id: "745253x717x0",
          scid: "1",
          capacity: 400_000,
          state: "closed",
          peer: { id: BFX, alias: "bfx-lnd0", capacity: null, channels: null },
          fee_rate: null,
          funded: 1_657_986_467,
          closed: { block, txid: "a5".repeat(32), kind: "cooperative", fee: 0 },
          continued_as: null,
        },
      ],
    });
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await vi.waitFor(() => expect(el.querySelector(".ln-node-card__toggle")).not.toBeNull());
    el.querySelector<HTMLElement>(".ln-node-card__toggle")?.click();
    flush();
    await shows(el, "Closing fee0 sats");
  });

  it("shows a node that never announced itself", async () => {
    // What the server sends for a node it holds only through its channels (nodes.rs app_node).
    replies[node] = json(
      acinq({ alias: null, addresses: null, features: [], last_update: null, color: null }),
    );
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Unnamed node");
    expect(text(el)).toContain("It has sent no announcement");
    expect(text(el)).toContain("AddressesNone announced");
    expect(text(el)).toContain("No address announced");
  });

  it("shows a way with no policy as no figures, not as a node it cannot read", async () => {
    const none = { median: null, weighted: null, lowest: null, highest: null, policies: 0 };
    const a = acinq();
    replies[node] = json({
      ...a,
      figures: { ...a.figures, fee_rates: { ...a.figures.fee_rates, incoming: none } },
    });
    const el = open(`/lightning/node/${ACINQ}?view=fees`);
    await shows(el, "Median499–");
    expect(text(el)).not.toContain("its peers, by median");
  });

  it("shows its fees in figures, each bar a link to the channels it counts", async () => {
    replies[node] = json(acinq());
    const el = open(`/lightning/node/${ACINQ}?view=fees`);
    await shows(el, "Charges 5.0× its peers, by median");
    expect(text(el)).toContain("Average, by capacity1 5221 810");
    expect(links(el)).toContain(`/lightning/node/${ACINQ}?fee=out:2000`);
    expect(links(el)).toContain(`/lightning/node/${ACINQ}?fee=in:none`);
  });

  it("lists its recent fee changes only in the Fees view, naming a fee that moved when the rate held", async () => {
    replies[node] = json(acinq());
    const fees = (fee_rate: number, base_fee_msat = 0) => ({
      fee_rate,
      base_fee_msat,
      inbound_fee: null,
    });
    const change = (id: string, whose: string, before: unknown, after: unknown) => ({
      id,
      scid: "1",
      peer: { id: BFX, alias: "bfx-lnd0" },
      whose,
      time: Math.floor(Date.now() / 1000) - 3600,
      before,
      after,
    });
    replies[`${node}/fees`] = json({
      changes: [
        change("913755x2933x0", "peer", fees(1000), fees(50)),
        change("913755x2933x1", "own", fees(500, 1000), fees(500, 2000)),
        // An inbound fee from none to zero, which the server keeps: it charges the same.
        change("913755x2933x2", "own", fees(500), {
          ...fees(500),
          inbound_fee: { base_fee_msat: 0, fee_rate: 0 },
        }),
      ],
    });
    const plain = open(`/lightning/node/${ACINQ}`);
    await shows(plain, "3rd by capacity");
    expect(requests.some((r) => r.endsWith("/fees"))).toBe(false);
    const el = open(`/lightning/node/${ACINQ}?view=fees`);
    await shows(el, "Recent fee changes");
    await shows(el, "The peer1 00050");
    expect(text(el)).toContain("This node, base fee1 sat2 sats");
    expect(text(el)).not.toContain("500500");
    expect(links(el)).toContain("/lightning/channel/913755x2933x0#fee-history");
    expect(text(el)).not.toContain("913755x2933x2");
    replies[`${node}/fees`] = json({ changes: [] });
    clearApiCache();
    const none = open(`/lightning/node/${ACINQ}?view=fees`);
    await shows(none, "No change kept");
  });

  it("puts an inbound fee under the fee it belongs to, a discount or a surcharge by its sign", async () => {
    const a = acinq();
    const own = a.open_channels.channels[0]?.own_policy;
    const inbound = (fee_rate: number) => ({ base_fee_msat: 0, fee_rate });
    replies[node] = json({
      ...a,
      open_channels: {
        ...a.open_channels,
        channels: [
          openChannel(0, { own_policy: { ...own, inbound_fee: inbound(-200) } as Policy }),
          openChannel(1, { peer_policy: { ...own, inbound_fee: inbound(150) } as Policy }),
          openChannel(2, { own_policy: { ...own, inbound_fee: inbound(0) } as Policy }),
        ],
      },
    });
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "discount −200 ppm");
    expect(text(el)).toContain("surcharge +150 ppm");
    expect(text(el)).not.toContain("discount +");
    expect(el.querySelectorAll(".ln-node-fee__in")).toHaveLength(2);
  });

  it("gives the week's change only once its record is a week old", async () => {
    replies[node] = json(acinq());
    const now = Math.floor(Date.now() / 1000);
    replies[`${node}/history`] = json({
      from: now - 30 * 86_400,
      points: [
        { time: now - 8 * 86_400, channels: 1797, capacity: 27_000_000_000 },
        { time: now - 86_400, channels: 1800, capacity: 27_383_219_285 },
      ],
    });
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Changes over 7 days");
    expect(text(el)).toContain("1 698 enabled↑ Up 10 (0.6%)");
    replies[`${node}/history`] = json({
      from: now - 3 * 86_400,
      points: [{ time: now - 86_400, channels: 1800, capacity: 1 }],
    });
    clearApiCache();
    const young = open(`/lightning/node/${ACINQ}`);
    await shows(young, "1 698 enabled");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(text(young)).not.toContain("Changes over 7 days");
    expect(text(young)).not.toContain("↑");
  });

  it("draws its past in the History view, and says when there is none yet", async () => {
    replies[node] = json(acinq());
    replies[`${node}/history`] = json({
      from: 1_794_504_600,
      points: [
        { time: 1_794_528_000, channels: 1804, capacity: 27_651_420_454 },
        { time: 1_794_593_410, channels: 1793, capacity: 28_497_516_531 },
      ],
    });
    const el = open(`/lightning/node/${ACINQ}?view=history`);
    await shows(el, "Recorded since 12 Nov 2026, 17:30 UTC");
    await vi.waitFor(() => expect(el.querySelector("[role=slider] svg")).not.toBeNull());
    replies[`${node}/history`] = json({
      from: null,
      points: [{ time: 1_794_593_410, channels: 1793, capacity: 28_497_516_531 }],
    });
    clearApiCache();
    const none = open(`/lightning/node/${ACINQ}?view=history`);
    await shows(none, "Nothing to draw yet");
    replies[`${node}/history`] = json({ error: "store is busy" }, 500);
    clearApiCache();
    const failed = open(`/lightning/node/${ACINQ}?view=history`);
    await shows(failed, "Could not load its history");
    expect(text(failed)).toContain("1 807 open channels");
  });

  it("says when this server knows no such node, or the key is not one", async () => {
    const el = open(`/lightning/node/${"02".padEnd(66, "0")}`);
    await shows(el, "This server knows no such node");
    const bad = open("/lightning/node/not-a-key");
    await shows(bad, "Not a node's public key");
    expect(requests.filter((r) => r.includes("not-a-key"))).toStrictEqual([]);
  });
});

describe("a node's close record", () => {
  const node = `/app/lightning/nodes/${ACINQ}`;
  const record = `${node}/closes`;
  const emptyList = json({
    status: "closed",
    page: 0,
    per_page: 25,
    total: 0,
    sort: "closed",
    dir: "desc",
    channels: [],
  });
  const section = (el: HTMLElement) =>
    el.querySelector<HTMLElement>("[aria-labelledby=ln-record-title]");
  const sectionText = (el: HTMLElement) => text(section(el) ?? el);

  /** The closed list's first page, `total` closes in all. */
  const closedList = (total: number) =>
    json({
      status: "closed",
      page: 0,
      per_page: 25,
      total,
      sort: "closed",
      dir: "desc",
      channels: [],
    });
  const closedCounts = (c: Partial<NodeDetail["channels"]>) =>
    acinq({
      channels: {
        open: 1807,
        active: 1729,
        closed: 0,
        cooperative: 0,
        force: 0,
        penalty: 0,
        other: 0,
        ...c,
      },
    });

  it("shows how its channels ended beside every channel's, its fees, its weeks and its peers", async () => {
    // The node's answer and its record agree, as they do once the index has caught up.
    replies[node] = json(closedCounts({ closed: 79, cooperative: 54, force: 25 }));
    replies[`${node}/channels?status=closed`] = closedList(79);
    replies[record] = json(
      closeRecord(
        tally({ cooperative: 54, force: 25, penalty: 0, other: 0 }, [
          { cooperative: 20, force: 20, penalty: 0, other: 0 },
          { cooperative: 34, force: 5, penalty: 0, other: 0 },
        ]),
        // The peers' force closes add up to the node's: every one was with a peer.
        [recordPeer(1, { force: 24, closed: 26, open: 1 }), recordPeer(2)],
      ),
    );
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "Week by week");
    const t = sectionText(el);
    // The node's span, and as of when every channel's figures were worked out: not one span.
    expect(t).toContain("Since 12 Nov 2026; all channels as of 20 Nov 2026, 22:33 UTC");
    expect(t).not.toContain("same span");
    expect(t).toContain("79 channels closed in the 8 days this server has watched");
    // The count is the way past the record to the list it sums up.
    expect(section(el)?.querySelector(".ln-record__lead a")?.getAttribute("href")).toBe(
      "#ln-node-closed-title",
    );
    // The record is asked for once: a request made inside a JSX prop was made on every read of
    // it, without end, and took a browser past 20 GB. A press renders the record again first.
    (
      [...(section(el)?.querySelectorAll("button") ?? [])].find((b) =>
        b.textContent.startsWith("Show the peer with one"),
      ) as HTMLButtonElement
    ).click();
    await shows(el, "Show fewer peers");
    expect(requests.filter((r) => r.endsWith(`${ACINQ}/closes`))).toHaveLength(1);
    // The count leads to the list below: an in-page link the router leaves alone, so it is not
    // announced as the current page.
    const toList = section(el)?.querySelector(".ln-record__lead a");
    expect(toList?.getAttribute("rel")).toBe("external");
    expect(toList?.hasAttribute("aria-current")).toBe(false);
    expect(el.querySelector("#ln-node-closed-title")).not.toBeNull();
    // That a force close is in both nodes' records is said once, under the first force figure.
    expect(t.split("in both nodes' records")).toHaveLength(2);
    expect(t).toContain("68%all 91%");
    expect(t).toContain("32%all 8.8%");
    // Other: none here, some among every channel, so its row is there: one line, every channel's
    // figure alone, with no words and no bar that would read as the node's.
    expect(t).toContain("Other0all 0.3%");
    const other = [...(section(el)?.querySelectorAll("tbody tr") ?? [])].find((row) =>
      row.textContent.startsWith("Other"),
    );
    expect(other?.querySelector(".ln-record__gloss")).toBeNull();
    expect(other?.querySelector(".ln-record__bar")).toBeNull();
    expect(t).toContain("the chain does not say which end broadcast it");
    // Fees: in all, a close's mean, and every channel's mean.
    // Spoken as two figures, never as one number: the visible pair is hidden from screen readers.
    expect(t).toContain("25 000 sats in all. 1 000 sats a close.");
    const fee = section(el)?.querySelector(".ln-record__fee");
    expect(fee?.querySelectorAll("[aria-hidden='true']")).toHaveLength(2);
    // "a close" stays together under its figure.
    expect(fee?.textContent).toContain("a\u00A0close");
    // The second week is past every channel's figures: none, not a zero, said in words to a
    // screen reader and in a note under the table.
    expect(t).toContain("345–No figure for this week yet");
    // Its second line, where a phone has no room for the column, is a sentence of its own, read
    // the same on screen and aloud, not a dash spliced into a phrase.
    const seconds = [
      ...(section(el)?.querySelectorAll(".ln-record__weeks .ln-record__second") ?? []),
    ];
    expect(seconds.map((e) => e.textContent)).toContain("No figure for all channels yet");
    expect(t).toContain(
      "A dash: every channel's figures, worked out every ten minutes, do not reach that week yet.",
    );
    // Not capped: every close with a peer is in the record.
    expect(t).toContain("All closesCloseswith it");
    // Peers with more than one force close are listed; the one with one is a press away.
    expect(t).toContain("peer 1");
    expect(t).not.toContain("peer 2");
    expect(t).toContain("Show the peer with one");
    expect(t).toContain(
      "The 25 force closes were on channels with 2 different peers, at most 24 with any one.",
    );
    expect(links(el)).toContain(`/lightning/node/${ACINQ}?view=closed&peer=${recordPeer(1).id}`);
    // No verdict in colour: every kind in the record is in the muted tone.
    const tags = [...(section(el)?.querySelectorAll(".ln-tag") ?? [])];
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag.classList.contains("ln-tag--muted"))).toBe(true);
    // The glance counts its closes, and gives no share of its own.
    expect(text(el)).not.toContain("forced");
  });

  it("lists a close the record holds before the node's answer has it, and its link leads there", async () => {
    // The node's answer is from the index, up to 30 s old; the record reads the store now.
    replies[node] = json(acinq());
    replies[`${node}/channels?status=closed`] = closedList(1);
    replies[record] = json(closeRecord(tally({ cooperative: 1, force: 0, penalty: 0, other: 0 })));
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "1 channel closed");
    await shows(el, "Closed channels");
    expect(requests).toContain(`${node}/channels?status=closed`);
    expect(el.querySelector("#ln-node-closed-title")).not.toBeNull();
    await shows(el, "1 close");
  });

  it("says a node's closes failed to load, with Try again, and never that there is no such node", async () => {
    replies[node] = json({ error: "node not found" }, 404);
    replies[record] = json({ error: "upstream unavailable" }, 502);
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Could not load this node");
    expect(text(el)).not.toContain("This server knows no such node");
    replies[record] = json(closeRecord(tally({ cooperative: 2, force: 0, penalty: 0, other: 0 })));
    replies[`${node}/channels?status=closed`] = closedList(2);
    (
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Try again",
      ) as HTMLButtonElement
    ).click();
    await shows(el, "2 channels closed");
  });

  it("takes a departed node's list totals from the list, not from a record of its newest closes", async () => {
    replies[node] = json({ error: "node not found" }, 404);
    const r = closeRecord(tally({ cooperative: 10_000, force: 0, penalty: 0, other: 0 }));
    replies[record] = json({ ...r, capped: true });
    replies[`${node}/channels?status=closed`] = closedList(12_000);
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "12 000 closes");
    const list = el.querySelector<HTMLElement>("[aria-labelledby=ln-node-closed-title]");
    const chips = text(list?.querySelector(".ln-node-chips") ?? el);
    expect(chips).toContain("All 12 000");
    // A kind may be among the closes the record did not read: every kind can be chosen.
    for (const k of ["Cooperative", "Force", "Penalty", "Other"]) expect(chips).toContain(k);
    expect(chips).not.toContain("10 000");
  });

  it("never gives a capped record's count as the list's total, on a filtered load either", async () => {
    replies[node] = json({ error: "node not found" }, 404);
    const r = closeRecord(tally({ cooperative: 10_000, force: 0, penalty: 0, other: 0 }));
    replies[record] = json({ ...r, capped: true });
    // Opened on a filter: the unfiltered list is never asked for.
    replies[`${node}/channels?status=closed&kind=cooperative`] = closedList(11_000);
    const el = open(`/lightning/node/${ACINQ}?view=closed&kind=cooperative`);
    await shows(el, "11 000 closes match");
    const list = el.querySelector<HTMLElement>("[aria-labelledby=ln-node-closed-title]");
    expect(text(list ?? el)).not.toContain("10 000");
    // Not known: the "All" chip has no count.
    const all = [...(list?.querySelectorAll(".ln-node-chip") ?? [])][0];
    expect(text(all as HTMLElement)).toBe("All");
  });

  it("lists a held node's closes when its answer says none but a capped record has some", async () => {
    replies[node] = json(acinq());
    const r = closeRecord(tally({ cooperative: 10_000, force: 0, penalty: 0, other: 0 }));
    replies[record] = json({ ...r, capped: true });
    replies[`${node}/channels?status=closed&kind=cooperative`] = closedList(11_000);
    const el = open(`/lightning/node/${ACINQ}?view=closed&kind=cooperative`);
    await shows(el, "11 000 closes match");
    expect(text(el)).not.toContain("No close seen");
  });

  it("gives a peer's force closes and penalties together, and every channel's count as a count", async () => {
    replies[node] = json(closedCounts({ closed: 40, cooperative: 20, penalty: 20 }));
    replies[`${node}/channels?status=closed`] = closedList(40);
    const peer = recordPeer(1, {
      force: 0,
      penalty: 20,
      closed: 20,
      shares: { cooperative: 0, force: 0, penalty: 100, other: 0 },
    });
    // Every channel's closes under the minimum: counts, beside this node's shares.
    replies[record] = json(
      closeRecord(
        tally({ cooperative: 20, force: 0, penalty: 20, other: 0 }),
        [peer],
        tally({ cooperative: 14, force: 5, penalty: 0, other: 0 }),
      ),
    );
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "With whom");
    const t = sectionText(el);
    expect(t).toContain("100% force or penalty");
    expect(t).not.toMatch(/\D0% force/);
    expect(t).toContain("all 14 closes");
    expect(t).toContain("all 5 closes");
  });

  it("gives the list's own count once it answers, though the record read one close fewer", async () => {
    // Another channel closed between the record's read and the list's.
    replies[node] = json(closedCounts({ closed: 5, cooperative: 5 }));
    replies[record] = json(closeRecord(tally({ cooperative: 5, force: 0, penalty: 0, other: 0 })));
    replies[`${node}/channels?status=closed`] = closedList(6);
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    const list = () => el.querySelector<HTMLElement>("[aria-labelledby=ln-node-closed-title]");
    await vi.waitFor(() => expect(text(list() ?? el)).toContain("All 6"));
    const line = () => text(list()?.querySelector(".ln-node-total") ?? el);
    await vi.waitFor(() => expect(line()).toBe("6 closes"));
  });

  it("never takes the graph's count as the whole beside a capped record", async () => {
    // The graph's answer says 10 000; the store has one more; the record holds its newest 10 000.
    replies[node] = json(closedCounts({ closed: 10_000, cooperative: 10_000 }));
    const r = closeRecord(tally({ cooperative: 10_000, force: 0, penalty: 0, other: 0 }));
    replies[record] = json({ ...r, capped: true });
    replies[`${node}/channels?status=closed&kind=cooperative`] = closedList(10_001);
    const el = open(`/lightning/node/${ACINQ}?view=closed&kind=cooperative`);
    await shows(el, "10 001 closes match");
    const list = el.querySelector<HTMLElement>("[aria-labelledby=ln-node-closed-title]");
    expect(text(list ?? el)).not.toContain("10 000");
  });

  it("says no total while the whole list is on its way after a filter is cleared", async () => {
    replies[node] = json({ error: "node not found" }, 404);
    const r = closeRecord(tally({ cooperative: 10_000, force: 0, penalty: 0, other: 0 }));
    replies[record] = json({ ...r, capped: true });
    replies[`${node}/channels?status=closed&kind=cooperative`] = closedList(3_200);
    // The whole list's answer is held until the test lets it go.
    let release = () => {};
    replies[`${node}/channels?status=closed`] = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(closedList(12_000)());
      }) as unknown as Response;
    const el = open(`/lightning/node/${ACINQ}?view=closed&kind=cooperative`);
    await shows(el, "3 200 closes match");
    const list = () => el.querySelector<HTMLElement>("[aria-labelledby=ln-node-closed-title]");
    const all = [...(list()?.querySelectorAll<HTMLAnchorElement>(".ln-node-chip") ?? [])][0];
    all?.click();
    await vi.waitFor(() => expect(requests).toContain(`${node}/channels?status=closed`));
    // Pending: the filtered count is not the whole list's.
    expect(text(list() ?? el)).not.toContain("3 200 closes");
    release();
    await shows(el, "12 000 closes");
  });

  it("works a peer's share out from its counts, not by adding two rounded shares", async () => {
    replies[node] = json(closedCounts({ closed: 21, cooperative: 19, force: 1, penalty: 1 }));
    replies[`${node}/channels?status=closed`] = closedList(21);
    // 2 of 21 is 9.5%; the server's 4.8% and 4.8% added would say 9.6%.
    const peer = recordPeer(1, {
      cooperative: 19,
      force: 1,
      penalty: 1,
      closed: 21,
      shares: { cooperative: 90.5, force: 4.8, penalty: 4.8, other: 0 },
    });
    replies[record] = json(
      closeRecord(tally({ cooperative: 19, force: 1, penalty: 1, other: 0 }), [peer]),
    );
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "With whom");
    expect(sectionText(el)).toContain("9.5% force or penalty");
    expect(sectionText(el)).not.toContain("9.6%");
  });

  it("rounds every channel's weekly share as the server rounds, from tenths of a percent", async () => {
    replies[node] = json(closedCounts({ closed: 25, cooperative: 25 }));
    replies[`${node}/channels?status=closed`] = closedList(25);
    // 199 of 2 000 is 9.95%: the server's 10%, not the 9.9% a float's toFixed gives.
    const week = { cooperative: 1_801, force: 199, penalty: 0, other: 0 };
    replies[record] = json(
      closeRecord(
        tally({ cooperative: 25, force: 0, penalty: 0, other: 0 }),
        [],
        tally(week, [week]),
      ),
    );
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "Week by week");
    const weeks = text(section(el)?.querySelector(".ln-record__weeks") ?? el);
    expect(weeks).toContain("10%");
    expect(weeks).not.toContain("9.9%");
  });

  it("rounds a peer's share as the server rounds the record's, from tenths of a percent", async () => {
    replies[node] = json(closedCounts({ closed: 2_000, cooperative: 1_977, force: 23 }));
    replies[`${node}/channels?status=closed`] = closedList(2_000);
    // 23 of 2 000 is 1.15%: the server's 1.2%, not the 1.1% a float's toFixed gives.
    const peer = recordPeer(1, {
      cooperative: 1_977,
      force: 23,
      closed: 2_000,
      shares: { cooperative: 98.9, force: 1.2, penalty: 0, other: 0 },
    });
    replies[record] = json(
      closeRecord(tally({ cooperative: 1_977, force: 23, penalty: 0, other: 0 }), [peer]),
    );
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "With whom");
    expect(sectionText(el)).toContain("1.2% force or penalty");
  });

  it("gives counts and no share below the minimum, and names a penalty without saying by whom", async () => {
    replies[node] = json(acinq());
    replies[`${node}/channels?status=closed`] = emptyList;
    replies[record] = json(
      closeRecord(tally({ cooperative: 1, force: 1, penalty: 1, other: 0 }), [
        recordPeer(1, { force: 0, penalty: 1 }),
        recordPeer(2),
      ]),
    );
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "With whom");
    const t = sectionText(el);
    expect(t).toContain("Shares are given from 20 closes; with 3, the counts say more");
    expect(t).not.toMatch(/\d%all/);
    expect(t).toContain("Penalty");
    expect(t).toContain("the record does not say by which end");
    expect(t).toContain("The 1 force close and 1 penalty were on channels with 2 different peers");
    // The peers' table has a penalty column only when a peer has one.
    expect([...(section(el)?.querySelectorAll("th") ?? [])].map((h) => h.textContent)).toContain(
      "Penalty",
    );
  });

  it("says when every channel's figures are not worked out yet, and when the node has none", async () => {
    replies[node] = json(acinq());
    replies[`${node}/channels?status=closed`] = emptyList;
    replies[record] = json(
      closeRecord(tally({ cooperative: 0, force: 0, penalty: 0, other: 0 }, []), [], null),
    );
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "None of its channels closed in the 8 days this server has watched.");
    expect(section(el)?.querySelector("table")).toBeNull();
    // No list, so no link to one.
    expect(section(el)?.querySelector(".ln-record__lead a")).toBeNull();
    // Said once: no empty closed list under the record saying it again.
    expect(text(el)).not.toContain("Closed channels");
  });

  it("heads every channel's counts as counts, and gives a kind with no fee one dash", async () => {
    replies[node] = json(acinq());
    replies[`${node}/channels?status=closed`] = emptyList;
    // As on signet: one close here, and too few among every channel for a share either.
    replies[record] = json(
      closeRecord(
        tally({ cooperative: 1, force: 0, penalty: 0, other: 0 }),
        [],
        tally({ cooperative: 14, force: 0, penalty: 0, other: 0 }),
      ),
    );
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "With whom");
    const t = sectionText(el);
    expect(t).toContain("All channels: 14 cooperative, 0 force.");
    expect(t).toContain("All channelscloses");
    expect(t).not.toContain("All channelsshare");
    // No force close: one dash for its fee, not a dash over "– a close"; no caveat about it.
    const fees = [...(section(el)?.querySelectorAll("table") ?? [])][1];
    const force = [...(fees?.querySelectorAll("tbody tr") ?? [])][1];
    expect(force?.querySelectorAll("td")[1]?.textContent).toBe("–");
    expect(t).not.toContain("– a");
    expect(t).not.toContain("in the record of both");
  });

  it("shows its own error, and the rest of the page still works", async () => {
    replies[node] = json(acinq());
    replies[`${node}/channels?status=closed`] = emptyList;
    replies[record] = json({ error: "upstream unavailable" }, 502);
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "Could not load its close record");
    expect(text(el)).toContain("At a glance");
  });

  it("says when the record holds only the node's newest closes, and how many more peers there are", async () => {
    replies[node] = json(acinq());
    replies[`${node}/channels?status=closed`] = emptyList;
    const r = closeRecord(tally({ cooperative: 9_000, force: 1_000, penalty: 0, other: 0 }), [
      recordPeer(1),
    ]);
    replies[record] = json({ ...r, capped: true, peers: { ...r.peers, forced: 52, more: 51 } });
    const el = open(`/lightning/node/${ACINQ}?view=closed`);
    await shows(el, "its newest closes, the most this record reads. It has older ones too.");
    const t = sectionText(el);
    expect(t).toContain("10 000 channels closed");
    // Capped: a peer's counts are of the closes in this record, not all with it.
    expect(t).toContain("ClosesClosesin this record");
    expect(t).not.toContain("All closes");
    expect(t).toContain(
      "These count the closes in this record, its newest; a peer may have older ones with it too.",
    );
    // How many more, never "fewer": they may tie the last shown.
    expect(t).toContain("And 51 more peers with a force close or a penalty.");
    expect(t).not.toContain("fewer");
  });

  it("shows a node that left the graph by its record, and nothing more for one never seen", async () => {
    replies[node] = json({ error: "node not found" }, 404);
    const gone = closeRecord(tally({ cooperative: 9, force: 3, penalty: 0, other: 0 }), [
      recordPeer(1),
      recordPeer(2, { held: false }),
    ]);
    replies[record] = json({ ...gone, peers: { ...gone.peers, forced: 53, more: 51 } });
    // Its closed list answers from the store, as for any node.
    replies[`${node}/channels?status=closed`] = emptyList;
    const el = open(`/lightning/node/${ACINQ}`);
    // Headed by its key, and said to have no open channel: not "no such node" over its record.
    await shows(el, "12 channels closed");
    expect(text(el)).not.toContain("This server knows no such node");
    expect(text(el.querySelector("h1") as HTMLElement)).toBe("03864ef0…7a3f8f");
    expect(text(el)).toContain("It has no open channel now");
    // Too few for a share: the record in a line, beside every channel's, the tables a press away.
    expect(sectionText(el)).toContain("9 cooperative2 700 sats in fees3 force3 000 sats in fees");
    expect(sectionText(el)).toContain("All channels: 91% cooperative, 8.8% force, 0.3% other.");
    expect(
      section(el)?.querySelector("details.ln-record__breakdown:not([open]) table"),
    ).not.toBeNull();
    // Every peer has one force close: the sentence, and the list a press away.
    expect(sectionText(el)).toContain("Show the 2 peers");
    (
      [...(section(el)?.querySelectorAll("button") ?? [])].find((b) =>
        b.textContent.startsWith("Show the 2 peers"),
      ) as HTMLButtonElement
    ).click();
    // Folded back, none would show: the button says it hides them all.
    await shows(el, "Hide the 2 peers");
    // Its closed list is under the record, as the heading promises, and its peers filter it, as
    // a held node's do, whether or not the graph still holds the peer.
    expect(text(el)).toContain("Closed channels");
    expect(requests).toContain(`${node}/channels?status=closed`);
    expect(links(el)).toContain(`/lightning/node/${ACINQ}?view=closed&peer=${recordPeer(1).id}`);
    expect(links(el)).toContain(`/lightning/node/${ACINQ}?view=closed&peer=${recordPeer(2).id}`);
    expect(sectionText(el)).toContain("And 51 more peers with a force close or a penalty.");
    expect(sectionText(el)).toContain("Filter its closed channels below by peer to see them.");
    replies[record] = json({ error: "node not found" }, 404);
    clearApiCache();
    const other = open(`/lightning/node/${BFX}`);
    await shows(other, "This server knows no such node");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(section(other)).toBeNull();
  });
});

describe("a channel", () => {
  const show = (c: ChannelDetail) => {
    replies[`/app/lightning/channels/${c.id}`] = json(c);
    return open(`/lightning/channel/${c.id}`);
  };
  const section = (el: HTMLElement, title: string) =>
    [...el.querySelectorAll("section")].find((x) => x.querySelector("h2")?.textContent === title);
  const titles = (el: HTMLElement) => [...el.querySelectorAll("h2")].map((h) => h.textContent);
  const steps = (el: HTMLElement) =>
    [...el.querySelectorAll(".ln-step__title strong")].map((x) => x.textContent);

  it("shows an open channel: who charges what, the fee for a hop, the policies and its life", async () => {
    const el = show(channel());
    await shows(el, "Who charges what");
    expect(titles(el)).toStrictEqual([
      "Who charges what",
      "Fee for this hop",
      "Policies side by side",
      "Fee rate over time",
      "Life of the channel",
    ]);
    expect(text(el.querySelector("h1") as HTMLElement)).toBe("Channel 811984x2037x0");
    expect(text(el)).toContain("Enabled");
    expect(text(el)).toContain("500 000 000 sats");
    expect(text(el)).toContain("892785849701564416");
    expect(text(el)).toContain("811984:2037:0");
    const lanes = text(section(el, "Who charges what") as HTMLElement);
    expect(lanes).toContain("bfx-lnd0 charges to forward towards ACINQ1 ppm + 1 sat");
    expect(lanes).toContain("ACINQ charges to forward towards bfx-lnd02 499 ppm + 1 sat");
    expect(lanes).toContain("CLTV 144, max HTLC 20 000 000 sats");
    // 100 000 sats by default: 1 sat + 0.1, and 1 sat + 249.9.
    const hop = text(section(el, "Fee for this hop") as HTMLElement);
    expect(hop).toContain("bfx-lnd0 → ACINQ1.1 sats");
    expect(hop).toContain("ACINQ → bfx-lnd0250.9 sats");
    const terms = text(section(el, "Policies side by side") as HTMLElement);
    expect(terms).toContain("ACINQ +2 498 ppm");
    expect(terms).toContain("bfx-lnd0 +999 msat");
    expect(steps(el)).toStrictEqual(["Funded", "Open now"]);
    expect(links(el)).toContain(`/tx/${FUNDING}`);
    expect(links(el)).toContain(`/lightning/node/${BFX}`);
    expect(text(el)).not.toContain("How it ended");
  });

  it("works out the fee for the amount typed, and says why it cannot", async () => {
    const el = show(channel({ node_two: { ...channel().node_two, policy: null } }));
    await shows(el, "Fee for this hop");
    const hop = section(el, "Fee for this hop") as HTMLElement;
    const input = hop.querySelector("input") as HTMLInputElement;
    const type = (v: string) => {
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // Each new result is said while focus stays in the field.
    expect(hop.querySelector(".ln-hop__ways")?.getAttribute("aria-live")).toBe("polite");
    // A missing policy is not a disabled one.
    expect(text(hop)).toContain("ACINQ → bfx-lnd0No policy");
    expect(text(hop)).not.toContain("Disabled");
    expect(text(el)).toContain("Enabled one way");
    type("1 234 567");
    await shows(hop, "1 sat + 1 234 567 × 1 ÷ 1 000 000, rounded down");
    expect(text(hop)).toContain("2.234 sats");
    type("30 000 000");
    // A long figure carries its magnitude for the narrowest room, hidden by CSS elsewhere.
    await shows(hop, "Over max HTLC (20 000 000 sats0.200 BTC)");
    expect(hop.querySelector(".ln-fig--long .ln-fig__short")?.textContent).toBe("0.200 BTC");
    expect(text(hop)).toContain("Would be 31 sats");
    type("1.5");
    await shows(hop, "Whole sats only.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("calls a disabled end disabled, and a channel with no policy at all says so", async () => {
    const off = { ...channel().node_two.policy, enabled: false } as Policy;
    const el = show(channel({ node_two: { ...channel().node_two, policy: off } }));
    await shows(el, "Fee for this hop");
    expect(text(section(el, "Fee for this hop") as HTMLElement)).toContain(
      "ACINQ → bfx-lnd0Disabled",
    );
    expect(text(section(el, "Policies side by side") as HTMLElement)).toContain("One way only");
    const none = show(
      channel({
        id: "811984x2037x9",
        node_one: { ...channel().node_one, policy: null },
        node_two: { ...channel().node_two, policy: null },
      }),
    );
    await shows(none, "Who charges what");
    expect(text(none.querySelector(".ln-chan__title") as HTMLElement)).toContain("No policy");
    // Nothing to chart: its fee history is not asked for.
    expect(requests.some((r) => r.includes("811984x2037x9/fees"))).toBe(false);
    // Nothing to work out or compare: the lanes say "No policy" each way, and that is all.
    expect(titles(none)).toStrictEqual(["Who charges what", "Life of the channel"]);
    expect(text(none)).not.toContain("Disabled");
  });

  // The clock ticks every second for "1 129 days old": it once rebuilt every step, so a copy
  // button pressed just before a tick lost its "Copied", and a keyboard walk lost the step's
  // controls (the block, the transaction and its copy button) as a reader would lose focus.
  it("keeps the life's controls in place as the clock ticks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const el = show(channel());
    await shows(el, "Open now");
    const funded = () =>
      [...el.querySelectorAll(".ln-step__body")][0]?.querySelectorAll("a, button");
    const before = [...(funded() ?? [])];
    expect(before).toHaveLength(3);
    vi.advanceTimersByTime(3000);
    flush();
    // The same nodes, not equal copies.
    const after = [...(funded() ?? [])];
    expect(after.length === before.length && after.every((e, i) => e === before[i])).toBe(true);
    expect(before.every((e) => e.isConnected)).toBe(true);
  });

  it("charts each way's fee history, says when a way has one record, and counts the changes", async () => {
    const c = channel();
    const rec = (time: number, fee_rate: number) => ({
      time,
      fee_rate,
      base_fee_msat: 1000,
      inbound_fee: null,
    });
    replies[`/app/lightning/channels/${c.id}/fees`] = json({
      id: c.id,
      scid: c.scid,
      node_one: { from: T0, records: [rec(T0, 1), rec(T0 + 600, 5), rec(T0 + 4000, 9)] },
      // Its second record charged the same (an inbound fee from none to zero): no change.
      node_two: {
        from: T0,
        records: [
          rec(T0, 2499),
          { ...rec(T0 + 4500, 2499), inbound_fee: { base_fee_msat: 0, fee_rate: 0 } },
        ],
      },
      watched: [
        { from: T0, to: T0 + 1200 },
        { from: T0 + 3600, to: T0 + 4800 },
      ],
    });
    const el = show(c);
    await shows(el, "No change seen since");
    const fees = text(section(el, "Fee rate over time") as HTMLElement);
    expect(fees).toContain("Last 50 changes each way");
    expect(fees).toContain("bfx-lnd0 → ACINQ1 ppm");
    expect(fees).toContain("ACINQ → bfx-lnd02 499 ppmNo change seen since");
    // Its life counts the changes, not the first record, and leads to the chart.
    await vi.waitFor(() =>
      expect(steps(el)).toStrictEqual(["Funded", "2 fee changes", "Open now"]),
    );
    expect(links(el)).toContain("#fee-history");
    expect(text(el)).toContain("bfx-lnd0 2, ACINQ 0; the latest");
    // The latest is the last record whose fee moved, not one that charged the same.
    const latest = el.querySelector(".ln-step:nth-child(2) .ln-step__body time");
    expect(latest?.getAttribute("datetime")).toBe(new Date((T0 + 4000) * 1000).toISOString());
    // The hop's working-out says an inbound fee is left out.
    expect(text(section(el, "Fee for this hop") as HTMLElement)).toContain(
      "An inbound fee is not included",
    );
  });

  it("shows an inbound fee by its sign, in the lanes and as terms of their own", async () => {
    const one = { ...channel().node_one.policy, inbound_fee: { base_fee_msat: 0, fee_rate: -200 } };
    const two = { ...channel().node_two.policy, inbound_fee: { base_fee_msat: 1000, fee_rate: 0 } };
    const el = show(
      channel({
        node_one: { ...channel().node_one, policy: one as Policy },
        node_two: { ...channel().node_two, policy: two as Policy },
      }),
    );
    await shows(el, "Inbound discount −200 ppm");
    const lanes = text(section(el, "Who charges what") as HTMLElement);
    expect(lanes).toContain("Inbound surcharge +1 sat");
    expect(lanes).not.toContain("discount +");
    const terms = text(section(el, "Policies side by side") as HTMLElement);
    expect(terms).toContain("Inbound rate");
    expect(terms).toContain("−200 ppm");
    expect(terms).toContain("ACINQ +200 ppm");
    // Zero both ways is no inbound fee: no terms for it.
    const zero = show(
      channel({
        id: "811984x2037x8",
        node_one: {
          ...channel().node_one,
          policy: { ...one, inbound_fee: { base_fee_msat: 0, fee_rate: 0 } } as Policy,
        },
      }),
    );
    await shows(zero, "Policies side by side");
    expect(text(zero)).not.toContain("Inbound");
  });

  it("says when the funding transaction is not looked up yet", async () => {
    const el = show(channel({ funding: { ...channel().funding, txid: null } }));
    await shows(el, "Transaction not looked up yet");
    expect(links(el).some((h) => (h ?? "").startsWith("/tx/"))).toBe(false);
  });

  it.each([
    ["cooperative", "Cooperative close", "Cooperative close · Likely"],
    ["force", "Force close", "Force close · Certain"],
    ["penalty", "Force close", "Penalty · Certain"],
    ["other", "Other close", "Other · Certain it is not a plain close"],
  ] as const)(
    "says how a %s close ended, and leaves its policies out",
    async (kind, shown, sure) => {
      const el = show(closedChannel(kind));
      await shows(el, "How it ended");
      expect(titles(el)).toStrictEqual(["How it ended", "Life of the channel"]);
      const ended = text(section(el, "How it ended") as HTMLElement);
      expect(ended).toContain(shown);
      expect(ended).toContain(sure);
      expect(ended).toContain("fee 1 234 sats");
      expect(links(el)).toContain(`/tx/${CLOSING}`);
      expect(links(el).includes(`/tx/${SWEEP}`)).toBe(kind === "penalty");
      expect(steps(el)).toStrictEqual(
        kind === "penalty" ? ["Funded", "Closed", "Revoked state swept"] : ["Funded", "Closed"],
      );
      expect(text(el)).not.toContain("Open now");
    },
  );

  it("tells a breach found after a force close as a penalty", async () => {
    const el = show(closedChannel("force", { penalty: closedOf("penalty").penalty }));
    await shows(el, "How it ended");
    expect(text(el)).toContain("Closed: revoked state swept");
    expect(text(section(el, "How it ended") as HTMLElement)).toContain("Penalty · Certain");
    expect(steps(el)).toStrictEqual(["Funded", "Closed", "Revoked state swept"]);
  });

  it("links a channel to the one it continues and the one that continues it", async () => {
    const el = show(closedChannel("cooperative", { continued_as: NEXT, continued_from: EARLIER }));
    await shows(el, "How it ended");
    expect(text(el)).toContain("Closed: continued as a new channel");
    expect(text(section(el, "How it ended") as HTMLElement)).toContain(
      "Continued as 975402x1310x1",
    );
    expect(steps(el)).toStrictEqual([
      "Continues an earlier channel",
      "Funded",
      "Closed",
      "Continued as a new channel",
    ]);
    expect(links(el)).toContain(`/lightning/channel/${NEXT.id}`);
    expect(links(el)).toContain(`/lightning/channel/${EARLIER.id}`);
    expect(text(el)).not.toMatch(/splice[ds]/i);
  });

  it("says when this server knows no such channel, or the id is not one", async () => {
    const el = open("/lightning/channel/1x2x3");
    await shows(el, "This server knows no such channel");
    const bad = open("/lightning/channel/abc");
    await shows(bad, "Not a channel id");
    expect(requests.filter((r) => r.includes("/abc"))).toStrictEqual([]);
  });
});

describe("search and rankings", () => {
  it("lists matching nodes with their keys, and a channel by id", async () => {
    replies["/app/lightning/search?q=811984x2037x0"] = json({
      nodes: [],
      channels: [{ id: "811984x2037x0", scid: "1", capacity: 500_000_000, state: "closed" }],
    });
    const el = mount(() => <SearchPage />, "/lightning/search?q=811984x2037x0");
    await shows(el, "Closed");
    expect(links(el)).toContain("/lightning/channel/811984x2037x0");
    // A result opened from here leads back to the search, query and all.
    const nav = mount(() => <LightningNav here="detail" />);
    expect(nav.querySelector(".ln-nav__back")?.textContent).toBe("← Search results");
    expect(links(nav)).toContain("/lightning/search?q=811984x2037x0");
  });

  it("says when nothing matches, and refuses a search too short to ask", async () => {
    replies["/app/lightning/search?q=zzzz"] = json({ nodes: [], channels: [] });
    const el = mount(() => <SearchPage />, "/lightning/search?q=zzzz");
    await shows(el, "Nothing matches");
    const short = mount(() => <SearchPage />, "/lightning/search?q=ab");
    await shows(short, "Type at least 3 characters");
    expect(requests.filter((r) => r.includes("q=ab"))).toStrictEqual([]);
  });

  it("keeps the ranked figure on a phone when the ranking changes", async () => {
    replies["/app/lightning/rankings/capacity?limit=100"] = json({ by: "capacity", nodes: top });
    replies["/app/lightning/rankings/channels?limit=100"] = json({ by: "channels", nodes: top });
    const el = mount(() => <RankingsPage />, "/lightning/rankings");
    await shows(el, "Binance");
    const optional = (header: string) =>
      [...el.querySelectorAll("th")]
        .find((th) => th.textContent === header)
        ?.classList.contains("table__optional");
    expect(optional("Channels")).toBe(true);
    expect(optional("Capacity, BTC")).toBe(false);
    el.querySelector<HTMLAnchorElement>("a[href='/lightning/rankings?by=channels']")?.click();
    await vi.waitFor(() =>
      expect(requests).toContain("/app/lightning/rankings/channels?limit=100"),
    );
    await vi.waitFor(() => expect(optional("Channels")).toBe(false));
    expect(optional("Capacity, BTC")).toBe(true);
  });

  it("ranks the top nodes by what the address asks", async () => {
    replies["/app/lightning/rankings/age?limit=100"] = json({ by: "age", nodes: top });
    const el = mount(() => <RankingsPage />, "/lightning/rankings?by=age");
    await shows(el, "Binance");
    expect(el.querySelector(".ln-picker [aria-current=page]")?.textContent).toBe("Age");
    expect(text(el)).toContain("27 Nov 2019");
  });
});

describe("the penalties", () => {
  const LIST = "/app/lightning/penalties";
  const penalty = (n: number) => ({ ...closedOf("penalty"), id: `975574x${n}x1` });
  const answer = (o: Record<string, unknown> = {}) => ({
    page: 0,
    per_page: 25,
    total: 2,
    from: T0,
    channels: [penalty(1), penalty(2)],
    ...o,
  });

  it("lists each sweep with its channel, both ends, its transactions and its block", async () => {
    replies[LIST] = json(answer());
    const el = mount(() => <PenaltiesPage />, "/lightning/penalties");
    await shows(el, "2 seen on chain; who broadcast them is unknown.");
    const rows = el.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    const row = text(rows[0] as HTMLElement);
    for (const part of ["975574x1x1", "Penumbra", "lnd.lnfi.network", "10 000 000", "975 592"])
      expect(row).toContain(part);
    // Swept two blocks after the close (975 590 to 975 592).
    expect([...(rows[0] as HTMLElement).querySelectorAll("td")].map((td) => text(td))).toContain(
      "2",
    );
    expect(links(el)).toContain(`/tx/${CLOSING}`);
    expect(links(el)).toContain(`/tx/${SWEEP}`);
    expect(links(el)).toContain("/lightning/channel/975574x1x1");
    expect(el.querySelector(".pagination")).toBeNull();
    expect(text(el)).toContain("How penalties are identified");
  });

  it("says in one line that none were seen, and since when", async () => {
    replies[LIST] = json(answer({ total: 0, channels: [] }));
    const el = mount(() => <PenaltiesPage />, "/lightning/penalties");
    await shows(el, "None seen since 12 Nov 2026, when this server began watching.");
    expect(el.querySelector("table")).toBeNull();
    expect(text(el)).not.toContain("seen on chain");
  });

  it("says none were seen yet before the record has a start", async () => {
    replies[LIST] = json(answer({ total: 0, from: null, channels: [] }));
    const el = mount(() => <PenaltiesPage />, "/lightning/penalties");
    await shows(el, "None seen yet.");
    expect(el.querySelector("table")).toBeNull();
  });

  it("pages through the server, the page in the address from 1", async () => {
    replies[`${LIST}?page=1`] = json(answer({ page: 1, total: 27, channels: [penalty(26)] }));
    replies[LIST] = json(answer({ total: 27 }));
    const el = mount(() => <PenaltiesPage />, "/lightning/penalties?page=2");
    await shows(el, "Page 2 of 2");
    expect(requests).toContain(`${LIST}?page=1`);
    await shows(el, "975574x26x1");
    const previous = [...el.querySelectorAll("button")].find((b) => b.textContent === "Previous");
    previous?.click();
    await vi.waitFor(() => expect(requests).toContain(LIST));
    await shows(el, "Page 1 of 2");
    await shows(el, "975574x1x1");
  });

  it("reads an unreadable page in the address as the first", async () => {
    replies[LIST] = json(answer());
    const el = mount(() => <PenaltiesPage />, "/lightning/penalties?page=4002");
    await shows(el, "2 seen on chain");
    expect(requests).toStrictEqual(["/app/lightning/status", LIST]);
  });

  it("shows cards on a phone", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("max-width"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    replies[LIST] = json(answer());
    const el = mount(() => <PenaltiesPage />, "/lightning/penalties");
    await vi.waitFor(() => expect(el.querySelectorAll(".ln-node-card")).toHaveLength(2));
    expect(el.querySelector("table")).toBeNull();
    const card = text(el.querySelector(".ln-node-card") as HTMLElement);
    expect(card).toContain("swept after 2\u00A0blocks");
    expect(card).toContain("Closing transaction");
  });

  it("says the list could not load, and a network with Lightning off says that instead", async () => {
    replies[LIST] = json({ error: "broken" }, 404);
    const el = mount(() => <PenaltiesPage />, "/lightning/penalties");
    await shows(el, "Could not load the penalties");
    replies["/app/lightning/status"] = json({ state: "off" });
    requests = [];
    const off = mount(() => <PenaltiesPage />, "/regtest/lightning/penalties");
    await shows(off, "Lightning is switched off on Regtest");
    expect(requests).toStrictEqual(["/regtest/app/lightning/status"]);
  });

  it("is reached from the overview's closes by kind", async () => {
    replies["/app/lightning/overview"] = json(overview());
    replies["/app/lightning/statistics/1w"] = json(series());
    replies["/app/lightning/movers?period=1w"] = json(movers());
    replies["/app/lightning/closes?days=30"] = json(closes());
    replies["/app/lightning/feed"] = json({ events: [] });
    const el = mount(() => <LightningPage />, "/regtest/lightning");
    const section = await vi.waitFor(() => {
      const s = el.querySelector("[aria-labelledby=ln-closes-title]") as HTMLElement;
      expect(s.querySelector("a")).not.toBeNull();
      return s;
    });
    const link = [...section.querySelectorAll("a")].find((a) => a.textContent === "Penalties");
    expect(link?.getAttribute("href")).toBe("/regtest/lightning/penalties");
  });
});

describe("hostile names", () => {
  const impostor = (alias: string) => ({ ...top[0], id: ACINQ, alias });
  const searchFor = async (alias: string) => {
    replies["/app/lightning/search?q=acinq"] = json({ nodes: [impostor(alias)], channels: [] });
    const el = mount(() => <SearchPage />, "/lightning/search?q=acinq");
    await vi.waitFor(() => expect(el.querySelector(".ln-alias")).not.toBeNull());
    return el;
  };

  it("shows markup as text and builds no element from it", async () => {
    const el = await searchFor("<b>ACINQ</b><img src=x>");
    const name = el.querySelector(".ln-alias") as HTMLElement;
    expect(name.textContent).toBe("<b>ACINQ</b><img src=x>");
    expect(el.querySelector("img, b, script")).toBeNull();
    // The key, which the name cannot fake, is beside it.
    expect(text(el)).toContain("03864ef0");
  });

  it("isolates a name and shows a right-to-left override as a mark", async () => {
    const el = await searchFor("‮QNICA");
    const name = el.querySelector(".ln-alias") as HTMLElement;
    expect(name.tagName).toBe("BDI");
    expect(name.textContent).toBe("�QNICA");
  });

  it("cuts a name of 10 000 characters, with the rest a click away", async () => {
    const long = "W".repeat(10_000);
    const el = await searchFor(long);
    const name = el.querySelector(".ln-alias") as HTMLElement;
    expect(name.textContent).toBe(`${"W".repeat(32)}…`);
    expect(name.getAttribute("title")?.length).toBeLessThan(600);

    replies[`/app/lightning/nodes/${ACINQ}`] = json(acinq({ alias: long }));
    const page = open(`/lightning/node/${ACINQ}`);
    await shows(page, "Show the whole name");
    expect(page.querySelector("h1")?.textContent).toBe(`${"W".repeat(64)}…`);
    [...page.querySelectorAll("button")]
      .find((b) => b.textContent === "Show the whole name")
      ?.click();
    flush();
    expect(page.querySelector(".ln-name-full")?.textContent).toBe(long);
  });

  it("draws a node's colour only as the #rrggbb it should be", async () => {
    replies[`/app/lightning/nodes/${ACINQ}`] = json({
      ...acinq(),
      color: "red;background:url(javascript:alert(1))",
    });
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Announced colourNone announced");
    expect(el.innerHTML).not.toContain("javascript");
    expect(el.innerHTML).not.toContain("red;");
  });
});

describe("the transaction page's note", () => {
  const Note = (p: { confirmed?: boolean; txid?: string }) => (
    <TxLightning txid={p.txid ?? CLOSING} confirmed={p.confirmed ?? true} />
  );

  it("says a transaction closed a channel, how, and links to it", async () => {
    replies[`/app/lightning/tx/${CLOSING}`] = json({ opened: [], closed: [closedOf("force")] });
    const el = mount(() => <Note />, `/tx/${CLOSING}`);
    await shows(el, "This transaction closed Lightning channel");
    expect(text(el)).toContain("Force close (certain)");
    expect(links(el)).toContain("/lightning/channel/811984x2037x1");
  });

  it("says a commitment whose revocation sweep is recorded was a penalty, as the channel page does", async () => {
    // As the server lists a breach: the close keeps its kind, the sweep beside it.
    const breached = { ...closedOf("force"), penalty: closedOf("penalty").penalty };
    replies[`/app/lightning/tx/${CLOSING}`] = json({ opened: [], closed: [breached] });
    const el = mount(() => <Note />, `/tx/${CLOSING}`);
    await shows(el, "This transaction closed Lightning channel");
    expect(text(el)).toContain("Penalty (certain)");
    expect(text(el)).toContain("this server saw the sweep");
    expect(text(el)).not.toContain("Force close");
    expect(text(el)).not.toContain("once a sweep");
  });

  it("says a transaction opened a channel", async () => {
    replies[`/app/lightning/tx/${FUNDING}`] = json({ opened: [opened], closed: [] });
    const el = mount(() => <Note txid={FUNDING} />, `/tx/${FUNDING}`);
    await shows(el, "This transaction opened Lightning channel");
    expect(links(el)).toContain(`/lightning/channel/${opened.id}`);
  });

  it("shows nothing for an ordinary transaction", async () => {
    replies[`/app/lightning/tx/${CLOSING}`] = json({ opened: [], closed: [] });
    const el = mount(() => <Note />, `/tx/${CLOSING}`);
    await vi.waitFor(() => expect(requests).toContain(`/app/lightning/tx/${CLOSING}`));
    flush();
    expect(text(el)).toBe("");
  });

  it("asks nothing for an unconfirmed transaction", async () => {
    const el = mount(() => <Note confirmed={false} />, `/tx/${CLOSING}`);
    await Promise.resolve();
    flush();
    expect(requests).toStrictEqual([]);
    expect(text(el)).toBe("");
  });

  it("asks only the status where Lightning is off, and only once a tab", async () => {
    replies["/app/lightning/status"] = json({ state: "off" });
    mount(() => <Note />, `/testnet4/tx/${CLOSING}`);
    await vi.waitFor(() => expect(requests).toStrictEqual(["/testnet4/app/lightning/status"]));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    mount(() => <Note txid={FUNDING} />, `/testnet4/tx/${FUNDING}`);
    await Promise.resolve();
    flush();
    expect(requests).toStrictEqual(["/testnet4/app/lightning/status"]);
  });
});
