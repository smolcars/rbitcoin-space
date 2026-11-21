// The address page as of a past block (`?at=<height>`, docs/FRONTEND.md "An address as of a
// block"), on the scenario's fixed chain: the P2SH address was paid 0.5 BTC in block 106 and spent
// it in block 107, the P2WPKH address was paid 91 BTC in block 106 and has two payments waiting.
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { freshAddress, gate } from "./regtest";

// Refusals and failures these tests make on purpose.
test.use({ consoleErrorsAllowed: [/status of (404|502|503|504)/] });

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
  await expect(band(page)).toContainText("Mined 1 Jan 2026, 17:40:00 UTC");
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

  // The next block spent it, and the view stays as the reader left it.
  await band(page).getByRole("button", { name: "Block 107" }).click();
  await expect(page).toHaveURL(/\?at=107&view=unspent$/);
  await expect(band(page).getByRole("heading")).toHaveText("As of block 107");
  await expect(page.getByText("No unspent outputs at this block")).toBeVisible();
  await expect(stat(page, "Balance")).toHaveText("0.00 000 000 BTC");
  await expect(stat(page, "Sent")).toHaveText("0.50 000 000 BTC");
  await expect(stat(page, "Transactions")).toHaveText("2");

  // Before it was first used, said in words, not an empty page.
  await band(page).getByRole("button", { name: "Block 106" }).click();
  await band(page).getByRole("button", { name: "Block 105" }).click();
  await expect(page).toHaveURL(/\?at=105/);
  await expect(page.getByText("Not used yet at block 105")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("nothing live reaches the page as of a block", async ({ page }) => {
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
  expect(unpinned).toStrictEqual([]);

  // Back to now: the live page, which follows the address and shows what waits.
  await band(page).getByRole("button", { name: "Back to now" }).click();
  await expect(page).toHaveURL(`/regtest/address/${address}`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(rows(page).first()).toContainText("Unconfirmed");
});

test("a block is picked by height or date, kept in the URL and across a reload", async ({
  page,
}) => {
  const p2tr = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${p2tr}`);
  const open = page.getByRole("button", { name: "As of a block" });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.click();
  const field = page.getByLabel("Block height or date");
  await field.fill("nonsense");
  await field.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "That is neither a block height nor a date. Try 840000 or 2024-04-20.",
  );
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await field.fill("106");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page).toHaveURL(`/regtest/address/${p2tr}?at=106`);
  await expect(stat(page, "Balance")).toHaveText("1.00 000 000 BTC");
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
});

test("a height past the tip and a parameter that is no height are said plainly", async ({
  page,
}) => {
  const p2tr = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${p2tr}?at=5000`);
  await expect(page.getByText("Block 5 000 has not been mined yet")).toBeVisible();
  await expect(page.getByText(/The newest block is 1\d\d\./)).toBeVisible();
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
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(`/api/address/${address}`)) asked.push(r.url());
  });
  await page.goto(`/regtest/address/${address}?at=108`);
  await expect(page.getByText("Totals at block 108 are not kept for this address")).toBeVisible();
  await expect(
    page.getByText("Transactions at this block are not kept for this address"),
  ).toBeVisible();
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

test("the block field and the band fit a 320 px phone without a sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const wide = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
  await page.goto(`/regtest/address/${chain.addresses.p2wsh}`);
  await page.getByRole("button", { name: "As of a block" }).click();
  await expect(page.getByLabel("Block height or date")).toBeVisible();
  expect(await wide()).toBe(false);
  await page.goto(`/regtest/address/${chain.addresses.p2wsh}?at=106`);
  await band(page).getByRole("button", { name: "Another block" }).click();
  await expect(page.getByLabel("Block height or date")).toHaveValue("106");
  expect(await wide()).toBe(false);
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

test("next is offered at the tip, and a step past it says the block is not mined yet", async ({
  page,
}) => {
  const tip = chain.tip.height;
  let lookups = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === `/regtest/api/block-height/${tip + 1}`) lookups++;
  });
  await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=${tip}`);
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
  await band(page)
    .getByRole("button", { name: `Block ${tip + 1}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`\\?at=${tip + 1}$`));
  await expect(page.getByText(`Block ${tip + 1} has not been mined yet`)).toBeVisible();
  // The lookup, then once more after a tip short of it: never more.
  expect(lookups).toBe(2);
  await expect(page.getByText(`The newest block is ${tip}.`)).toBeVisible();
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

test("a date's lookup survives a move to another spelling of the same address", async ({
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
  const address = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${address.toUpperCase()}`);
  await page.getByRole("button", { name: "As of a block" }).click();
  await page.getByLabel("Block height or date").fill("2026-01-01 17:35");
  await page.getByLabel("Block height or date").press("Enter");
  await expect(page.getByRole("button", { name: "Looking up…" })).toBeVisible();
  const search = page.getByRole("search").getByRole("combobox", { name: "Search" });
  await search.fill(address);
  await search.press("Enter");
  await expect(page).toHaveURL(`/regtest/address/${address}`);
  open();
  // Block 105 is the newest by 17:35 on 1 Jan 2026.
  await expect(page).toHaveURL(`/regtest/address/${address}?at=105`);
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
  await band(page).getByRole("button", { name: "Block 108" }).click();
  await expect(band(page).getByRole("heading")).toHaveText("As of block 108");
  await expect(rows(page)).toHaveCount(25);
  await page.getByRole("button", { name: "Show 25 more" }).click();
  await expect(rows(page)).toHaveCount(50);
  await page.getByRole("tab", { name: "Unspent outputs" }).click();
  await expect(rows(page).first()).toBeVisible();
  await expect(chart).toBeVisible();

  expect(seen.filter((s) => s.want === at108).length).toBeGreaterThan(3);
  expect(seen.filter((s) => s.asof !== s.want)).toStrictEqual([]);
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
