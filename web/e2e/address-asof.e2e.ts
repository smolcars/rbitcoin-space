// The address page as of a past block (`?at=<height>`, docs/FRONTEND.md "An address as of a
// block"), on the scenario's fixed chain: the P2SH address was paid 0.5 BTC in block 106 and spent
// it in block 107, the P2WPKH address was paid 91 BTC in block 106 and has two payments waiting.
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { freshAddress, gate } from "./regtest";

// Refusals and failures these tests make on purpose.
test.use({ consoleErrorsAllowed: [/status of (404|429|500|502|503|504)/] });

const stat = (page: Page, label: string) =>
  page
    .locator(".address-stat", { has: page.getByText(label, { exact: true }) })
    .locator("dd .amount, dd > .num")
    .first();
const band = (page: Page) =>
  page.getByRole("region", { name: /^As of block|is not a block height/ });
const rows = (page: Page) => page.getByRole("table").locator("tbody tr");

test("the address as of a block shows its figures, history and coins then", async ({ page }) => {
  const p2sh = chain.addresses.p2sh;
  await page.goto(`/regtest/address/${p2sh}?at=106`);
  await expect(band(page).getByRole("heading")).toHaveText("As of block 106");
  await expect(band(page).getByRole("link", { name: "106" })).toHaveAttribute(
    "href",
    `/regtest/block/${chain.blocks[106]}`,
  );
  // Block 106 is at 2026-01-01T00:00:00Z plus 106 × 10 minutes.
  await expect(band(page)).toContainText("Mined 1 Jan 2026, 17:40 UTC");
  await expect(stat(page, "Balance")).toHaveText("0.50 000 000 BTC");
  await expect(stat(page, "Received")).toHaveText("0.50 000 000 BTC");
  await expect(stat(page, "Sent")).toHaveText("0.00 000 000 BTC");
  await expect(stat(page, "Transactions")).toHaveText("1");
  await expect(page.getByText("At block 106", { exact: true })).toBeVisible();
  await expect(page.getByText("Unconfirmed", { exact: true })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("+0.50 000 000");
  const chart = page.getByRole("slider", { name: "Confirmed balance after each block" });
  await expect(chart).toHaveAttribute("aria-valuetext", /Balance 0\.50\s000\s000 BTC, Block 106,/);
  // Counted at block 106, not at the tip: one confirmation.
  await page.getByRole("tab", { name: "Unspent outputs" }).click();
  await expect(page).toHaveURL(/\?at=106&view=unspent$/);
  await expect(page.getByRole("columnheader", { name: "Confirmations then" })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("0.50 000 000");
  await expect(rows(page).first().locator("td").last()).toHaveText("1");

  // Its history now reaches back to 106, so the next change is known: 107, which spent it.
  await expect(page.getByText("Now 0.00 000 000 BTC, 1 transaction later")).toBeVisible();
  // Each row's date and time, not an age counted from today.
  await page.getByRole("tab", { name: "Transactions" }).click();
  await expect(rows(page).first()).toContainText("1 Jan 2026, 17:40 UTC");
  await expect(rows(page).first()).not.toContainText("ago");
  await page.getByRole("tab", { name: "Unspent outputs" }).click();

  // The next change spent it, and the view stays as the reader left it.
  await band(page).getByRole("button", { name: "Next change: block 107" }).press("Enter");
  await expect(band(page).getByRole("heading")).toBeFocused();
  await expect(page).toHaveURL(/\?at=107&view=unspent$/);
  await expect(band(page).getByRole("heading")).toHaveText("As of block 107");
  await expect(page.getByText("No unspent outputs at this block")).toBeVisible();
  await expect(stat(page, "Balance")).toHaveText("0.00 000 000 BTC");
  await expect(stat(page, "Sent")).toHaveText("0.50 000 000 BTC");
  await expect(stat(page, "Transactions")).toHaveText("2");

  // Nothing changed since: no step forward, and the line under the balance says so.
  await expect(page.getByText("The same now: no transaction since")).toBeVisible();
  await expect(band(page).getByRole("button", { name: /^Next change/ })).toHaveCount(0);

  // Back a change, then before its first transaction, said in words, not an empty page.
  await band(page).getByRole("button", { name: "Previous change: block 106" }).click();
  await expect(band(page).getByRole("heading")).toHaveText("As of block 106");
  await band(page).getByRole("button", { name: "Before first use: block 105" }).click();
  await expect(page).toHaveURL(/\?at=105/);
  await expect(page.getByText("Not used yet at block 105")).toBeVisible();
  await expect(page.getByText("It has 2 confirmed transactions now.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  // Every earlier block shows the same, so no step back; forward, its first use.
  await expect(band(page).getByRole("button", { name: /^‹|Previous change|Before/ })).toHaveCount(
    0,
  );
  // Forward from the notice too, and focus lands on the band's heading, read as the new page.
  await page
    .locator(".address-notice")
    .getByRole("button", { name: "First used at block 106" })
    .click();
  await expect(band(page).getByRole("heading")).toBeFocused();
  await expect(page).toHaveURL(/\?at=106/);
});

test("nothing live reaches the page as of a block, but one look at the address now", async ({
  page,
}) => {
  const address = chain.addresses.p2wpkh;
  const topics: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => {
      if (String(f.payload).includes(address)) topics.push(String(f.payload));
    });
  });
  const unpinned: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    const asks = /\/(api|app)\/address\//.test(u.pathname) && u.pathname.includes(address);
    if (asks && !u.searchParams.has("asof")) {
      unpinned.push(u.pathname + u.search);
    }
  });
  await page.goto(`/regtest/address/${address}?at=110`);
  await expect(stat(page, "Balance")).toHaveText("91.00 000 000 BTC");
  // Its payments waiting in the mempool are left out: no row, no figure.
  await expect(rows(page)).toHaveCount(2);
  for (const row of await rows(page).all()) await expect(row).not.toContainText("Unconfirmed");
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(topics).toStrictEqual([]);
  // The totals now and, when it changed since, the newest history page, once each, for the line
  // under the balance and the next change: never the figures, coins or history shown.
  const now = [`/regtest/api/address/${address}`, `/regtest/api/address/${address}/txs/summary`];
  expect(unpinned.filter((u) => !now.includes(u))).toStrictEqual([]);
  expect(new Set(unpinned).size).toBe(unpinned.length);
  expect(unpinned).toContain(now[0]);

  // Back to now: the live page, which follows the address and shows what waits.
  await band(page).getByRole("button", { name: "Back to now" }).press("Enter");
  await expect(page).toHaveURL(`/regtest/address/${address}`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  // Its button went with the past page: focus goes to the way back there.
  await expect(page.getByRole("button", { name: "As of a block" })).toBeFocused();
  await expect(rows(page).first()).toContainText("Unconfirmed");
});

