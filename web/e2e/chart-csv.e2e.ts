// Every chart's "Download CSV": the file comes through the browser's download (a `blob:` link the
// page's CSP allows) and holds the chart's raw numbers, its text kept from being a formula.
import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";

/** Presses the chart's control and reads the file the browser saved. */
async function download(page: Page, within: Locator): Promise<{ name: string; rows: string[] }> {
  const control = within.getByRole("button", { name: /^Download CSV: / });
  await expect(control).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent("download"), control.click()]);
  const path = await file.path();
  const text = await readFile(path, "utf8");
  expect(text.endsWith("\r\n")).toBe(true);
  return { name: file.suggestedFilename(), rows: text.slice(0, -2).split("\r\n") };
}

const TIME = '"Time (UTC, ISO 8601)","Unix time (s)"';
const today = () => new Date().toISOString().slice(0, 10);

/** Each row's ISO time is its unix time. */
function timesAgree(rows: readonly string[]) {
  for (const row of rows) {
    const [iso = "", unix = ""] = row.split(",");
    expect(new Date(JSON.parse(iso) as string).getTime(), row).toBe(Number(unix) * 1000);
  }
}

test("an address's balance chart downloads its steps in sats, with each block and change", async ({
  page,
}) => {
  await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
  const section = page.getByRole("region", { name: "Balance over time" });
  await expect(
    page.getByRole("slider", { name: "Confirmed balance after each block" }),
  ).toBeVisible();
  const { name, rows } = await download(page, section);
  expect(name).toBe(`rbitcoin-regtest-confirmed-balance-after-each-block-${today()}.csv`);
  // Block 106 paid it 1 BTC and block 107 0.49 BTC.
  expect(rows[0]).toBe(`${TIME},"Balance (sat)","Block","Change (sat)"`);
  expect(rows.slice(1).map((r) => r.split(",").slice(2).join(","))).toStrictEqual([
    "100000000,106,100000000",
    "149000000,107,49000000",
  ]);
  timesAgree(rows.slice(1));
});

test("the fee rates chart downloads its bands as low and high columns", async ({ page }) => {
  await page.goto("/regtest/mining?period=all");
  const section = page.getByRole("region", { name: "Blocks over time" });
  await section.getByRole("button", { name: "Fee rates" }).click();
  const chart = page.getByRole("slider", { name: /Fee rates paid in blocks/ });
  await expect(chart).toBeVisible({ timeout: 30_000 });
  const { name, rows } = await download(page, section);
  expect(name).toBe(`rbitcoin-regtest-fee-rates-paid-in-blocks-all-time-${today()}.csv`);
  expect(rows[0]).toBe(
    `${TIME},"Median (sat/vB)","10th to 90th percentile, low (sat/vB)","10th to 90th percentile, high (sat/vB)","25th to 75th percentile, low (sat/vB)","25th to 75th percentile, high (sat/vB)"`,
  );
  expect(rows.length).toBe(Number(await chart.getAttribute("aria-valuemax")) + 2);
  timesAgree(rows.slice(1));
  // Every cell after the times is a bare number or a gap, low never above high.
  for (const row of rows.slice(1)) {
    const cells = row.split(",").slice(2);
    expect(cells, row).toHaveLength(5);
    for (const c of cells) expect(c, row).toMatch(/^(-?\d+(\.\d+)?(e[+-]\d+)?)?$/);
    const [, lo80, hi80, lo50, hi50] = cells.map(Number);
    expect(lo80 ?? 0, row).toBeLessThanOrEqual(hi80 ?? 0);
    expect(lo50 ?? 0, row).toBeLessThanOrEqual(hi50 ?? 0);
  }
});

test("a pool's own name, which its miner chose, names the pool page's file in safe characters only", async ({
  page,
}) => {
  const hostile = '=HYPERLINK("x")/../../Ünïcode <b>Pool</b>';
  await page.route(/\/api\/v1\/mining\/pool\/unknown$/, async (route) => {
    const real = (await (await route.fetch()).json()) as { pool: Record<string, unknown> };
    await route.fulfill({ json: { ...real, pool: { ...real.pool, name: hostile } } });
  });
  // Regtest stores no weeks for it: two of them, a week apart.
  await page.route(/\/api\/v1\/mining\/pool\/unknown\/hashrate$/, (route) =>
    route.fulfill({
      json: [
        { timestamp: 1_790_000_000, avgHashrate: 1e18, share: 0.25, poolName: hostile },
        { timestamp: 1_790_604_800, avgHashrate: 2.5e18, share: 0.5, poolName: hostile },
      ],
    }),
  );
  await page.goto("/regtest/mining/pool/unknown");
  const chart = page.getByRole("slider", { name: /share of blocks and hashrate, week by week$/ });
  await expect(chart).toBeVisible({ timeout: 30_000 });
  const { name, rows } = await download(page, page.locator("figure", { has: chart }));
  expect(name).toBe(
    `rbitcoin-regtest-hyperlink-x-unicode-b-pool-b-share-of-blocks-and-hashrate-week-by-week-${today()}.csv`,
  );
  expect(rows[0]).toBe(`${TIME},"Share of blocks (0-1)","Hashrate (H/s)"`);
  expect(rows.slice(1)).toStrictEqual([
    '"2026-09-21T14:13:20Z",1790000000,0.25,1000000000000000000',
    '"2026-09-28T14:13:20Z",1790604800,0.5,2500000000000000000',
  ]);
});
