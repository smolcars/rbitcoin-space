// The channel page for operators in every state it draws (docs/DESIGN.md "Lightning"), from the
// recorded answer: at a desktop's and a phone's width, and at 320 px with 200% text. Its own file
// so CI's sharding puts it on the lightest shard (docs/CI.md "Browser test shards").
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  ACINQ,
  feeHistory,
  I32_MAX,
  I32_MIN,
  mainnet,
  pageFaults,
  recorded,
  serve,
  tablesScrolling,
} from "./lightning-answers";

/** The largest a policy's 32-bit rate can be, in ppm. */
const U32 = 4_294_967_295;

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
    // The longest figures under a bitcoin, where a term once switched to magnitude.
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
    // An inbound fee at both its ends, a discount one way and a surcharge the other, beside the
    // largest rate a policy holds.
    "inbound at the extremes": {
      ...real,
      ...ends(
        long,
        rtl,
        { ...base, fee_rate: U32, inbound_fee: { base_fee_msat: I32_MIN, fee_rate: I32_MIN } },
        { ...base, fee_rate: U32, inbound_fee: { base_fee_msat: I32_MAX, fee_rate: I32_MAX } },
      ),
    },
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

/** Each open state's fee history: a full one, or the short ones real data starts with. */
function feesOf(name: string): Record<string, unknown> {
  const full = feeHistory();
  const one = (full["node_one"] as { records: unknown[] }).records;
  const short = (records: unknown[]) => ({ from: 1_794_700_000, records });
  if (name === "disabled one way")
    return { ...full, node_one: short(one.slice(0, 1)), node_two: short(one.slice(0, 1)) };
  if (name === "no policy one way") return { ...full, node_two: short([]) };
  if (name === "inbound at the extremes")
    return feeHistory((i) => (i % 2 === 0 ? U32 : 0), [I32_MIN, I32_MAX]);
  return full;
}

/**
 * Serves one channel answer and its fee history at a time, so each state is a reload with nothing
 * else changed.
 */
async function serveChannel(page: Page): Promise<(answer: unknown, fees?: unknown) => void> {
  let answer: unknown;
  let history: unknown;
  await page.route(/\/regtest\/app\/lightning\//, (route) => {
    const url = route.request().url();
    return route.fulfill({
      json: url.endsWith("/status") ? recorded("status") : url.endsWith("/fees") ? history : answer,
    });
  });
  return (a, f) => {
    answer = a;
    history = f;
  };
}

/** Waits for the fee history to be drawn each way, then opens its figures, for `pageFaults`. */
async function feesDrawn(page: Page, open: boolean) {
  if (!open) return;
  const ways = page.locator("#fee-history .ln-feehist__way");
  for (const way of await ways.all())
    await expect(way.locator("[role='slider'], .ln-feehist__still")).toHaveCount(1);
  for (const more of await page.locator("#fee-history .chart__figures > summary").all())
    await more.click();
}

// A test a view: one test of both loaded the page 26 times and ran past its 30 s on CI's runners.
// What each state says and the last link do not change with the view, so the desktop checks them.
for (const view of [
  { width: 1280, colorScheme: "light" },
  { width: 390, colorScheme: "dark" },
] as const) {
  const desktop = view.width === 1280;
  test(`a channel page draws every state at ${view.width} px, ${view.colorScheme}`, async ({
    page,
  }) => {
    const answer = await serveChannel(page);
    await page.setViewportSize({ width: view.width, height: 900 });
    await page.emulateMedia({ colorScheme: view.colorScheme });
    for (const [name, channel] of Object.entries(channelStates())) {
      answer(channel, feesOf(name));
      const closed = ["cooperative", "force", "penalty", "other, continued"].includes(name);
      const hasFees = !closed && name !== "no policy either way";
      await page.goto("/regtest/lightning/channel/811984x2037x0");
      await expect(page.getByRole("heading", { name: "Life of the channel" })).toBeVisible();
      await feesDrawn(page, hasFees);
      expect(await pageFaults(page), name).toStrictEqual([]);
      expect(await tablesScrolling(page, "#fee-history"), name).toStrictEqual([]);
      if (name === "longest exact base") {
        // A long fee is exact in any well; a narrow one may break it before its unit.
        await expect(page.locator(".ln-hop__fee").first()).toHaveText(
          /^1\u202F000\u202F000\.099\s+sats$/,
          { useInnerText: true },
        );
      }
      if (!desktop) continue;
      await expect(page.getByRole("heading", { name: "Fee rate over time" })).toHaveCount(
        hasFees ? 1 : 0,
      );
      await expect(page.getByRole("heading", { name: "How it ended" })).toHaveCount(closed ? 1 : 0);
      await expect(page.getByRole("heading", { name: "Fee for this hop" })).toHaveCount(
        closed || name === "no policy either way" ? 0 : 1,
      );
    }
    if (desktop)
      await expect(page.getByRole("link", { name: "975402x1310x1" }).first()).toHaveAttribute(
        "href",
        "/regtest/lightning/channel/975402x1310x1",
      );
  });
}