test.describe("the block field, in the wide stand-in font", () => {
  test("a block is picked by height or date, kept in the URL and across a reload", async ({
    page,
  }) => {
    const p2tr = chain.addresses.p2tr;
    await page.goto(`/regtest/address/${p2tr}`);
    await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
    const open = page.getByRole("button", { name: "As of a block" });
    await expect(open).toHaveAttribute("aria-expanded", "false");
    const totals = page.locator(".address-totals");
    const before = await totals.boundingBox();
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    const field = page.getByLabel("Block height or date");
    // At a desktop's width it opens over the page, just under its button and flush with its right
    // edge, and takes focus: nothing on the page moves.
    await expect(field).toBeFocused();
    expect(await totals.boundingBox()).toStrictEqual(before);
    const pop = page.getByRole("group", { name: "This address at a past block" });
    const [b, p] = [await open.boundingBox(), await pop.boundingBox()];
    if (!b || !p) throw new Error("the button or its field has no box");
    expect(p.y - (b.y + b.height)).toBeGreaterThanOrEqual(0);
    expect(p.y - (b.y + b.height)).toBeLessThan(16);
    expect(Math.abs(p.x + p.width - (b.x + b.width))).toBeLessThan(2);
    // Escape closes it, and so does its close button; either gives focus back to the button.
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await expect(open).toBeFocused();
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.click();
    await pop.getByRole("button", { name: "Close" }).click();
    await expect(pop).toBeHidden();
    await expect(open).toBeFocused();
    await open.click();
    await field.fill("nonsense");
    await field.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      "That is neither a block height nor a date. Try 840000 or 2024-04-20.",
    );
    await expect(field).toHaveAttribute("aria-invalid", "true");
    // A day still to come is said as a height past the tip is, naming the newest block.
    await field.fill("2030-01-01");
    await field.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      new RegExp(`^1 Jan 2030 has not come yet\\. The newest block is ${chain.tip.height}\\.$`),
    );
    await expect(
      page.getByRole("button", { name: `Show block ${chain.tip.height}` }),
    ).toBeVisible();
    await field.fill("106");
    await field.press("Enter");
    await expect(page).toHaveURL(`/regtest/address/${p2tr}?at=106`);
    await expect(stat(page, "Balance")).toHaveText("1.00 000 000 BTC");
    // The field went with the live page: focus is on the band's heading, not lost to the body.
    await expect(band(page).getByRole("heading")).toBeFocused();
    await page.reload();
    await expect(band(page).getByRole("heading")).toHaveText("As of block 106");
    await expect(stat(page, "Balance")).toHaveText("1.00 000 000 BTC");
    // Back goes to the live page it came from.
    await page.goBack();
    await expect(page).toHaveURL(`/regtest/address/${p2tr}`);

    // A date: the newest block by the end of that day, UTC. The scenario's blocks all fall on
    // 1 Jan 2026, block 105 at 17:30.
    await page.goto(`/regtest/address/${p2tr}?at=107`);
    await band(page).getByRole("button", { name: "Another block" }).click();
    await expect(page.getByLabel("Block height or date")).toHaveValue("107");
    await page.getByLabel("Block height or date").fill("2026-01-01 17:35");
    await page.getByLabel("Block height or date").press("Enter");
    await expect(page).toHaveURL(`/regtest/address/${p2tr}?at=105`);
    await expect(page.getByText("Not used yet at block 105")).toBeVisible();
    await expect(band(page).getByRole("heading")).toBeFocused();
  });
});

