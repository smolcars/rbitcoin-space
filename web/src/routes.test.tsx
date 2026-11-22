import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "./routes";
import { Shell } from "./shell/Shell";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function open(
  url: string,
  networks = ["mainnet", "signet", "testnet4"],
  ark: Record<string, string[]> = {},
) {
  vi.stubGlobal("fetch", async () => Response.json({ networks, version: "0.5.0", ark }));
  const history = memoryHistory(url);
  const Router = createRouter({ routes, history });
  const el = document.createElement("div");
  document.body.append(el);
  render(() => <Router>{(page) => <Shell>{page.children}</Shell>}</Router>, el);
  await vi.waitFor(() => expect(el.querySelector("h1")).not.toBeNull());
  return { el, history };
}

describe("routes", () => {
  it.each([
    ["/", "Blocks"],
    ["/block/840000", "Block 840\u202F000"],
    ["/blocks", "Blocks"],
    ["/signet/blocks/5", "Blocks"],
    ["/tx/ab", "Transaction"],
    ["/address/bc1q", "Address"],
    ["/mining", "Mining"],
    ["/lightning", "Lightning"],
    ["/ark", "Ark"],
    ["/ark/vtxo/ab:0", "VTXO"],
    ["/nope", "Page not found"],
    ["/signet", "Blocks"],
    ["/signet/", "Blocks"],
    ["/testnet4/tx/ab", "Transaction"],
    ["/signet/nope/deeper", "Page not found"],
    // The decoder is one page outside every network's prefix.
    ["/decode", "Decode"],
    ["/signet/decode", "Page not found"],
  ])("%s shows %s", async (url, heading) => {
    const { el } = await open(url);
    expect(el.querySelector("h1")?.textContent).toBe(heading);
  });

  it("marks test networks and keeps links on them", async () => {
    const { el } = await open("/testnet4/tx/ab");
    expect(document.documentElement.dataset["network"]).toBe("testnet4");
    expect(el.querySelector(".network-band")?.textContent).toBe(
      "Testnet4 is a test network. Coins here have no value.",
    );
    expect(el.querySelector(".brand")?.getAttribute("href")).toBe("/testnet4");
    expect(el.querySelector('nav[aria-label="Main"] a:nth-child(3)')?.getAttribute("href")).toBe(
      "/testnet4/mining",
    );
    // The decoder is one page for every network.
    expect(el.querySelector(".site-footer a[href='/decode']")?.textContent).toBe("Decoder");
    expect(document.title).toBe("Testnet4: Transaction | rbitcoin.space");
  });

  it("marks Testnet 5 too, and offers no Lightning there", async () => {
    const { el } = await open("/testnet5/tx/ab", ["mainnet", "testnet5"]);
    expect(document.documentElement.dataset["network"]).toBe("testnet5");
    expect(el.querySelector(".network-band")?.textContent).toBe(
      "Testnet5 is a test network. Coins here have no value.",
    );
    const nav = [...el.querySelectorAll('nav[aria-label="Main"] a')];
    expect(nav.map((a) => a.getAttribute("href"))).toStrictEqual([
      "/testnet5/blocks",
      "/testnet5/mempool",
      "/testnet5/mining",
    ]);
    expect(document.title).toBe("Testnet5: Transaction | rbitcoin.space");
  });

  it("offers Ark only on a network the server names an implementation for", async () => {
    const hrefs = (el: HTMLElement) =>
      [...el.querySelectorAll('nav[aria-label="Main"] a')].map((a) => a.getAttribute("href"));
    const { el } = await open("/signet/tx/ab", undefined, { signet: ["bark"] });
    await vi.waitFor(() => expect(hrefs(el)).toContain("/signet/ark"));
    document.body.replaceChildren();
    const other = await open("/testnet4/tx/ab", undefined, { signet: ["bark"] });
    await vi.waitFor(() => expect(other.el.querySelectorAll(".network__option")).toHaveLength(3));
    expect(hrefs(other.el)).not.toContain("/testnet4/ark");
  });

  it("offers the same page on every enabled network", async () => {
    const { el } = await open("/signet/block/5?x=1");
    await vi.waitFor(() => expect(el.querySelectorAll(".network__option")).toHaveLength(3));
    const hrefs = [...el.querySelectorAll(".network__option")].map((a) => a.getAttribute("href"));
    expect(hrefs).toStrictEqual(["/block/5?x=1", "/signet/block/5?x=1", "/testnet4/block/5?x=1"]);
    expect(el.querySelector(".network-band")).not.toBeNull();
  });

  it("moves off a network the server does not serve", async () => {
    const { history } = await open("/tx/ab", ["signet"]);
    await vi.waitFor(() => expect(history.get()).toBe("/signet/tx/ab"));
  });

  it("keeps the query and fragment as it moves, and leaves a page on no network", async () => {
    const moved = await open("/address/bc1q?view=unspent#x", ["signet"]);
    await vi.waitFor(() => expect(moved.history.get()).toBe("/signet/address/bc1q?view=unspent#x"));
    const decoder = await open("/decode#lnbc1x", ["signet"]);
    expect(decoder.history.get()).toBe("/decode#lnbc1x");
  });
});