// The council's last defects: at 200% text on a 320 px phone a figure broke inside its digits,
// and a long name widened the drawing past its panel. 20 and 24 px text sit between the normal
// size and 200%, where a fee once outgrew its well. A test a size and width: each is a visitor of
// its own, under the server's per-client limits, and both widths in one took 22 s of 30 on CI.
for (const text of [20, 24, 32])
  for (const width of [320, 390]) {
    test(`a channel page holds at ${width} px with ${text} px text, in every state, with hostile names`, async ({
      page,
      browserName,
    }) => {
      test.skip(
        browserName !== "chromium",
        "only Chromium lets a test set the browser's text size",
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.setFontSizes", {
        fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
      });
      const answer = await serveChannel(page);
      const faults: string[] = [];
      await page.setViewportSize({ width, height: 800 });
      for (const [name, channel] of Object.entries(channelStates())) {
        answer(channel, feesOf(name));
        await page.goto("/regtest/lightning/channel/811984x2037x0");
        await expect(page.getByRole("heading", { name: "Life of the channel" })).toBeVisible();
        // The section comes with the page's own content, so it is there to count by now.
        await feesDrawn(page, (await page.locator("#fee-history").count()) > 0);
        const found = [
          ...(await pageFaults(page)),
          ...(await tablesScrolling(page, "#fee-history")),
        ];
        faults.push(...found.map((f) => `${name}: ${f}`));
      }
      expect(faults).toStrictEqual([]);
    });
  }

// A fee holds until it changes: the chart steps, and draws nothing across time the server was not
// recording. A node's fee change opens the channel at this chart.
test("a channel's fee steps break at a gap, and a node's fee change lands on them", async ({
  page,
}) => {
  const answer = await serveChannel(page);
  const real = recorded("channel-811984x2037x0");
  answer(real, feeHistory());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/regtest/lightning/channel/811984x2037x0");
  const fees = page.locator("#fee-history");
  const lines = fees.locator(".chart__line");
  await expect(lines).toHaveCount(2);
  for (const d of await lines.evaluateAll((p) => p.map((e) => e.getAttribute("d") ?? ""))) {
    // Two runs, one each side of the gap; within a run only flat and upright strokes.
    expect(d.match(/M/g), d).toHaveLength(2);
    expect(d, d).not.toMatch(/L/);
  }
  await fees.locator(".chart__figures > summary").first().click();
  const table = fees.getByRole("table").first();
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await expect(table.locator("thead th")).toHaveText([
    "Time",
    "Fee rate, ppm",
    "Base fee",
    "Inbound fee",
  ]);
  await expect(page.getByRole("link", { name: "98 fee changes" })).toHaveAttribute(
    "href",
    "#fee-history",
  );

  // From the node's Fees view, a row opens the channel at its fee history.
  await page.unrouteAll();
  const change = {
    id: "811984x2037x0",
    scid: "892785849701564416",
    peer: {
      id: "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025",
      alias: "bfx-lnd0",
    },
    whose: "peer",
    time: 1_794_729_400,
    before: { fee_rate: 1, base_fee_msat: 1000, inbound_fee: null },
    after: { fee_rate: 1, base_fee_msat: 2000, inbound_fee: null },
  };
  await serve(page, {
    ...mainnet(),
    [`nodes/${ACINQ}/fees`]: { changes: [change] },
    "channels/811984x2037x0/fees": feeHistory(),
  });
  await page.goto(`/regtest/lightning/node/${ACINQ}?view=fees`);
  const row = page.getByRole("table", { name: /latest fee changes/ }).locator("tbody tr");
  await expect(row).toContainText("the peer, base fee");
  await expect(row).toContainText("1 sat");
  await row.getByRole("link", { name: "811984x2037x0" }).click();
  await expect(page).toHaveURL(/\/channel\/811984x2037x0#fee-history$/);
  await expect(page.getByRole("heading", { name: "Fee rate over time" })).toBeInViewport();
});
