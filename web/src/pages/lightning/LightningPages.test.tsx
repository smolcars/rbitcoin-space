import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import ChannelPage from "./ChannelPage";
import LightningPage from "./LightningPage";
import NodePage from "./NodePage";
import RankingsPage from "./RankingsPage";
import type { ChannelDetail, Policy } from "./lightning";
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
  EARLIER,
  FUNDING,
  NEXT,
  opened,
  overview,
  series,
  SWEEP,
  synced,
  syncing,
  T0,
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
    replies["/app/lightning/overview"] = json(overview());
    replies["/app/lightning/statistics/1w"] = json(series());
  });

  it("shows the network now, with the snapshot's figures", async () => {
    const el = mount(() => <LightningPage />, "/lightning");
    await shows(el, "Channels36 228");
    expect(text(el)).toContain("Nodes13 639");
    expect(text(el)).toContain("3 220.85363482 BTC");
    expect(text(el)).toContain("Median fee rate130 ppm");
    expect(text(el)).toContain("Median base fee484 msat");
    expect(text(el)).toContain("As of 12 Nov 2026, 18:30 UTC");
    expect(text(el)).toContain("Only channels whose funding output this server found on the chain");
  });

  it("lists the newest opens and closes with their kinds, linked to channel, node and block", async () => {
    const el = mount(() => <LightningPage />, "/lightning");
    await shows(el, "Newest closes");
    const closes = el.querySelector("[aria-labelledby=ln-closed-title]") as HTMLElement;
    expect(text(closes)).toContain("Force");
    expect(text(closes)).toContain("Cooperative");
    expect(links(el)).toContain(`/lightning/channel/${opened.id}`);
    expect(links(el)).toContain(`/lightning/node/${opened.node_one.id}`);
    expect(links(el)).toContain(`/block/${opened.opened?.hash ?? ""}`);
    expect(links(el)).toContain("/lightning/rankings?by=age");
  });

  it("says so when no close was seen and no snapshot is stored yet", async () => {
    replies["/app/lightning/overview"] = json(overview({ statistics: null, closed: [] }));
    replies["/app/lightning/statistics/1w"] = json(series({ first: null, points: [] }));
    const el = mount(() => <LightningPage />, "/lightning");
    await shows(el, "No close seen yet");
    await shows(el, "No snapshot yet");
    await shows(el, "Nothing recorded yet");
    expect(el.querySelector("[role=slider]")).toBeNull();
  });

  it("draws ten minutes of history from where it starts, hatching before", async () => {
    const el = mount(() => <LightningPage />, "/lightning");
    await shows(el, "Everything recorded, since 12 Nov");
    await vi.waitFor(() => expect(el.querySelector("[role=slider] svg")).not.toBeNull());
    // Fitted to what is recorded: "Recorded" is the choice marked, never "1 w" for a narrower view.
    expect(el.querySelector(".periods [aria-current=page]")?.textContent).toBe(
      "Recorded: since this server began recording",
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
    const el = mount(() => <LightningPage />, "/lightning?interval=24h");
    await vi.waitFor(() => expect(el.querySelector("[role=slider] svg")).not.toBeNull());
    const line = el.querySelector("[role=slider] .chart__line")?.getAttribute("d") ?? "";
    expect(line.match(/M/g)).toHaveLength(2);
    expect(requests).toContain("/app/lightning/statistics/24h");
  });
});

