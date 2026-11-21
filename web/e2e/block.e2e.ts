import { chain, expect, test } from "./fixtures";

// Fee facts of old blocks are computed on demand; the server may answer "busy" (503) or "slow down"
// (429) while other tests use the same client's allowance. The page retries those quietly, but the
// browser still logs each refused request.
test.use({ consoleErrorsAllowed: [/status of (429|503)/] });

test("a block by height shows its facts and transactions, and steps to its neighbours", async ({
  page,
}) => {
  await page.goto("/regtest/block/106");
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("Block 106");
  await expect(page.getByText(chain.blocks[106].slice(0, 8))).toBeVisible();
  // The harness's miner claims the 50 BTC subsidy (regtest halves every 150 blocks) and leaves
  // the block's 1 152 sats of fees unclaimed; the page says so rather than showing no fees.
  await expect(
    page.getByText("0.00 001 152 BTC less than the subsidy and fees allowed"),
  ).toBeVisible();
  const rows = page.getByRole("table", { name: "Transactions in this block" }).getByRole("row");
  await expect(rows).toHaveCount(4); // header, coinbase, script_types, consolidation
  await expect(page.getByRole("cell", { name: "Coinbase" })).toBeVisible();
  // The unit is in the header for sight and in the cell for screen readers.
  await expect(page.getByRole("cell", { name: "50.00 000 000 BTC", exact: true })).toBeVisible();

  await page.getByRole("link", { name: /^Next: 107/ }).click();
  await expect(title).toHaveText("Block 107");
  await page.getByRole("link", { name: /^← Previous: 106/ }).click();
  await expect(title).toHaveText("Block 106");
  await expect(page).toHaveURL(`/regtest/block/${chain.blocks[106]}`);
});

test("a block from before the server started says it has no audit", async ({ page }) => {
  await page.goto(`/regtest/block/${chain.blocks[106]}`);
  await expect(
    page
      .getByRole("region", { name: "Audit" })
      .getByText("Not audited: we were not watching when this block arrived", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Match rate", { exact: true })).toHaveCount(0);
});

test("the genesis and newest blocks say so", async ({ page }) => {
  await page.goto("/regtest/block/0");
  await expect(page.getByText("Genesis block")).toBeVisible();
  await page.goto(`/regtest/block/${chain.tip.hash}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Block ${chain.tip.height}`);
  await expect(page.getByText("The newest block")).toBeVisible();
});

test.describe("missing blocks", () => {
  test.use({ consoleErrorsAllowed: [/status of (404|429|503)/] });

  test("an unknown hash and a height above the tip are explained", async ({ page }) => {
    await page.goto(`/regtest/block/${"ab".repeat(32)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Block not found");
    await page.goto("/regtest/block/5000");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("No block 5 000 yet");
  });
});

test("the blocks list pages back and forward", async ({ page }) => {
  await page.goto("/regtest/blocks");
  const firstHeight = page.getByRole("table").getByRole("row").nth(1).getByRole("link").first();
  await expect(firstHeight).toHaveText(String(chain.tip.height));
  // A block this server never audited reads a dash in "Match rate", and "no audit" aloud. A phone
  // drops the column.
  const headers = await page.getByRole("columnheader").allTextContents();
  const match = headers.indexOf("Match rate, %");
  if (!test.info().project.name.endsWith("-phone")) expect(match).toBeGreaterThanOrEqual(0);
  if (match !== -1) {
    const cell = page.getByRole("table").getByRole("row").nth(1).getByRole("cell").nth(match);
    await expect(cell).toHaveText("–no audit");
    await expect(cell.locator(".visually-hidden")).toHaveText("no audit");
  }
  await page.getByRole("link", { name: /Older/ }).click();
  // 25 to a page.
  await expect(page).toHaveURL(`/regtest/blocks/${chain.tip.height - 25}`);
  await expect(firstHeight).toHaveText(String(chain.tip.height - 25));
  await page.getByRole("link", { name: /Newer/ }).click();
  await expect(page).toHaveURL("/regtest/blocks");
  await firstHeight.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Block ${chain.tip.height}`);
});

test("a block page shows the fee facts its summary gives, and the tile agrees", async ({
  page,
  request,
}) => {
  const reply = await request.get(`/regtest/app/block/${chain.blocks[106]}/summary`);
  const { fee_rate: rates } = (await reply.json()) as {
    fee_rate: { median: number; min: number; max: number };
  };
  // Rates under 10 sat/vB print with two decimals.
  const median = rates.median.toFixed(2);
  const range = `${rates.min.toFixed(2)} – ${rates.max.toFixed(2)}`;
  await page.goto("/regtest/block/106");
  const fact = (label: string) =>
    page.locator(".block-fact").filter({ has: page.getByText(label, { exact: true }) });
  await expect(fact("Median fee rate")).toContainText(`${median} sat/vB`);
  await expect(fact("Fee range")).toContainText(`${range} sat/vB`);
  await expect(page.locator(".block-core .strata__layer").first()).toBeVisible();
  await expect(page.locator(".block-core__caption")).toContainText("Layers, cheapest first");

  await page.goto("/regtest/");
  const tile = page.getByRole("link", { name: /^Block 106,/ });
  await expect(tile).toContainText(`${median} sat/vB`);
  await expect(tile).toContainText(range);
});

test("every block names its miner: Unknown on regtest, which has no pools", async ({
  page,
  request,
}) => {
  const reply = await request.get(`/regtest/app/block/${chain.blocks[106]}/summary`);
  expect(((await reply.json()) as { miner: unknown }).miner).toStrictEqual({
    name: "Unknown",
    slug: "unknown",
  });

  await page.goto("/regtest/block/106");
  const miner = page
    .locator(".block-fact")
    .filter({ has: page.getByText("Miner", { exact: true }) });
  await expect(miner.getByRole("link", { name: "Unknown", exact: true })).toHaveAttribute(
    "href",
    "/regtest/mining/pool/unknown",
  );
  await expect(miner).toContainText("No listed address or tag");

  await page.goto("/regtest/");
  const lane = page.getByRole("list", { name: "Mined blocks, newest first" });
  await expect(lane.getByRole("link").first()).toHaveAccessibleName(
    /^Block \d+, mined by Unknown,/,
  );
  // Every block tile in the page, the older ones' once their facts come.
  await expect
    .poll(async () => {
      const names = await lane.locator(":scope > li[data-id] .home-tile__pool").allTextContents();
      return names.length > 0 && names.every((n) => n === "Unknown");
    })
    .toBe(true);

  await page.goto("/regtest/mining");
  const recent = page.getByRole("list", { name: "Latest blocks, newest first" });
  await expect(recent.getByRole("link").first()).toContainText("mined by Unknown");
  await expect(recent.locator(".mining-tile__pool").first()).toHaveText("Unknown");
});

test("a coinbase-only block says it pays no fees", async ({ page }) => {
  await page.goto("/regtest/block/105");
  await expect(page.getByText("Only the coinbase, which pays none")).toBeVisible();
  await expect(page.getByText("50.00 000 000 BTC subsidy")).toBeVisible();
});