test("a height past the tip and a parameter that is no height are said plainly", async ({
  page,
}) => {
  const p2tr = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${p2tr}?at=5000`);
  // Said in the band itself, the band's width: no second card.
  await expect(band(page)).toContainText(/Not mined yet\. The newest block is 1\d\d\./);
  await expect(page.locator(".address-notice")).toHaveCount(0);
  await expect(page.locator(".address-stats")).toHaveCount(0);

  await page.goto(`/regtest/address/${p2tr}?at=yesterday`);
  await expect(band(page).getByRole("heading")).toHaveText("“yesterday” is not a block height");
  await expect(page.locator(".address-stats")).toHaveCount(0);
  await band(page).getByRole("button", { name: "Back to now" }).click();
  await expect(page).toHaveURL(`/regtest/address/${p2tr}`);
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
});

/** Answers the pinned totals of `address` with `status` and the server's error text. */
async function refuseTotals(page: Page, address: string, status: number, error: string) {
  await page.route(
    (url) => url.pathname === `/regtest/api/address/${address}` && url.searchParams.has("asof"),
    (route) => route.fulfill({ status, json: { error } }),
  );
}

test("a large address, kept or not, says what it cannot show as of a block", async ({ page }) => {
  const address = chain.addresses.p2pkh;
  await refuseTotals(page, address, 503, "address history too large for this server");
  await page.goto(`/regtest/address/${address}?at=108`);
  await expect(page.getByText("This address is not shown as of a past block")).toBeVisible();
  await expect(
    page.getByText(
      "This server does not add this address up, so at a past block it shows no totals, confirmed transactions or coins for it.",
    ),
  ).toBeVisible();
  // It says what the server established at a past block: nothing of the node, nor of the live
  // page, which lists the address's unconfirmed transactions.
  await expect(page.getByText(/node will add up|at any block|otherwise/)).toHaveCount(0);
  await expect(page.locator(".address-stats")).toHaveCount(0);

  await page.unrouteAll();
  const notKept = "unspent outputs and older history are not kept for an address this large";
  await refuseTotals(page, address, 503, notKept);
  await page.route(
    (url) => url.pathname === `/regtest/api/address/${address}/txs/chain`,
    (route) => route.fulfill({ status: 503, json: { error: notKept } }),
  );
  // Its newest history is refused too while the server does not keep it whole: for good.
  await page.route(
    (url) => url.pathname === `/regtest/api/address/${address}/txs/summary`,
    (route) =>
      route.fulfill({ status: 503, json: { error: "address history too large for this server" } }),
  );
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(`/api/address/${address}`)) asked.push(r.url());
  });
  await page.goto(`/regtest/address/${address}?at=108`);
  await expect(page.getByText("Totals at block 108 are not kept for this address")).toBeVisible();
  await expect(
    page.getByText("Transactions at this block are not kept for this address"),
  ).toBeVisible();
  // A refusal that will never change offers no step and nothing to try again.
  await expect(band(page).getByRole("button", { name: /Next change|Previous change/ })).toHaveCount(
    0,
  );
  await expect(band(page).getByText(/could not be looked up/)).toHaveCount(0);
  // A refusal of that kind is not "busy": it is not asked again.
  await page.waitForTimeout(1500);
  expect(asked.filter((u) => new URL(u).pathname.endsWith(address))).toHaveLength(1);
});

test("a block that left the best chain is said, and looked up again on request", async ({
  page,
}) => {
  const address = chain.addresses.p2tr;
  let gone = true;
  await page.route(
    (url) => url.pathname === `/regtest/api/address/${address}/txs/chain`,
    (route) =>
      gone ? route.fulfill({ status: 404, json: { error: "not found" } }) : route.continue(),
  );
  await page.goto(`/regtest/address/${address}?at=107`);
  await expect(page.getByText("Block 107 is no longer on the best chain")).toBeVisible();
  gone = false;
  await page.getByRole("button", { name: "Show block 107 as it is now" }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
});

test("a failing or slow node is said, with a way to try again", async ({ page }) => {
  const address = chain.addresses.p2tr;
  let fail = true;
  await page.route(
    (url) => url.pathname.endsWith("/regtest/api/block-height/107"),
    (route) =>
      fail ? route.fulfill({ status: 502, json: { error: "upstream error" } }) : route.continue(),
  );
  await page.goto(`/regtest/address/${address}?at=107`);
  await expect(page.getByText("Could not look up block 107")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");

  await page.unrouteAll();
  await page.route(
    (url) => url.pathname === `/regtest/api/address/${address}` && url.searchParams.has("asof"),
    (route) => route.fulfill({ status: 504, json: { error: "request timed out" } }),
  );
  await page.goto(`/regtest/address/${address}?at=107`);
  await expect(page.getByText("Could not load this address")).toBeVisible();
  await expect(page.getByText("Request timed out.")).toBeVisible();
});

test("the copy and QR buttons keep working as of a block", async ({ page }) => {
  const address = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${address}?at=106`);
  await expect(stat(page, "Balance")).toHaveText("1.00 000 000 BTC");
  await page.getByRole("button", { name: "Show the address as a QR code" }).click();
  const dialog = page.getByRole("dialog", { name: "Scan the address" });
  await expect(dialog.locator(".qr-pop__text")).toHaveText(address);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy address" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
});

test.describe("in the wide stand-in font", () => {
  /** How many rows the band's controls take: their distinct foot lines. */
  const rowsOf = (page: Page) =>
    band(page)
      .locator(".address-asof__actions button")
      .evaluateAll(
        (all) =>
          new Set(
            all
              .filter((b) => b.getBoundingClientRect().width > 0 && !b.closest(".address-asof-pop"))
              .map((b) => Math.round(b.getBoundingClientRect().bottom)),
          ).size,
      );
  const wide = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );

  test("on a phone the block field opens in the page and the band leaves the balance on the first screen", async ({
    page,
  }) => {
    for (const [width, height] of [
      [360, 780],
      [320, 720],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/regtest/address/${chain.addresses.p2wsh}`);
      const open = page.getByRole("button", { name: "As of a block" });
      const live = page.getByText("Live", { exact: true });
      await expect(live).toBeVisible();
      // On the live line's row, not a row of its own.
      const [o, l] = [await open.boundingBox(), await live.boundingBox()];
      if (!o || !l) throw new Error("the button or the live line has no box");
      expect(Math.abs(o.y + o.height / 2 - (l.y + l.height / 2))).toBeLessThan(12);
      await open.click();
      await expect(page.getByLabel("Block height or date")).toBeFocused();
      // In the page under the row, and the balance after it.
      const pop = await page
        .getByRole("group", { name: "This address at a past block" })
        .boundingBox();
      const totals = await page.locator(".address-totals").boundingBox();
      if (!pop || !totals) throw new Error("the field or the totals have no box");
      expect(pop.y).toBeGreaterThanOrEqual(o.y + o.height);
      expect(totals.y).toBeGreaterThanOrEqual(pop.y + pop.height);
      expect(await wide(page)).toBe(false);
      // Escape for a pop-up opened over it (the QR code) closes that one only.
      await page.getByRole("button", { name: "Show the address as a QR code" }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Scan the address" })).toBeHidden();
      await expect(page.getByLabel("Block height or date")).toBeVisible();
      // Turned to a desktop's width it would float with nothing to close it: it closes instead.
      await page.setViewportSize({ width: 1280, height });
      await expect(page.getByLabel("Block height or date")).toBeHidden();
      await page.setViewportSize({ width, height });

      await page.goto(`/regtest/address/${chain.addresses.p2wsh}?at=106`);
      const balance = stat(page, "Balance");
      await expect(balance).toBeVisible();
      const box = await balance.boundingBox();
      expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual(height);
      await band(page).getByRole("button", { name: "Another block" }).click();
      await expect(page.getByLabel("Block height or date")).toHaveValue("106");
      await expect(page.getByLabel("Block height or date")).toBeFocused();
      expect(await wide(page)).toBe(false);

      // All four controls, both steps known (the miner changes in every block), in one row.
      await page.goto(`/regtest/address/${chain.addresses.miner}?at=107`);
      await expect(band(page).getByRole("button", { name: /^Next change/ })).toBeEnabled();
      await expect(band(page).getByRole("button", { name: /^Previous change/ })).toBeEnabled();
      // The arrows say what they step between, in plain text over them, not one block.
      const steps = band(page).getByRole("group", { name: "Changes" });
      await expect(steps.getByText("Changes", { exact: true })).toBeVisible();
      await expect(steps.getByRole("button")).toHaveCount(2);
      expect(await rowsOf(page)).toBe(1);
      // A short band: the heading, the block's time, one line and the controls.
      expect((await band(page).boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(190);
    }
  });

  test("with 24 px text on a 320 px phone the controls take two rows at most", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`/regtest/address/${chain.addresses.miner}?at=107`);
    // Larger text as a reader sets it: the root size every rem on the site follows.
    await page.evaluate(() => document.documentElement.style.setProperty("font-size", "24px"));
    await expect(band(page).getByRole("button", { name: /^Next change/ })).toBeEnabled();
    expect(await rowsOf(page)).toBeLessThanOrEqual(2);
    expect(await wide(page)).toBe(false);
  });

  test("at a desktop's width the band is one row", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/regtest/address/${chain.addresses.p2sh}?at=106`);
    await expect(band(page).getByRole("button", { name: /^Next change/ })).toBeEnabled();
    const [box, heading, last] = [
      await band(page).boundingBox(),
      await band(page).getByRole("heading").boundingBox(),
      await band(page).getByRole("button", { name: "Another block" }).boundingBox(),
    ];
    if (!box || !heading || !last) throw new Error("the band has no box");
    expect(box.height).toBeLessThanOrEqual(100);
    // The controls beside the heading, at the band's right.
    expect(Math.abs(last.y + last.height / 2 - (box.y + box.height / 2))).toBeLessThan(12);
    expect(box.x + box.width - (last.x + last.width)).toBeLessThan(40);
  });
});

