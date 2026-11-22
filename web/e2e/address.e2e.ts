import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { SILENT_PAYMENT } from "./pages";

const box = (page: Page, label: string) =>
  page.locator(".address-stat", { has: page.getByText(label, { exact: true }) });
/** BTC exact and grouped as the page writes it, its spaces plain: matchers read them alike. */
const btc = (sats: number) => (sats / 1e8).toFixed(8).replace(/(\d\d)(\d{3})(\d{3})$/, "$1 $2 $3");
/** The figure a total shows. */
const stat = (page: Page, label: string) =>
  box(page, label).locator("dd .amount, dd > .num").first();

test("a silent payments address is read in the browser, and its address never sent", async ({
  page,
}) => {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() !== "document" && r.url().toLowerCase().includes("tsp1"))
      sent.push(r.url());
  });
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => {
      if (String(f.payload).toLowerCase().includes("tsp1")) sent.push(String(f.payload));
    });
  });
  await page.goto(`/regtest/address/${SILENT_PAYMENT.toUpperCase()}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Address");
  await expect(page.getByText("Silent payments", { exact: true })).toBeVisible();
  await expect(page.getByText("Silent payments address for Regtest")).toBeVisible();
  const keys = page.locator(".address-sp-fact .hash__text");
  await expect(keys.nth(0)).toHaveText(
    "0220bcfac5b99e04ad1a06ddfb016ee13582609d60b6291e98d01a9bc9a16c96d4",
  );
  await expect(keys.nth(1)).toHaveText(
    "025cc9856d6f8375350e123978daac200c260cb5b5ae83106cab90484dcd8fcf36",
  );
  await page.getByText("How silent payments work").click();
  await expect(page.getByText("The format is defined in BIP352.")).toBeVisible();
  expect(sent).toStrictEqual([]);
});

test("a taproot address shows its totals, history and unspent outputs from the chain", async ({
  page,
}) => {
  await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Address");
  await expect(page.getByText("P2TR", { exact: true })).toBeVisible();
  // Block 106 paid it 1 BTC and block 107 0.49 BTC; the RBF replacement in the mempool pays it 0.25.
  await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC");
  await expect(stat(page, "Received")).toHaveText("1.49 000 000 BTC");
  await expect(stat(page, "Sent")).toHaveText("0.00 000 000 BTC");
  await expect(stat(page, "Transactions")).toHaveText("3");
  await expect(stat(page, "Unconfirmed")).toHaveText("+0.25 000 000 BTC");

  const rows = page.getByRole("table").locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Unconfirmed");
  await expect(rows.nth(0)).toContainText("+0.25 000 000");
  await expect(rows.nth(1)).toContainText("+0.49 000 000");
  await expect(rows.nth(2)).toContainText("+1.00 000 000");

  // Its balance over time: two confirmed steps; the unconfirmed payment stays in the figures above.
  const chart = page.getByRole("slider", { name: "Confirmed balance after each block" });
  await expect(chart).toHaveAttribute("aria-valuemax", "1");
  await expect(chart).toHaveAttribute(
    "aria-valuetext",
    /UTC: Balance 1\.49\s000\s000 BTC, Block 107, Change \+0\.49\s000\s000 BTC$/,
  );
  await chart.press("Home");
  await expect(chart).toHaveAttribute("aria-valuetext", /Balance 1\.00\s000\s000 BTC, Block 106,/);
  await rows.nth(1).getByRole("link").click();
  await expect(page).toHaveURL(`/regtest/tx/${chain.txs.spend_p2sh_p2a}`);
  await page.goBack();

  await page.getByRole("tab", { name: "Unspent outputs" }).click();
  await expect(page).toHaveURL(/\?view=unspent$/);
  const outputs = page.getByRole("table").locator("tbody tr");
  await expect(outputs).toHaveCount(3);
  // Tip 110: the output from block 107 has 4 confirmations, the one from 106 has 5.
  await expect(outputs.nth(0)).toContainText("0.25 000 000");
  await expect(outputs.nth(0)).toContainText("Unconfirmed");
  await expect(outputs.nth(1)).toContainText("0.49 000 000");
  await expect(outputs.nth(1).locator("td").nth(2)).toHaveText("4");
  await expect(outputs.nth(2)).toContainText("1.00 000 000");
  await expect(outputs.nth(2).locator("td").nth(2)).toHaveText("5");

  // A reload keeps the view.
  await page.reload();
  await expect(page.getByRole("tab", { name: "Unspent outputs" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

// An exact readout's length varies from point to point; its room is held for the widest, so
// stepping through the chart never moves it from under the pointer.
test("a balance chart's readout keeps its lines at every point, however long its figures", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "only Chromium lets a test set the browser's text size");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 26 } });
  // Its +0.5 and −0.5 BTC as +1 000.00 000 002 and −0.00 000 002: one long enough to wrap.
  await page.route(/\/regtest\/api\/address\/[^/]+\/txs\/summary/, async (route) => {
    const reply = await route.fetch();
    const rows = (await reply.json()) as { value: number }[];
    for (const r of rows) r.value = r.value > 0 ? 100_000_000_002 : -2;
    await route.fulfill({ response: reply, json: rows });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/regtest/address/${chain.addresses.p2sh}`);
  // The chart loads as it nears the view.
  await page.getByRole("heading", { name: "Balance over time" }).scrollIntoViewIfNeeded();
  const chart = page.getByRole("slider", { name: "Confirmed balance after each block" });
  await expect(chart).toHaveAttribute("aria-valuemax", "1");
  const moved: string[] = [];
  for (let width = 320; width <= 440; width += 4) {
    await page.setViewportSize({ width, height: 900 });
    await chart.press("Home");
    await expect(chart).toHaveAttribute("aria-valuetext", /Change \+1\s000\.00/);
    const first = await chart.evaluate((el) => el.getBoundingClientRect().top);
    await chart.press("End");
    await expect(chart).toHaveAttribute("aria-valuetext", /Change −0\.00/);
    const last = await chart.evaluate((el) => el.getBoundingClientRect().top);
    if (Math.abs(first - last) > 0.5) moved.push(`${width} px: ${first} then ${last}`);
  }
  expect(moved).toStrictEqual([]);
});

