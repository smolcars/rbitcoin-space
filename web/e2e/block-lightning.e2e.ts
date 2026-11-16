// The block page's Lightning panel (docs/DESIGN.md "Lightning"), from stubbed answers since regtest
// has no Lightning: closed and open, at a desktop's and a phone's width in both schemes, from the
// keyboard, nothing without Lightning or with a graph still syncing, and the layout and targets at
// large text on a touch screen. The whole sweep runs with E2E_SWEEP=1, as fonts.e2e.ts does.
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { lightningOn, pageFaults } from "./lightning-answers";
import { smallTargets } from "./targets";

const HASH = chain.blocks[106] ?? "";
const keyOf = (n: number) => `02${n.toString(16).padStart(64, "0")}`;
/** Names made to break a row: 32 bytes of one wide letter, right to left, emoji, none, a key. */
const NAMES = [
  "﷽﷽﷽﷽﷽﷽﷽﷽﷽﷽",
  "عقدةالبرقالسريعة‮",
  "⚡🐙🦀⚡🐙🦀⚡🐙",
  null,
  "0256ccca46170ff4b1ef0256ccca4617",
  "OpenMarketSquare.com",
];
const chan = (n: number, capacity: number) => ({
  id: `16777215x${16_777_000 + n}x65535`,
  scid: String(18_446_744_073_709_000_000 + n),
  capacity,
  node_one: { id: keyOf(n), alias: NAMES[n % NAMES.length] ?? null },
  node_two: { id: keyOf(n + 1), alias: NAMES[(n + 1) % NAMES.length] ?? null },
});
const KINDS = ["force", "penalty", "cooperative", "other", "cooperative"];
/** 140 opened, 12 of them sent, the largest a channel can be; five closes, one of each kind. */
const ANSWER = {
  opened: {
    count: 140,
    capacity: 2_100_000_000_000_000,
    channels: Array.from({ length: 12 }, (_, i) => chan(i, i < 4 ? 1_000_000_000 : 16_777_215)),
  },
  closed: {
    count: 5,
    forced: 2,
    channels: KINDS.map((kind, i) => Object.assign(chan(20 + i, 4_000_000 - i), { kind })),
  },
};
// The total is 21 million BTC: the longest figure the line can hold, its unit kept beside it.
const SUMMARY =
  /^Lightning in this block: 140 channels opened \(21\u202F000\u202F000\u202FBTC\), 5\u00A0closed \(2\u00A0forced\)$/;

async function serveBlock(page: Page, answer: unknown = ANSWER, status = 200) {
  await lightningOn(page);
  await page.route(/\/regtest\/app\/lightning\/block\//, (route) =>
    route.fulfill({ status, json: answer, headers: { "retry-after": "1" } }),
  );
}

/** The panel: the checks look at it alone, as the block page's own rules cover the rest. */
const PANEL = "details.blk-ln";
const summary = (page: Page) => page.locator("details.blk-ln > summary");

async function open(page: Page) {
  await page.goto(`/regtest/block/${HASH}`);
  await expect(summary(page)).toHaveText(SUMMARY);
}

