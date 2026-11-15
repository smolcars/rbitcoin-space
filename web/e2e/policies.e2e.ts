// The channel page for operators in every state it draws (docs/DESIGN.md "Lightning"), from the
// recorded answer: at a desktop's and a phone's width, and at 320 px with 200% text. Its own file
// so CI's sharding puts it on the lightest shard (docs/CI.md "Browser test shards").
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { recorded } from "./lightning-answers";

/**
 * A channel in each state its page draws, from the recorded answer, its ends given names made to
 * break a layout: 32 bytes with no space, right to left, emoji.
 */
function channelStates(): Record<string, unknown> {
  interface End {
    alias: string | null;
    policy: Record<string, unknown> | null;
  }
  const real = recorded("channel-811984x2037x0") as {
    node_one: End;
    node_two: End;
    funding: { block: { time: number } };
  };
  const long = "0256ccca46170ff4b1ef0256ccca4617";
  const rtl = "عقدةالبرقالسريعة";
  const emoji = "⚡🐙🦀⚡🐙🦀⚡🐙";
  const block = (height: number, time: number) => ({ height, hash: "00".repeat(32), time });
  const ends = (one: string, two: string, a = real.node_one.policy, b = real.node_two.policy) => ({
    node_one: { ...real.node_one, alias: one, policy: a },
    node_two: { ...real.node_two, alias: two, policy: b },
  });
  const closed = (kind: string, fee: number | null = 1234) => ({
    ...real,
    ...ends(long, rtl, null, null),
    state: "closed",
    closed: { block: block(975_590, 1_794_508_800), txid: "5c".repeat(32), kind, fee },
    penalty: null,
  });
  const base = { ...real.node_one.policy, enabled: true };
  const next = { id: "975402x1310x1", scid: "1072528709001609217", capacity: 4_000_000 };
  return {
    open: { ...real, ...ends(long, rtl) },
    // The longest terms a policy can hold: a limit of all bitcoin, a rate that takes the whole
    // amount.
    "largest limit": { ...real, ...ends(rtl, long, { ...base, max_htlc_msat: 2.1e18 }, null) },
    "largest rate": { ...real, ...ends(rtl, long, { ...base, fee_rate: 1_000_000 }, null) },
    // Just under where a term reads in magnitude at every size: the longest exact figures.
    "longest exact limit": {
      ...real,
      ...ends(rtl, long, { ...base, max_htlc_msat: 99_999_999_999 }, null),
    },
    "longest exact base": {
      ...real,
      ...ends(rtl, long, { ...base, base_fee_msat: 999_999_999 }, null),
    },
    "disabled one way": {
      ...real,
      ...ends(emoji, long, real.node_one.policy, { ...real.node_two.policy, enabled: false }),
    },
    "no policy one way": { ...real, ...ends(rtl, emoji, real.node_one.policy, null) },
    "no policy either way": { ...real, ...ends(long, long, null, null) },
    cooperative: { ...closed("cooperative"), ...ends(emoji, long, null, null) },
    force: closed("force", null),
    penalty: {
      ...closed("penalty"),
      penalty: { block: block(975_592, 1_794_510_000), txid: "9e".repeat(32) },
    },
    "other, continued": {
      ...closed("other"),
      continued_as: { ...next, state: "active" },
      continued_from: { ...next, id: "700000x1x1", state: "closed" },
    },
  };
}

/** Serves one channel answer at a time, so each state is a reload with nothing else changed. */
async function serveChannel(page: Page): Promise<(answer: unknown) => void> {
  let answer: unknown;
  await page.route(/\/regtest\/app\/lightning\//, (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/status") ? recorded("status") : answer,
    }),
  );
  return (a) => {
    answer = a;
  };
}