test("a spend and a receive net out per transaction", async ({ page }) => {
  await page.goto(`/regtest/address/${chain.addresses.p2sh}`);
  await expect(stat(page, "Balance")).toHaveText("0.00 000 000 BTC");
  await expect(stat(page, "Sent")).toHaveText("0.50 000 000 BTC");
  const rows = page.getByRole("table").locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("−0.50 000 000");
  await expect(rows.nth(1)).toContainText("+0.50 000 000");
  await page.getByRole("tab", { name: "Unspent outputs" }).click();
  await expect(page.getByText("No unspent outputs")).toBeVisible();
});

test("unconfirmed payments are marked and agree with the node's own figures", async ({
  page,
  request,
}) => {
  const address = chain.addresses.p2wpkh;
  const stats = (await (await request.get(`/regtest/api/address/${address}`)).json()) as {
    mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  };
  const summary = (await (
    await request.get(`/regtest/api/address/${address}/txs/summary`)
  ).json()) as { txid: string; value: number }[];
  await page.goto(`/regtest/address/${address}`);
  await expect(stat(page, "Balance")).toHaveText("91.00 000 000 BTC");
  const pending = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum;
  await expect(stat(page, "Unconfirmed")).toHaveText(`+${btc(pending)} BTC`);

  // The node's summary lists confirmed transactions with this address's net value in each.
  const rows = page.getByRole("table").locator("tbody tr");
  await expect(rows).toHaveCount(summary.length + stats.mempool_stats.tx_count);
  await expect(rows.filter({ hasText: "Unconfirmed" })).toHaveCount(stats.mempool_stats.tx_count);
  for (const s of summary) {
    const row = rows.filter({ has: page.locator(`a[href$="${s.txid}"]`) });
    // The unit is hidden from sight, in the header, but read out with the number.
    await expect(row.locator("td").nth(2)).toHaveText(`+${btc(s.value)} BTC`);
  }
});

test("history pages 25 confirmed transactions at a time", async ({ page }) => {
  // The miner script has 113 confirmed transactions: the scenario's coinbases and change.
  await page.goto(`/regtest/address/${chain.addresses.miner}`);
  const confirmed = page
    .getByRole("table")
    .locator("tbody tr")
    .filter({ hasNotText: "Unconfirmed" });
  await expect(confirmed).toHaveCount(25);
  const more = page.getByRole("button", { name: "Show 25 more" });
  for (const n of [50, 75, 100, 113]) {
    await more.click();
    await expect(confirmed).toHaveCount(n);
  }
  await expect(more).toHaveCount(0);
  await expect(confirmed.last()).toContainText("+50.00 000 000");
});