test("a date's lookup still running when the reader moves to another address is dropped", async ({
  page,
}) => {
  const { open, shut } = gate();
  await page.route(
    (url) => url.pathname.startsWith("/regtest/api/v1/mining/blocks/timestamp/"),
    async (route) => {
      await shut;
      await route.continue().catch(() => undefined);
    },
  );
  await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
  await page.getByRole("button", { name: "As of a block" }).click();
  await page.getByLabel("Block height or date").fill("2026-01-01");
  await page.getByLabel("Block height or date").press("Enter");
  await expect(page.getByRole("button", { name: "Looking up…" })).toBeVisible();
  // Within the app, to another address: the router keeps the header's field mounted.
  const search = page.getByRole("search").getByRole("combobox", { name: "Search" });
  await search.fill(chain.addresses.p2sh);
  await search.press("Enter");
  await expect(page).toHaveURL(`/regtest/address/${chain.addresses.p2sh}`);
  // The answer is let through (or its request was already dropped): either way, not applied.
  open();
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(`/regtest/address/${chain.addresses.p2sh}`);
});

test("the snapshot never waits on the tip, which is read only to name the newest block", async ({
  page,
}) => {
  const { open, shut } = gate();
  let tipAsked = 0;
  await page.route(
    (url) => url.pathname === "/regtest/api/blocks/tip/height",
    async (route) => {
      tipAsked++;
      await shut;
      await route.continue().catch(() => undefined);
    },
  );
  try {
    await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=107`);
    await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
    await expect(rows(page)).toHaveCount(2);
    expect(tipAsked).toBe(0);
  } finally {
    open();
  }
});

test("a height not found while the tip already reaches it is looked up again", async ({ page }) => {
  // The lookup misses, then the block is there: mined between the two answers.
  let misses = 1;
  await page.route(
    (url) => url.pathname === "/regtest/api/block-height/107",
    (route) =>
      misses-- > 0
        ? route.fulfill({ status: 404, json: { error: "not found" } })
        : route.continue(),
  );
  await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=107`);
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
  await expect(page.getByText("has not been mined yet")).toHaveCount(0);
});

test("at the tip nothing changed since, and a block past it says it is not mined yet", async ({
  page,
}) => {
  const tip = chain.tip.height;
  let lookups = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === `/regtest/api/block-height/${tip + 1}`) lookups++;
  });
  await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=${tip}`);
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
  await expect(page.getByText("The same now: no transaction since")).toBeVisible();
  await expect(band(page).getByRole("button", { name: /^Next change/ })).toHaveCount(0);
  await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=${tip + 1}`);
  await expect(band(page)).toContainText(`Not mined yet. The newest block is ${tip}.`);
  // The lookup, then once more after a tip short of it: never more.
  expect(lookups).toBe(2);
  // Not a dead end: straight back to the address as of the newest block.
  await band(page)
    .getByRole("button", { name: `Show block ${tip}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`\\?at=${tip}$`));
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
});

test("a height not found, with a tip that cannot be read, is a failed lookup with Try again", async ({
  page,
}) => {
  let fail = true;
  await page.route(
    (url) => url.pathname === "/regtest/api/block-height/107",
    (route) =>
      fail ? route.fulfill({ status: 404, json: { error: "not found" } }) : route.continue(),
  );
  await page.route(
    (url) => url.pathname === "/regtest/api/blocks/tip/height",
    (route) =>
      fail ? route.fulfill({ status: 502, json: { error: "upstream error" } }) : route.continue(),
  );
  await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=107`);
  await expect(page.getByText("Could not look up block 107")).toBeVisible();
  await expect(page.getByText(/has not been mined yet/)).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
});