/** Anything past the window's edges outside a scroller, and any run of digits on two lines. */
const channelFaults = (page: Page) =>
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
    // Names, ids and keys may break; a figure never breaks inside its digits.
    const walk = document.createTreeWalker(document.querySelector("main") as Node, 4);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.parentElement?.closest("bdi, .hash, .mono, .ln-key, .visually-hidden")) continue;
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
      if (el.querySelector(".num") || el.closest("time, .visually-hidden, .ln-id")) continue;
      if (!/\d/.test(el.textContent ?? "") || el.getClientRects().length === 0) continue;
      // Its visible text only: a figure's words for a screen reader are drawn nowhere.
      const tops = new Set<number>();
      const texts = document.createTreeWalker(el, 4);
      for (let t = texts.nextNode(); t; t = texts.nextNode()) {
        if (t.parentElement?.closest(".visually-hidden")) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
      }
      if (tops.size > 1) out.push(`unit apart: ${el.textContent ?? ""}`);
      // Nor out of the box a reader sees round it: a fee's well, an end's box, the panel.
      const box = el.closest(".ln-hop__way, .ln-end, section, header")?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (box && (r.left < box.left - 1 || r.right > box.right + 1)) {
        const at = `${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)}`;
        out.push(`out of its box: ${el.textContent ?? ""} (${at})`);
      }
    }
    if (document.documentElement.scrollWidth > width) out.push("the page scrolls sideways");
    return out.slice(0, 6);
  });

test("a channel page draws every state at a desktop's and a phone's width, light and dark", async ({
  page,
}) => {
  const answer = await serveChannel(page);
  const views = [
    { width: 1280, colorScheme: "light" },
    { width: 390, colorScheme: "dark" },
  ] as const;
  for (const [name, channel] of Object.entries(channelStates())) {
    answer(channel);
    for (const view of views) {
      await page.setViewportSize({ width: view.width, height: 900 });
      await page.emulateMedia({ colorScheme: view.colorScheme });
      await page.goto("/regtest/lightning/channel/811984x2037x0");
      await expect(page.getByRole("heading", { name: "Life of the channel" })).toBeVisible();
      const label = `${name} at ${view.width} px, ${view.colorScheme}`;
      expect(await channelFaults(page), label).toStrictEqual([]);
      if (name === "longest exact base") {
        // A long fee is exact in a wide well, in magnitude only where its well is narrow.
        await expect(page.locator(".ln-hop__fee").first()).toHaveText(
          view.width === 1280 ? "1\u202F000\u202F000.099 sats" : "0.0100 BTC",
          { useInnerText: true },
        );
      }
    }
    // What each state says, once.
    const closed = ["cooperative", "force", "penalty", "other, continued"].includes(name);
    await expect(page.getByRole("heading", { name: "How it ended" })).toHaveCount(closed ? 1 : 0);
    await expect(page.getByRole("heading", { name: "Fee for this hop" })).toHaveCount(
      closed || name === "no policy either way" ? 0 : 1,
    );
  }
  await expect(page.getByRole("link", { name: "975402x1310x1" }).first()).toHaveAttribute(
    "href",
    "/regtest/lightning/channel/975402x1310x1",
  );
});

// The council's last defects: at 200% text on a 320 px phone a figure broke inside its digits,
// and a long name widened the drawing past its panel. 20 and 24 px text sit between the normal
// size and 200%, where a fee once outgrew its well. A test a size: each is a visitor of its own,
// under the server's per-client limits.
for (const text of [20, 24, 32]) {
  test(`a channel page holds at 320 and 390 px with ${text} px text, in every state, with hostile names`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "only Chromium lets a test set the browser's text size");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.setFontSizes", {
      fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
    });
    const answer = await serveChannel(page);
    const faults: string[] = [];
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const [name, channel] of Object.entries(channelStates())) {
        answer(channel);
        await page.goto("/regtest/lightning/channel/811984x2037x0");
        await expect(page.getByRole("heading", { name: "Life of the channel" })).toBeVisible();
        faults.push(...(await channelFaults(page)).map((f) => `${width} px, ${name}: ${f}`));
      }
    }
    expect(faults).toStrictEqual([]);
  });
}