test("an address of another network and a malformed one are named as such", async ({ page }) => {
  await page.goto("/regtest/address/bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  await expect(page.getByText("This is a Mainnet address")).toBeVisible();
  await expect(page.getByText("This server does not serve Mainnet.")).toBeVisible();

  await page.goto("/regtest/address/bcrt1qnotanaddress");
  await expect(page.getByText("This is not a valid address")).toBeVisible();
});

// The live line (or "Not live" and why) once sat over the address's second line on a phone.
test("the live line never sits on the address, however many lines the address takes", async ({
  page,
}) => {
  for (const address of [chain.addresses.p2wpkh, chain.addresses.p2tr]) {
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/regtest/address/${address}`);
      const live = page.locator(".address-live");
      await expect(live).toBeVisible();
      const a = await page.locator(".address-head .hash--full").boundingBox();
      const b = await live.boundingBox();
      if (!a || !b) throw new Error("missing address or live line");
      expect(b.y, `${address.slice(0, 6)} at ${width} px`).toBeGreaterThanOrEqual(a.y + a.height);
    }
  }
});

// An address above the node's cap: address-large.e2e.ts.

// Totals are exact, to the satoshi, with a copy button beside each.
test("a total reads exact, on one line on a phone, with its copy button", async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    for (const label of ["Balance", "Received", "Sent"]) {
      const figure = stat(page, label);
      await expect(figure).toHaveText(/^[\d.\s\u202F]+ BTC$/);
      // Number and unit share one line.
      const lines = await figure.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      });
      expect(lines, `${label} at ${width} px`).toBe(1);
    }
  }
  const balance = box(page, "Balance");
  await expect(balance.locator(".address-total .amount")).toHaveText("1.49 000 000 BTC");
  await balance.getByRole("button", { name: "Copy the exact balance" }).click();
  await expect(balance.locator(".copy__note")).toHaveText("Copied");
});

test.describe("an address page's requests", () => {
  // The refusals below are the test's own, which the browser logs as failed loads.
  test.use({ consoleErrorsAllowed: [/status of 429/] });

  test("asks once for each part, and not again when the live status arrives", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith("/regtest/api/address/")) asked.push(path);
    });
    // The address topic's first message: the status a refetch would follow.
    const topic = `"address:${chain.addresses.p2tr.toLowerCase()}"`;
    let heard = false;
    page.on("websocket", (ws) =>
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string" && payload.includes(topic)) heard = true;
      }),
    );
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(3);
    // The first status starts the watch; the page has just asked, so it does not ask again. A
    // moment after it is heard is long enough for a request it set off to go out.
    await expect.poll(() => heard).toBe(true);
    await page.waitForTimeout(300);
    const totals = asked.filter((p) => p === `/regtest/api/address/${chain.addresses.p2tr}`);
    expect(totals).toHaveLength(1);
  });

  test("a refusal reads as busy, retried, and never as an error", async ({ page }) => {
    let refused = 0;
    await page.route(/\/regtest\/api\/address\/[^/]+$/, async (route) => {
      if (refused < 2) {
        refused++;
        await route.fulfill({
          status: 429,
          headers: { "retry-after": "1" },
          json: { error: "too many requests" },
        });
      } else await route.continue();
    });
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    await expect(
      page.getByText("The server is busy for a moment, so this page is waiting"),
    ).toBeVisible();
    await expect(stat(page, "Balance")).toHaveText("1.49 000 000 BTC", { timeout: 15_000 });
    await expect(page.getByText(/busy for a moment/)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

// An address that wraps once left a last line of two characters; its lines are balanced now.
test("a wrapped address breaks into lines of even length", async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    const text = page.locator("h1 + * .hash__text, .address-head .hash__text").first();
    await expect(text).toBeVisible();
    const widths = await text.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].map((r) => r.width).filter((w) => w > 0);
    });
    if (widths.length < 2) continue;
    const first = widths[0] ?? 0;
    const last = widths.at(-1) ?? 0;
    expect(last, `last line at ${width} px`).toBeGreaterThan(first / 3);
  }
});