/** Two frames, so what a resize redraws has redrawn. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );

test("the panel is one closed line that opens to the channels, at a desktop's and a phone's width", async ({
  page,
}) => {
  await serveBlock(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const panel = page.locator("details.blk-ln");
  await expect(panel).not.toHaveAttribute("open");
  await expect(panel.getByRole("table")).toBeHidden();
  // Under the facts, above the map and the transactions.
  const order = await page.evaluate(() => {
    const at = (s: string) => document.querySelector(s)?.getBoundingClientRect().top ?? -1;
    return [at(".block-side"), at("details.blk-ln"), at(".block-core"), at(".block-txs")];
  });
  expect(order[1]).toBeGreaterThan(order[0] ?? 0);
  expect(order[3]).toBeGreaterThan(order[1] ?? 0);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(() => {
      const top = (s: string) => document.querySelector(s)?.getBoundingClientRect().top ?? -1;
      return top("details.blk-ln") < top(".block-core");
    }),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await summary(page).click();
  const table = panel.getByRole("table", { name: "Channels this block opened and closed" });
  await expect(table.locator("tbody tr")).toHaveCount(17);
  await expect(table.locator("tbody tr").nth(12)).toContainText("Force");
  await expect(table.locator("tbody tr").nth(13)).toContainText("Penalty");
  await expect(panel).toContainText("Public channels only. 128 smaller not listed.");
  for (const [width, scheme] of [
    [1280, "light"],
    [1280, "dark"],
    [390, "dark"],
    [390, "light"],
    [320, "light"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    expect(await pageFaults(page, PANEL), `${width} px, ${scheme}`).toStrictEqual([]);
  }
  // A phone gets cards, every channel there too.
  await expect(panel.locator(".blk-ln__card")).toHaveCount(17);
  await summary(page).click();
  await expect(panel).not.toHaveAttribute("open");
});

test("the panel opens and closes from the keyboard, its links next in order", async ({ page }) => {
  await serveBlock(page);
  await open(page);
  await summary(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("details.blk-ln")).toHaveAttribute("open");
  await page.keyboard.press("Tab");
  await expect(page.locator("details.blk-ln .ln-id").first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Space");
  await expect(page.locator("details.blk-ln")).not.toHaveAttribute("open");
});

test("a network without Lightning asks nothing, and the page shows no panel", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/app/lightning/")) asked.push(r.url());
  });
  await page.goto(`/regtest/block/${HASH}`);
  await expect(page.getByRole("table", { name: "Transactions in this block" })).toBeVisible();
  await expect(page.locator("main [aria-busy='true'], main .skel")).toHaveCount(0);
  expect(asked).toStrictEqual([]);
  await expect(page.locator(".blk-ln")).toHaveCount(0);
});

test.describe("a graph still syncing", () => {
  test.use({ consoleErrorsAllowed: [/status of 503/] });
  test("shows the block and no panel", async ({ page }) => {
    let asked = 0;
    await serveBlock(page, { error: "lightning graph is still syncing; retry" }, 503);
    page.on("request", (r) => {
      if (r.url().includes("/app/lightning/block/")) asked++;
    });
    await page.goto(`/regtest/block/${HASH}`);
    await expect(page.getByRole("table", { name: "Transactions in this block" })).toBeVisible();
    await expect.poll(() => asked).toBeGreaterThan(0);
    await expect(page.locator(".blk-ln")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Block 106$/);
  });
});

const SWEEP = process.env["E2E_SWEEP"] === "1";
const WIDTHS = SWEEP ? [320, 390, 768, 1024, 1280, 1440] : [320, 390, 1024];
const TEXT = SWEEP ? [16, 20, 24, 32] : [20, 32];

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const text of TEXT) {
    test(`the open panel holds its layout and targets with ${text} px text`, async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "only Chromium lets a test set the text size");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.setFontSizes", {
        fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
      });
      await serveBlock(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page);
      const faults: string[] = [];
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 844 });
        await settle(page);
        // The panel opened (the check opens it), its summary wrapping within the window.
        // The block's own facts already run past 320 px at 32 px text, with or without the panel:
        // there the page's sideways scroll is theirs, and the panel is held inside the window.
        const already = await page.evaluate((panel) => {
          const d = document.querySelector<HTMLElement>(panel);
          if (d) d.style.display = "none";
          const wide = document.documentElement.scrollWidth > document.documentElement.clientWidth;
          if (d) d.style.display = "";
          return wide;
        }, PANEL);
        for (const f of await pageFaults(page, PANEL)) {
          if (!(already && f === "the page scrolls sideways")) faults.push(`${width} px: ${f}`);
        }
        await settle(page);
        if (width <= 390) {
          for (const f of await smallTargets(page, ".blk-ln")) faults.push(`${width} px: ${f}`);
        }
        // A card's name is cut only when it already takes the card's whole width.
        const cut = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".blk-ln__card .ln-node__name")]
            .filter((n) => {
              const card = n.closest(".blk-ln__card")?.getBoundingClientRect().width ?? 0;
              return (
                n.scrollWidth > n.clientWidth + 1 && n.getBoundingClientRect().width < card - 2
              );
            })
            .map((n) => n.textContent ?? ""),
        );
        for (const name of cut) faults.push(`${width} px: "${name}" cut with room to spare`);
      }
      expect(faults).toStrictEqual([]);
    });
  }
});