describe("a node", () => {
  it("shows its name, key, figures, announcements and first page of channels", async () => {
    replies[`/app/lightning/nodes/${ACINQ}`] = json(acinq());
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Open channels1 807");
    expect(el.querySelector("h1")?.textContent).toBe("ACINQ");
    expect(text(el)).toContain("03864ef0");
    expect(text(el)).toContain("The public key is the node's identity");
    expect(text(el)).toContain("First seen26 Feb 2019");
    expect(text(el)).toContain(
      "of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735",
    );
    expect(text(el)).toContain("data-loss-protect (required)");
    expect(text(el)).toContain("Bit 37");
    // Addresses are text, never links.
    expect(links(el).some((h) => (h ?? "").includes("9735"))).toBe(false);
    expect(el.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(text(el)).toContain("Page 1 of 73");
  });

  it("asks for later pages and closed channels, and says when it has no closed one", async () => {
    replies[`/app/lightning/nodes/${ACINQ}`] = json(acinq());
    replies[`/app/lightning/nodes/${ACINQ}/channels?status=open&page=1`] = json({
      ...acinq().open_channels,
      page: 1,
      channels: [{ ...acinq().open_channels.channels[0], id: "900000x1x1" }],
    });
    replies[`/app/lightning/nodes/${ACINQ}/channels?status=closed&page=0`] = json({
      status: "closed",
      page: 0,
      per_page: 25,
      total: 0,
      channels: [],
    });
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Page 1 of 73");
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Next")?.click();
    flush();
    await shows(el, "900000x1x1");
    [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Closed"))?.click();
    flush();
    await shows(el, "No close seen");
    expect(requests).toContain(`/app/lightning/nodes/${ACINQ}/channels?status=closed&page=0`);
  });

  it("says a later page failed, rather than keep the last one under its number", async () => {
    replies[`/app/lightning/nodes/${ACINQ}`] = json(acinq());
    replies[`/app/lightning/nodes/${ACINQ}/channels?status=open&page=1`] = json({
      ...acinq().open_channels,
      page: 1,
      channels: [{ ...acinq().open_channels.channels[0], id: "900000x1x1" }],
    });
    replies[`/app/lightning/nodes/${ACINQ}/channels?status=open&page=2`] = json(
      { error: "the node is not answering" },
      502,
    );
    const el = open(`/lightning/node/${ACINQ}`);
    const next = async () => {
      [...el.querySelectorAll("button")].find((b) => b.textContent === "Next")?.click();
      flush();
    };
    await shows(el, "Page 1 of 73");
    await next();
    await shows(el, "900000x1x1");
    await next();
    await shows(el, "Could not load these channels");
    expect(text(el)).not.toContain("900000x1x1");
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Try again")).toBe(
      true,
    );
  });

  it("shows a node that never announced itself", async () => {
    // What the server sends for a node it holds only through its channels (nodes.rs app_node).
    replies[`/app/lightning/nodes/${ACINQ}`] = json(
      acinq({ alias: null, addresses: null, features: [], last_update: null }),
    );
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Unnamed node");
    expect(text(el)).toContain("It has sent no announcement");
    expect(text(el)).toContain("AddressesNone announced");
    expect(text(el)).toContain("Open channels1 807");
  });

  it("draws its channels and capacity since the record began, and how it prices them", async () => {
    replies[`/app/lightning/nodes/${ACINQ}`] = json(acinq());
    replies[`/app/lightning/nodes/${ACINQ}/history`] = json({
      from: 1_794_504_600,
      points: [
        { time: 1_794_528_000, channels: 1804, capacity: 27_651_420_454 },
        { time: 1_794_593_410, channels: 1793, capacity: 28_497_516_531 },
      ],
    });
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Recorded since 12 Nov 2026, 17:30 UTC");
    await vi.waitFor(() => expect(el.querySelector("[role=slider] svg")).not.toBeNull());
    expect(text(el)).toContain("It charges a median of 2 000–4 999 ppm to forward");
    // The figures table is drawn only when opened: the channel list is the page's one list.
    expect(el.querySelectorAll("tbody tr")).toHaveLength(25);
  });

  it("says when there is no past to draw yet, and when its history is refused", async () => {
    replies[`/app/lightning/nodes/${ACINQ}`] = json(acinq());
    replies[`/app/lightning/nodes/${ACINQ}/history`] = json({
      from: null,
      points: [{ time: 1_794_593_410, channels: 1793, capacity: 28_497_516_531 }],
    });
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Nothing to draw yet");
    expect(el.querySelector("[role=slider]")).toBeNull();
    // The node's own figures stay when its history fails.
    replies[`/app/lightning/nodes/${ACINQ}/history`] = json({ error: "store is busy" }, 500);
    clearApiCache();
    const failed = open(`/lightning/node/${ACINQ}`);
    await shows(failed, "Could not load its history");
    expect(text(failed)).toContain("Open channels1 807");
  });

  it("says when this server knows no such node, or the key is not one", async () => {
    const el = open(`/lightning/node/${"02".padEnd(66, "0")}`);
    await shows(el, "This server knows no such node");
    const bad = open("/lightning/node/not-a-key");
    await shows(bad, "Not a node's public key");
    expect(requests.filter((r) => r.includes("not-a-key"))).toStrictEqual([]);
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

  it("never lets a node's colour reach the page", async () => {
    replies[`/app/lightning/nodes/${ACINQ}`] = json({
      ...acinq(),
      color: "red;background:url(javascript:alert(1))",
    });
    const el = open(`/lightning/node/${ACINQ}`);
    await shows(el, "Open channels");
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