test("a height that keeps missing while the tip reaches it is a failed lookup, not a future block", async ({
  page,
}) => {
  let lookups = 0;
  await page.route(
    (url) => url.pathname === "/regtest/api/block-height/107",
    (route) => {
      lookups++;
      return route.fulfill({ status: 404, json: { error: "not found" } });
    },
  );
  await page.route(
    (url) => url.pathname === "/regtest/api/blocks/tip/height",
    (route) => route.fulfill({ contentType: "text/plain", body: "107" }),
  );
  await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=107`);
  await expect(page.getByText("Could not look up block 107")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText(/has not been mined yet/)).toHaveCount(0);
  expect(lookups).toBe(3);
});

test("a date's lookup is dropped by any move the reader makes after it, even to another spelling of the address", async ({
  page,
}) => {
  const { open, shut } = gate();
  const stamp = (url: URL) => url.pathname.startsWith("/regtest/api/v1/mining/blocks/timestamp/");
  await page.route(stamp, async (route) => {
    await shut;
    await route.continue().catch(() => undefined);
  });
  const address = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${address.toUpperCase()}`);
  await page.getByRole("button", { name: "As of a block" }).click();
  await page.getByLabel("Block height or date").fill("2026-01-01 17:35");
  // The move below ends the lookup itself, before any answer is let through.
  const dropped = page.waitForEvent("requestfailed", (r) => stamp(new URL(r.url())));
  await page.getByLabel("Block height or date").press("Enter");
  await expect(page.getByRole("button", { name: "Looking up…" })).toBeVisible();
  const search = page.getByRole("search").getByRole("combobox", { name: "Search" });
  await search.fill(address);
  await search.press("Enter");
  await expect(page).toHaveURL(`/regtest/address/${address}`);
  await dropped;
  open();
  // The same page under its other spelling, so the field is still there, idle and ready again.
  await expect(page.getByRole("button", { name: "Show", exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/regtest/address/${address}`);
});

test("an empty history as of a block says only what had confirmed by it", async ({ page }) => {
  await page.goto(`/regtest/address/${freshAddress()}?at=${chain.tip.height}`);
  await expect(
    page.getByText(
      `No transaction paying or spending this address had confirmed by block ${chain.tip.height}.`,
    ),
  ).toBeVisible();
  await expect(page.getByText(/came later|will show here|never been used/)).toHaveCount(0);

  // A kept address whose list as of the block is empty.
  const address = chain.addresses.p2pkh;
  const notKept = "unspent outputs and older history are not kept for an address this large";
  await refuseTotals(page, address, 503, notKept);
  await page.route(
    (url) => url.pathname === `/regtest/api/address/${address}/txs/chain`,
    (route) => route.fulfill({ json: [] }),
  );
  await page.goto(`/regtest/address/${address}?at=108`);
  await expect(page.getByText("No transactions by block 108")).toBeVisible();
  await expect(
    page.getByText("No transaction paying or spending this address had confirmed by block 108."),
  ).toBeVisible();
  await expect(page.getByText(/never been used|will show here/)).toHaveCount(0);
  // The notice promises the list under both of the server's conditions, not one.
  await expect(page.getByText(/keeps its whole history and this block is among/)).toBeVisible();
});

test("every address read carries the one resolved hash, paged and after a change of block", async ({
  page,
}) => {
  const address = chain.addresses.miner;
  const hashOf = async (h: number) =>
    (await (await page.request.get(`/regtest/api/block-height/${h}`)).text()).trim();
  const [at107, at108] = [await hashOf(107), await hashOf(108)];
  let want = at107;
  const seen: { url: string; asof: string | null; want: string }[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (/^\/regtest\/(api|app)\/address\//.test(u.pathname) && u.pathname.includes(address)) {
      seen.push({ url: u.pathname + u.search, asof: u.searchParams.get("asof"), want });
    }
  });
  await page.goto(`/regtest/address/${address}?at=107`);
  await expect(rows(page)).toHaveCount(25);
  await page.getByRole("button", { name: "Show 25 more" }).click();
  await expect(rows(page)).toHaveCount(50);
  const chart = page.getByRole("slider", { name: /^Confirmed balance after each block/ });
  await expect(chart).toBeVisible();
  const paged = seen.filter((s) => /\/txs\/chain\/[0-9a-f]{64}/.test(s.url));
  expect(paged.length).toBeGreaterThan(0);

  want = at108;
  // The miner is paid in every block: its next change is the next block.
  await band(page).getByRole("button", { name: "Next change: block 108" }).click();
  await expect(band(page).getByRole("heading")).toHaveText("As of block 108");
  await expect(rows(page)).toHaveCount(25);
  await page.getByRole("button", { name: "Show 25 more" }).click();
  await expect(rows(page)).toHaveCount(50);
  await page.getByRole("tab", { name: "Unspent outputs" }).click();
  await expect(rows(page).first()).toBeVisible();
  await expect(chart).toBeVisible();

  expect(seen.filter((s) => s.want === at108).length).toBeGreaterThan(3);
  // All but the page's one look at the address now: its totals, then its newest history as of
  // the tip those totals were stamped with.
  const now = (s: { url: string; asof: string | null }) =>
    (s.url === `/regtest/api/address/${address}` && s.asof === null) ||
    (s.url.startsWith(`/regtest/api/address/${address}/txs/summary?`) && s.asof === chain.tip.hash);
  expect(seen.filter((s) => s.asof !== s.want && !now(s))).toStrictEqual([]);
});

test("a block found between its lookup and a cached tip short of it is shown, not called unmined", async ({
  page,
}) => {
  // The first lookup misses; the tip, as the server's one-second cache may give it, is one below;
  // the block is there by the next lookup.
  let lookups = 0;
  await page.route(
    (url) => url.pathname === "/regtest/api/block-height/107",
    (route) =>
      ++lookups === 1
        ? route.fulfill({ status: 404, json: { error: "not found" } })
        : route.continue(),
  );
  await page.route(
    (url) => url.pathname === "/regtest/api/blocks/tip/height",
    (route) => route.fulfill({ contentType: "text/plain", body: "106" }),
  );
  await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=107`);
  await expect(band(page).getByRole("heading")).toHaveText("As of block 107");
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
  await expect(page.getByText(/has not been mined yet/)).toHaveCount(0);
  expect(lookups).toBe(2);
});

test("a step the server refuses to work out says so, and comes once it answers", async ({
  page,
}) => {
  // P2SH: paid in block 106, spent in 107, so as of 106 its next change is 107.
  const address = chain.addresses.p2sh;
  // The lookup's page only, as of the tip: not the chart's, which is as of block 106.
  const summary = (url: URL) =>
    url.pathname === `/regtest/api/address/${address}/txs/summary` &&
    url.searchParams.get("asof") !== chain.blocks[106];
  // The retry's back-off runs on a clock the test drives, stopped from the start: no retry can
  // come before the test moves it on.
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1000);
  // Busy (429): asked again as the server says, while the band says why the step waits.
  await page.route(summary, (route) =>
    route.fulfill({ status: 429, headers: { "retry-after": "1" }, json: { error: "slow down" } }),
  );
  await page.goto(`/regtest/address/${address}?at=106`);
  const next = band(page).getByRole("button", { name: /^Next change/ });
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(band(page)).toContainText(
    "The server is busy, so the next change is still being looked up.",
  );
  await page.unroute(summary);
  // Past the back-off (lib/api.ts, retryDelay: at most 2.5 s for the first retries).
  await page.clock.runFor(5000);
  await expect(band(page).getByRole("button", { name: "Next change: block 107" })).toBeEnabled();
  await expect(band(page).getByText(/still being looked up/)).toHaveCount(0);

  // Failed outright: said, with a way to ask again, never a button greyed for good.
  await page.route(summary, (route) =>
    route.fulfill({ status: 500, json: { error: "upstream error" } }),
  );
  await page.goto(`/regtest/address/${address}?at=106`);
  await expect(band(page)).toContainText("The next change could not be looked up: Upstream error");
  await expect(band(page).getByRole("button", { name: /^Next change/ })).toHaveCount(0);
  await page.unroute(summary);
  await band(page).getByRole("button", { name: "Try again" }).click();
  await expect(band(page).getByRole("button", { name: "Next change: block 107" })).toBeEnabled();

  // Answered 404 once, the tip unchanged: Try again reads the totals again first, with nothing to
  // retry and no step meanwhile, then the history once, for the tip they give, though unchanged.
  let lookups = 0;
  await page.route(summary, (route) =>
    ++lookups === 1
      ? route.fulfill({ status: 404, json: { error: "not found" } })
      : route.continue(),
  );
  const totals = gate();
  let totalsAsked = 0;
  await page.route(
    (url) => url.pathname === `/regtest/api/address/${address}` && !url.searchParams.has("asof"),
    async (route) => {
      if (++totalsAsked > 1) await totals.shut;
      await route.continue().catch(() => undefined);
    },
  );
  await page.goto(`/regtest/address/${address}?at=106`);
  await expect(band(page)).toContainText("The next change could not be looked up");
  await band(page).getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => totalsAsked).toBe(2);
  await expect(band(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(band(page).getByRole("button", { name: /^Next change/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(lookups).toBe(1);
  totals.open();
  await expect(band(page).getByRole("button", { name: "Next change: block 107" })).toBeEnabled();
  expect(lookups).toBe(2);
});

test("before a long history's first transaction, its first use is found from the chart's pages", async ({
  page,
}) => {
  // The miner is paid in nearly every block: more history than one page of 25.
  const address = chain.addresses.miner;
  const pages: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith(`/regtest/api/address/${address}/txs/summary`))
      pages.push(u.pathname);
  });
  await page.goto(`/regtest/address/${address}?at=0`);
  await expect(page.getByText("Not used yet at block 0")).toBeVisible();
  const first = page
    .locator(".address-notice")
    .getByRole("button", { name: /^First used at block \d+$/ });
  await expect(first).toBeVisible();
  expect(pages.length).toBeGreaterThan(1);
  await first.click();
  await expect(page.getByText(/Not used yet/)).toHaveCount(0);
  await expect(stat(page, "Transactions")).toHaveText("1");
});

test("asking for the block already shown closes the field and leaves no focus request behind", async ({
  page,
}) => {
  const address = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${address}?at=105`);
  await page.goto(`/regtest/address/${address}?at=106`);
  await expect(stat(page, "Balance")).toHaveText("1.00 000 000 BTC");
  await band(page).getByRole("button", { name: "Another block" }).click();
  const field = page.getByLabel("Block height or date");
  await expect(field).toHaveValue("106");
  await field.press("Enter");
  // Nothing to navigate to: the field closes and focus goes to the band's heading.
  await expect(field).toBeHidden();
  await expect(band(page).getByRole("heading")).toBeFocused();
  // No request left over for a later arrival: back, then forward to this block, takes no focus.
  await page.goBack();
  await expect(page).toHaveURL(/\?at=105$/);
  await page.goForward();
  await expect(band(page).getByRole("heading")).toHaveText("As of block 106");
  await expect(band(page).getByRole("heading")).not.toBeFocused();
});

test("a block chosen while a move elsewhere is under way lands on this address, never on that page", async ({
  page,
}) => {
  const address = chain.addresses.p2tr;
  const chunk = gate();
  const lookups: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/regtest/api/v1/mining/blocks/timestamp/")) {
      lookups.push(r.url());
    }
  });
  const visited: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) visited.push(f.url());
  });
  await page.goto(`/regtest/address/${address}?at=107`);
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
  // The block page's code is held, so the move there stays under way.
  await page.route(/\/assets\/BlockPage-[\w-]+\.js$/, async (route) => {
    await chunk.shut;
    await route.continue().catch(() => undefined);
  });
  await band(page).getByRole("button", { name: "Another block" }).click();
  const field = page.getByLabel("Block height or date");
  await expect(field).toBeFocused();
  const held = page.waitForRequest(/\/assets\/BlockPage-[\w-]+\.js$/);
  await band(page).getByRole("link", { name: "107" }).press("Enter");
  await held;
  // A later choice, made while that move waits: this address at the block the date names.
  await field.fill("2026-01-01 17:35");
  await field.press("Enter");
  await expect(page).toHaveURL(`/regtest/address/${address}?at=105`);
  await expect(band(page).getByRole("heading")).toHaveText("As of block 105");
  // The held code arrives and runs before the last look, and the router has had its turn after
  // it: a late commit to the block would show by then.
  const arrived = page.waitForResponse(/\/assets\/BlockPage-[\w-]+\.js$/);
  chunk.open();
  const code = await arrived;
  await code.finished();
  await page.evaluate(async (url) => {
    await import(url);
    await new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 50));
    });
  }, code.url());
  await expect(page).toHaveURL(`/regtest/address/${address}?at=105`);
  expect(lookups).toHaveLength(1);
  // Built from this address's own path: no page of another kind ever carried `at`.
  expect(visited.filter((u) => u.includes("/block/") && u.includes("at="))).toStrictEqual([]);
});

test("a link followed while a date is looked up is where the reader lands, not the date's block", async ({
  page,
}) => {
  const address = chain.addresses.p2tr;
  const chunk = gate();
  const lookup = gate();
  const stamp = (url: URL) => url.pathname.startsWith("/regtest/api/v1/mining/blocks/timestamp/");
  const visited: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) visited.push(f.url());
  });
  await page.goto(`/regtest/address/${address}?at=107`);
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
  // Both held: the date's answer, and the block page's code, so each waits on the test's word.
  await page.route(stamp, async (route) => {
    await lookup.shut;
    await route.continue().catch(() => undefined);
  });
  await page.route(/\/assets\/BlockPage-[\w-]+\.js$/, async (route) => {
    await chunk.shut;
    await route.continue().catch(() => undefined);
  });
  await band(page).getByRole("button", { name: "Another block" }).click();
  const field = page.getByLabel("Block height or date");
  const asked = page.waitForRequest((r) => stamp(new URL(r.url())));
  await field.fill("2026-01-01 17:35");
  await field.press("Enter");
  const request = await asked;
  // The move below ends the lookup itself, while its answer is still held back.
  const dropped = page.waitForEvent("requestfailed", (r) => r === request);
  // The later choice: the band's link to the block, followed while the date is still looked up.
  const held = page.waitForRequest(/\/assets\/BlockPage-[\w-]+\.js$/);
  await band(page).getByRole("link", { name: "107" }).press("Enter");
  await held;
  await dropped;
  lookup.open();
  chunk.open();
  await expect(page).toHaveURL(/\/regtest\/block\/[0-9a-f]{64}$/);
  expect(visited.filter((u) => u.includes("at=105"))).toStrictEqual([]);
});

/**
 * A date looked up on the address page and a transaction searched in the header, both held, the
 * answer of the choice made `first` let through first: the page must land where the later choice
 * leads, whichever answers first.
 */
async function dateAndSearch(page: Page, first: "date" | "search") {
  const address = chain.addresses.p2tr;
  const tx = chain.txs.payment;
  const lookup = gate();
  const probe = gate();
  const stamp = (url: URL) => url.pathname.startsWith("/regtest/api/v1/mining/blocks/timestamp/");
  const probing = (url: URL) => url.pathname === `/regtest/api/tx/${tx}/status`;
  const visited: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) visited.push(f.url());
  });
  await page.goto(`/regtest/address/${address}`);
  await expect(stat(page, "Balance")).toBeVisible();
  await page.route(stamp, async (route) => {
    await lookup.shut;
    await route.continue().catch(() => undefined);
  });
  await page.route(probing, async (route) => {
    await probe.shut;
    await route.continue().catch(() => undefined);
  });
  const field = page.getByLabel("Block height or date");
  const search = page.getByRole("search").getByRole("combobox", { name: "Search" });
  const date = async () => {
    if (!(await field.isVisible())) {
      await page.getByRole("button", { name: "As of a block" }).click();
    }
    const asked = page.waitForRequest((r) => stamp(new URL(r.url())));
    await field.fill("2026-01-01 17:35");
    await field.press("Enter");
    await asked;
  };
  const find = async () => {
    const asked = page.waitForRequest((r) => probing(new URL(r.url())));
    await search.fill(tx);
    await search.press("Enter");
    await asked;
  };
  // The field opened before either choice, so the order below is the order of the choices.
  await page.getByRole("button", { name: "As of a block" }).click();
  await (first === "date" ? date() : find());
  await (first === "date" ? find() : date());
  // The older choice's answer comes first, in full, and moves nothing.
  const older = first === "date" ? lookup : probe;
  const answered = page.waitForResponse((r) =>
    (first === "date" ? stamp : probing)(new URL(r.url())),
  );
  older.open();
  await (await answered).finished();
  // Its control is idle again: the date's button reads Show, the search no longer looks up.
  const idle =
    first === "date"
      ? page.getByRole("button", { name: "Show", exact: true })
      : page.getByRole("search").getByText("Looking up");
  await expect(idle).toHaveCount(first === "date" ? 1 : 0);
  // Then the later one's.
  (first === "date" ? probe : lookup).open();
  if (first === "date") {
    await expect(page).toHaveURL(`/regtest/tx/${tx}`);
    await expect(page.getByRole("heading", { level: 1, name: "Transaction" })).toBeVisible();
    expect(visited.filter((u) => u.includes("at="))).toStrictEqual([]);
  } else {
    await expect(page).toHaveURL(`/regtest/address/${address}?at=105`);
    await expect(band(page).getByRole("heading")).toHaveText("As of block 105");
    expect(visited.filter((u) => u.includes("/tx/"))).toStrictEqual([]);
  }
}

test("a search in the header made while a date is looked up wins, even when the date answers first", async ({
  page,
}) => {
  await dateAndSearch(page, "date");
});

test("a date asked while a header search waits wins, even when the search answers first", async ({
  page,
}) => {
  await dateAndSearch(page, "search");
});

test("after Back within the same address, the open field still submits", async ({ page }) => {
  const address = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${address.toUpperCase()}`);
  const search = page.getByRole("search").getByRole("combobox", { name: "Search" });
  await search.fill(address);
  await search.press("Enter");
  await expect(page).toHaveURL(`/regtest/address/${address}`);
  await page.getByRole("button", { name: "As of a block" }).click();
  await page.goBack();
  await expect(page).toHaveURL(`/regtest/address/${address.toUpperCase()}`);
  const field = page.getByLabel("Block height or date");
  await field.fill("106");
  await field.press("Enter");
  await expect(page).toHaveURL(`/regtest/address/${address.toUpperCase()}?at=106`);
  await expect(band(page).getByRole("heading")).toHaveText("As of block 106");
});

