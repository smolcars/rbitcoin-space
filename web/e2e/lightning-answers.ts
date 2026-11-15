// Regtest runs without Lightning, so the filled pages are drawn from answers a mainnet server
// gave on 2026-11-12 and 2026-11-15 (fixtures/lightning/app), served in place of this server's own. Shared by
// lightning.e2e.ts and the table rules in tables.e2e.ts.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

export const recorded = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/lightning/app/${name}.json`, import.meta.url), "utf8"),
  );

export const ACINQ = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";
/** FUNK-BTCPay: one channel, 10 ppm out and 300 ppm in. */
export const ONE = "03874dc955fba789b08db50beb6839d41379071f4f4747ae8546329a14176e339a";

/** Answers `/regtest/app/lightning/…` from `answers`, keyed by the path after it and its query. */
export async function serve(page: Page, answers: Record<string, unknown>) {
  await page.route(/\/regtest\/app\/lightning\//, async (route) => {
    const url = new URL(route.request().url());
    const key = url.pathname.replace(/^\/regtest\/app\/lightning\//, "") + url.search;
    const json = answers[key];
    await (json === undefined
      ? route.fulfill({ status: 500, json: { error: `no recorded answer for ${key}` } })
      : route.fulfill({ json }));
  });
}

export const mainnet = (): Record<string, unknown> => ({
  status: recorded("status"),
  overview: recorded("overview"),
  "statistics/1w": recorded("statistics-1w"),
  [`nodes/${ACINQ}`]: recorded("node-acinq"),
  [`nodes/${ACINQ}/history`]: recorded("node-acinq-history"),
  [`nodes/${ACINQ}/channels?status=closed`]: recorded("node-acinq-closed"),
  // Recorded 2026-11-15, from a server with the fee history.
  [`nodes/${ACINQ}/fees`]: recorded("node-acinq-fees"),
  [`nodes/${ONE}`]: recorded("node-one"),
  [`nodes/${ONE}/history`]: recorded("node-one-history"),
  [`nodes/${ONE}/fees`]: { changes: [] },
  "channels/811984x2037x0": recorded("channel-811984x2037x0"),
  "channels/811984x2037x0/fees": recorded("channel-811984x2037x0-fees"),
  "search?q=acinq": recorded("search-acinq"),
  "rankings/capacity?limit=100": recorded("rankings-capacity"),
});

/**
 * Anything past the window's edges outside a scroller, any run of digits on two lines, a figure
 * apart from its unit or out of its box: what a Lightning page must hold at every text size
 * (policies.e2e.ts, policies-node.e2e.ts).
 */
export const pageFaults = (page: Page) =>
  page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) d.open = true;
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const e of document.querySelectorAll("main *")) {
      const box = e.getBoundingClientRect();
      if (box.width === 0 || (box.right <= width + 1 && box.left >= -1)) continue;
      let clipped = false;
      for (let p = e.parentElement; p && !clipped; p = p.parentElement) {
        clipped = getComputedStyle(p).overflowX !== "visible";
      }
      if (!clipped) {
        const what = `${e.tagName.toLowerCase()}.${e.className} "${(e.textContent ?? "").slice(0, 40)}"`;
        out.push(`past the edge: ${what} to ${Math.round(box.right)}`);
      }
    }
    // Names, ids, keys and addresses may break; a figure never breaks inside its digits.
    const walk = document.createTreeWalker(document.querySelector("main") as Node, 4);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      // An announced address (`3.33.236.230:9735`) is not a figure either.
      if (n.parentElement?.closest("bdi, .hash, .mono, .ln-key, .ln-chips--mono, .visually-hidden"))
        continue;
      for (const m of (n.textContent ?? "").matchAll(/\d[\d .,:]*\d/g)) {
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const tops = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        if (tops.size > 1) out.push(`split: ${m[0]}`);
      }
    }
    // A figure is one piece with its unit ("1 sat", never "1" then "sat"); a time is a phrase.
    for (const el of document.querySelectorAll<HTMLElement>("main :is(.num, .ln-msat)")) {
      // A channel id wraps after an "x" by design (ChannelId).
      // A chart's reading of its time is a phrase too.
      if (el.querySelector(".num") || el.closest("time, .chart__when, .visually-hidden, .ln-id"))
        continue;
      if (!/\d/.test(el.textContent ?? "") || el.getClientRects().length === 0) continue;
      // Its visible text only: a figure's words for a screen reader are drawn nowhere.
      const tops: number[] = [];
      const texts = document.createTreeWalker(el, 4);
      for (let t = texts.nextNode(); t; t = texts.nextNode()) {
        if (t.parentElement?.closest(".visually-hidden")) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) if (r.width > 0) tops.push(r.top);
      }
      // One line however its text is set: a smaller unit beside its digits sits a little lower,
      // so only a step of half the figure's size is a new line.
      const half = Number.parseFloat(getComputedStyle(el).fontSize) / 2;
      tops.sort((a, b) => a - b);
      if (tops.some((t, i) => i > 0 && t - (tops[i - 1] ?? t) > half))
        out.push(`unit apart: ${el.textContent ?? ""}`);
      // Nor out of the box a reader sees round it: a fee's well, an end's box, the panel.
      // A row that scrolls sideways on purpose (the state chips, a wide table) is its own box.
      let scrolls = false;
      for (let p = el.parentElement; p && !scrolls; p = p.parentElement) {
        scrolls = getComputedStyle(p).overflowX !== "visible";
      }
      const box = el
        .closest(".ln-hop__way, .ln-end, .ln-node-card, section, header")
        ?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (!scrolls && box && (r.left < box.left - 1 || r.right > box.right + 1)) {
        const at = `${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)}`;
        out.push(`out of its box: ${el.textContent ?? ""} (${at})`);
      }
    }
    if (document.documentElement.scrollWidth > width) out.push("the page scrolls sideways");
    return out.slice(0, 6);
  });

/** The most negative and the largest an inbound fee's signed 32-bit fields hold. */
export const I32_MIN = -2_147_483_648;
export const I32_MAX = 2_147_483_647;

/**
 * A channel's fee history in full: fifty records each way, oldest first, every ten minutes across
 * a gap the server was not recording, the rate moving at each, the base fee and an inbound fee
 * (a discount one way, a surcharge the other) moving now and then. `rate` sets each record's
 * rate from its index, for the longest figures.
 */
export function feeHistory(
  rate: (i: number) => number = (i) => 100 + ((i * 37) % 900),
  inbound: [number, number] = [-200, 150],
): Record<string, unknown> {
  const t0 = 1_794_700_000;
  const way = (sign: number, k: number) => ({
    from: t0,
    records: Array.from({ length: 50 }, (_, i) => ({
      time: t0 + i * 600 + k,
      fee_rate: rate(i + k),
      base_fee_msat: i % 7 === 0 ? 1000 * (i % 3) : 1000,
      inbound_fee: i % 5 === 0 ? null : { base_fee_msat: i % 2 === 0 ? sign : 0, fee_rate: sign },
    })),
  });
  const [one, two] = inbound;
  return {
    id: "811984x2037x0",
    scid: "892785849701564416",
    node_one: way(one, 0),
    node_two: way(two, 1),
    watched: [
      { from: t0, to: t0 + 12_000 },
      { from: t0 + 18_000, to: t0 + 30_000 },
    ],
  };
}

/**
 * The tables in `sel` that scroll sideways, which `pageFaults` lets pass as boxes of their own: a
 * fee history's figures and a node's fee changes fit whole at every size.
 */
export const tablesScrolling = (page: Page, sel: string) =>
  page.evaluate(
    (s) =>
      [...document.querySelectorAll(`${s} :is(.table-scroll, .chart__table)`)]
        .filter((e) => e.getClientRects().length > 0 && e.scrollWidth > e.clientWidth + 1)
        .map((e) => {
          // What reaches furthest, to name the cause.
          let far: Element = e;
          for (const d of e.querySelectorAll("*"))
            if (d.getBoundingClientRect().right > far.getBoundingClientRect().right) far = d;
          const what = `${far.tagName.toLowerCase()}.${far.className} "${(far.textContent ?? "").slice(0, 30)}"`;
          return `${s} scrolls: ${e.scrollWidth} in ${e.clientWidth}, ${what}`;
        }),
    sel,
  );