test("a present that cannot be compared, or a lookup that fails partway, never states a false fact", async ({
  page,
}) => {
  const p2sh = chain.addresses.p2sh;
  const totals = (address: string) => (url: URL) =>
    url.pathname === `/regtest/api/address/${address}` && !url.searchParams.has("asof");
  const stats = (tx: number, funded: number, spent: number) => ({
    chain_stats: {
      tx_count: tx,
      funded_txo_count: 1,
      funded_txo_sum: funded,
      spent_txo_count: spent > 0 ? 1 : 0,
      spent_txo_sum: spent,
    },
    mempool_stats: {
      tx_count: 0,
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
    },
  });
  /** A reply stamped as the server stamps one: the tip it is as of. */
  const stamped = (tip: { hash: string; height: number }) => ({
    "x-bitcoin-chain-tip": tip.hash,
    "x-bitcoin-chain-tip-height": String(tip.height),
  });
  // A current answer stamped above block 107 with fewer transactions: from another chain.
  await page.route(totals(p2sh), (route) =>
    route.fulfill({ json: stats(1, 50_000_000, 0), headers: stamped(chain.tip) }),
  );
  await page.goto(`/regtest/address/${p2sh}?at=107`);
  await expect(stat(page, "Transactions")).toHaveText("2");
  // The pending step goes once the totals now are in and the gate has ruled on them.
  await expect(band(page).getByRole("button", { name: /^Next change/ })).toHaveCount(0);
  await expect(band(page).getByRole("button", { name: /^Previous change/ })).toBeEnabled();
  await expect(page.locator(".address-stat__more")).toHaveCount(0);
  await expect(page.getByText(/later|The same now/)).toHaveCount(0);
  await expect(band(page).getByRole("button", { name: /^Next change/ })).toHaveCount(0);
  await page.unrouteAll();

  // The gate's other refusals, on P2TR before its first use at block 106: a reply with no stamp,
  // and one stamped with another block at the chosen height. Neither is counted, and neither has
  // its history asked.
  const p2tr = chain.addresses.p2tr;
  const asked: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.includes(`/address/${p2tr}/txs/summary`)) asked.push(r.url());
  });
  for (const headers of [{}, stamped({ hash: "c".repeat(64), height: 105 })]) {
    await page.route(totals(p2tr), (route) =>
      route.fulfill({ json: stats(2, 149_000_000, 0), headers }),
    );
    await page.goto(`/regtest/address/${p2tr}?at=105`);
    await expect(page.getByText("Not used yet at block 105")).toBeVisible();
    // Ruled on once the step waiting for the totals now is gone.
    await expect(band(page).getByRole("button", { name: /^Next change|First used/ })).toHaveCount(
      0,
    );
    await expect(page.getByText(/confirmed transactions? now|None has since/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /First used/ })).toHaveCount(0);
    await page.unrouteAll();
  }
  expect(asked).toStrictEqual([]);

  // Before the miner's first transaction its history is read page by page; one that fails is a
  // failed lookup, offered again, never "further back than the newest 200".
  const miner = chain.addresses.miner;
  const later = (url: URL) => url.pathname.startsWith(`/regtest/api/address/${miner}/txs/summary/`);
  await page.route(later, (route) =>
    route.fulfill({ status: 504, json: { error: "request timed out" } }),
  );
  await page.goto(`/regtest/address/${miner}?at=0`);
  await expect(band(page)).toContainText("The next change could not be looked up");
  await expect(page.getByText(/further back/)).toHaveCount(0);
  await page.unrouteAll();
  await band(page).getByRole("button", { name: "Try again" }).click();
  await expect(band(page).getByRole("button", { name: /^First used at block \d+$/ })).toBeEnabled();

  // More history now than the lookup reads: said at once, with nothing read to learn it.
  const pages: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.includes(`/address/${miner}/txs/summary`)) pages.push(r.url());
  });
  await page.route(totals(miner), (route) =>
    route.fulfill({ json: stats(250, 5_000_000_000, 0), headers: stamped(chain.tip) }),
  );
  await page.goto(`/regtest/address/${miner}?at=0`);
  await expect(page.getByText("It has 250 confirmed transactions now.")).toBeVisible();
  await expect(page.getByText(/further back than the newest 200/)).toBeVisible();
  expect(pages).toStrictEqual([]);
});

test("focus goes to the block arrived at last, whichever page settles first", async ({ page }) => {
  const address = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${address}?at=107`);
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
  // Frames are held, so anything that waits on one cannot run until both moves are made.
  await page.evaluate(() => {
    const held: FrameRequestCallback[] = [];
    (window as unknown as { heldFrames: FrameRequestCallback[] }).heldFrames = held;
    window.requestAnimationFrame = (frame) => held.push(frame);
  });
  for (const at of ["105", "106"]) {
    await band(page).getByRole("button", { name: "Another block" }).click();
    await page.getByLabel("Block height or date").fill(at);
    await page.getByLabel("Block height or date").press("Enter");
    await expect(band(page).getByRole("heading")).toHaveText(`As of block ${at}`);
  }
  await page.evaluate(() => {
    for (const frame of (window as unknown as { heldFrames: FrameRequestCallback[] }).heldFrames) {
      frame(performance.now());
    }
  });
  await expect(band(page).getByRole("heading")).toBeFocused();
});
