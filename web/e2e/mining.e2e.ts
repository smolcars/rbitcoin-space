import { chain, expect, stubRetargets, test } from "./fixtures";
import { tapRow } from "./rows";

// The scenario's blocks are stamped from 2026-01-01, ten minutes apart, by no pool on the list.

test("regtest's mining page says what is and is not meaningful there", async ({ page }) => {
  await page.goto("/regtest/mining");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mining");
  await expect(
    page.getByText(/There are no pools and the hashrate is not meaningful/),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Mining figures" })
      .getByText("Regtest never adjusts its difficulty", { exact: false }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Difficulty adjustments" })
      .getByText("Regtest never adjusts its difficulty, so there are none to list."),
  ).toBeVisible();
  // Nothing was mined in the last week: the page says so and offers all of history.
  const pools = page.getByRole("region", { name: "Pools" });
  await expect(pools.getByText("No blocks stored for the last week")).toBeVisible({
    timeout: 30_000,
  });
  await pools.getByRole("link", { name: "See all stored history" }).click();
  await expect(page).toHaveURL(/\/regtest\/mining\?period=all$/);
  await expect(page.getByRole("link", { name: /all time/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const table = pools.getByRole("table", { name: /Pools ranked by blocks found/ });
  const unknown = table.getByRole("row").nth(1);
  await expect(unknown).toContainText("Unknown");
  await expect(unknown).toContainText("100.0%");
});

test("regtest's mining page fits a phone without scrolling sideways", async ({ page }) => {
  // Regtest's difficulty, 0.00000000046565 written out, ran 10 to 19 px past a phone's width.
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 700 });
    // All of history, so every section holds figures.
    await page.goto("/regtest/mining?period=all");
    await expect(page.getByText(/^4\.66\s×\s10⁻¹⁰$/).first()).toBeVisible();
    await expect(page.getByRole("table", { name: /Pools ranked by blocks found/ })).toBeVisible({
      timeout: 30_000,
    });
    const scrolled = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrolled, `page width at ${width} px`).toBeLessThanOrEqual(width);
  }
});

test("a chart draws and its readout shows the route's figure", async ({ page }) => {
  const route = "/regtest/api/v1/mining/blocks/fees/all";
  const chart = page.getByRole("slider", { name: /Average fees per block/ });
  let reward = "";
  // The server refreshes its answer while the backfill runs: compare until both see the same one.
  await expect(async () => {
    const points = (await (await page.request.get(route)).json()) as { avgFees: number }[];
    reward = `${((points.at(-1)?.avgFees ?? 0) / 1e8).toFixed(8)} BTC`;
    // Fees is the tab shown first.
    await page.goto("/regtest/mining?period=all");
    await expect(chart).toHaveAttribute("aria-valuetext", new RegExp(`Fees per block ${reward}`), {
      timeout: 3_000,
    });
  }).toPass({ timeout: 30_000 });
  const section = page.getByRole("region", { name: "Blocks over time" });
  await expect(section.locator("svg path").first()).toBeAttached();
  // The pointer on the chart: the readout shows the point under it.
  const box = await chart.boundingBox();
  if (box) await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await expect(section.getByText(reward, { exact: true })).toBeVisible();
  // Keyboard: the chart takes focus and moves with the arrow keys.
  await chart.focus();
  await expect(chart).toBeFocused();
  await page.keyboard.press("Home");
  await expect(chart).toHaveAttribute("aria-valuenow", "0");
  // The figures behind the chart are a table a screen reader can reach.
  await section.getByText("Show the figures").click();
  await expect(section.getByRole("cell", { name: reward })).toBeVisible();
});

test("the Unknown pool's page lists the chain's blocks, linked", async ({ page }) => {
  await page.goto("/regtest/mining/pool/unknown");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unknown", {
    timeout: 30_000,
  });
  const blocks = page.getByRole("table", { name: /Blocks found by Unknown/ });
  await expect(blocks.getByRole("link", { name: String(chain.tip.height) })).toHaveAttribute(
    "href",
    `/regtest/block/${chain.tip.hash}`,
  );
});

// The Pools caption once kept the first period's count while the table moved on.
test("the pools caption follows the period through every switch", async ({ page }) => {
  const periods = [
    ["24 h", "the last 24 hours"],
    ["1 w", "the last week"],
    ["1 m", "the last 30 days"],
    ["1 y", "the last year"],
    ["All", "all time"],
  ] as const;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/regtest/mining?period=all");
    const pools = page.getByRole("region", { name: "Pools" });
    const caption = pools.locator(".section__head");
    await expect(caption).toContainText(/blocks? in all time/, { timeout: 30_000 });
    for (const [label, words] of periods) {
      await page
        .getByRole("navigation", { name: "Period" })
        .getByRole("link", { name: new RegExp(`: ${words}$`) })
        .click();
      await expect(caption).toContainText(new RegExp(`^Pools[\\d\\s\\u202f]+blocks? in ${words}$`));
      const count = Number(
        /^Pools([\d\s\u202F]+) block/
          .exec((await caption.textContent()) ?? "")?.[1]
          ?.replaceAll(/\D/g, ""),
      );
      if (count === 0) {
        await expect(pools.getByText(`No blocks stored for ${words}`)).toBeVisible();
        continue;
      }
      const table = pools.getByRole("table", { name: `Pools ranked by blocks found in ${words}` });
      const all = pools.getByRole("button", { name: /^Show all \d+ pools$/ });
      if (await all.isVisible()) await all.click();
      const column = (await table.locator("thead th").allInnerTexts()).indexOf("Blocks");
      const cells = await table.locator(`tbody td:nth-child(${column + 1})`).allInnerTexts();
      const sum = cells.reduce((total, c) => total + Number(c.replaceAll(/\D/g, "")), 0);
      expect(sum, `${label} at ${width} px`).toBe(count);
    }
  }
});

// Colours once followed rank, so F2Pool was gold one day and lavender the next week; then a fixed
// six left a bigger pool in the grey. Now each period draws its own six largest, each in its own.
test("the share graphics draw each period's six largest pools, each in its own colour throughout", async ({
  page,
}) => {
  // Regtest has no pools: each period answers with eight in its own order.
  const orders: Record<string, string[]> = {
    "24h": [
      "F2Pool",
      "AntPool",
      "Luxor",
      "Foundry USA",
      "SpiderPool",
      "ViaBTC",
      "MARA Pool",
      "Ocean.xyz",
    ],
    "1w": [
      "AntPool",
      "Foundry USA",
      "F2Pool",
      "SpiderPool",
      "MARA Pool",
      "ViaBTC",
      "Luxor",
      "SecPool",
    ],
    "1m": [
      "Foundry USA",
      "SpiderPool",
      "AntPool",
      "Luxor",
      "F2Pool",
      "Ocean.xyz",
      "ViaBTC",
      "MARA Pool",
    ],
    "1y": [
      "Luxor",
      "F2Pool",
      "Foundry USA",
      "AntPool",
      "SpiderPool",
      "SecPool",
      "MARA Pool",
      "ViaBTC",
    ],
    all: [
      "Foundry USA",
      "AntPool",
      "F2Pool",
      "ViaBTC",
      "Poolin",
      "BTC.com",
      "Binance Pool",
      "Luxor",
    ],
  };
  const period = (url: string) => /\/(24h|1w|1m|1y|all)$/.exec(url)?.[1] ?? "1w";
  const count = (i: number) => 80 - i * 9;
  await page.route(/\/api\/v1\/mining\/pools\/\w+$/, (route) => {
    const names = orders[period(route.request().url())] ?? [];
    const pools = names.map((name, i) => ({
      poolId: i + 1,
      name,
      link: "",
      blockCount: count(i),
      rank: i + 1,
      emptyBlocks: 0,
      slug: name.toLowerCase().replaceAll(/[ .]/g, ""),
      avgMatchRate: null,
      avgFeeDelta: null,
      poolUniqueId: i + 1,
    }));
    const blockCount = names.reduce((sum, _, i) => sum + count(i), 0);
    return route.fulfill({
      json: { pools, blockCount, lastEstimatedHashrate: 1e18, lastEstimatedHashrate1w: 1e18 },
    });
  });
  await page.route(/\/api\/v1\/mining\/hashrate\/pools\/\w+$/, (route) => {
    const names = orders[period(route.request().url())] ?? [];
    const which = period(route.request().url());
    // A year's second week is small, with the seventh pool in most of it: summed weekly shares
    // would rank it above the sixth, which has more blocks. The chart follows the table's blocks.
    const share = (i: number, second: boolean) =>
      which === "1y" && second && i >= 5 ? (i === 6 ? 0.3 : 0.001) : count(i) / 500;
    const weeks = [1_790_000_000, 1_790_604_800].flatMap((timestamp, w) =>
      names.map((poolName, i) => ({
        timestamp,
        avgHashrate: 1e18,
        share: share(i, w === 1),
        poolName,
      })),
    );
    return route.fulfill({ json: weeks });
  });
  const seen = new Map<string, string>();
  const remember = (swatches: (readonly [string, string])[], where: string) => {
    for (const [name, colour] of swatches) {
      expect(colour, `${name} ${where}`).not.toBe("");
      expect(colour, `${name} ${where}`).toBe(seen.get(name) ?? colour);
      seen.set(name, colour);
    }
  };
  for (const id of ["24h", "1w", "1m", "1y", "all"]) {
    await page.goto(`/regtest/mining?period=${id}`);
    const pools = page.getByRole("region", { name: "Pools" });
    // Every period has the bar over the table; its parts name their pools.
    const parts = pools.locator(".mining-sharebar .mining-period-shares__part");
    await expect(parts.first()).toBeAttached({ timeout: 30_000 });
    const swatches = await parts.evaluateAll((items) =>
      items.map((el) => [el.dataset["pool"] ?? "", getComputedStyle(el).backgroundColor] as const),
    );
    // The pools drawn on their own are the table's first six, in its order.
    const table = pools.getByRole("table", { name: /^Pools ranked by blocks found/ });
    const top = (await table.locator("tbody tr").allInnerTexts())
      .slice(0, 6)
      .map((row) => (orders[id] ?? []).find((n) => row.includes(n)) ?? "");
    const drawn = swatches.map(([name]) => name).filter((name) => name !== "Other pools");
    expect(drawn, `pools drawn at ${id}`).toStrictEqual(top);
    expect(swatches.at(-1)?.[0], `the rest at ${id}`).toBe("Other pools");
    remember(swatches, `in the bar at ${id}`);
    // A month and longer also chart the weekly shares, in the same pools and colours.
    if (id === "24h" || id === "1w") continue;
    const blocks = page.getByRole("region", { name: "Blocks over time" });
    await blocks.getByRole("button", { name: "Pool shares" }).click();
    const keys = blocks.locator(".chart__value");
    await expect(keys.first()).toBeVisible({ timeout: 30_000 });
    const charted = await keys.evaluateAll((items) =>
      items.map((li) => {
        const swatch = li.querySelector(".chart__key");
        const name = li.querySelector(".chart__name")?.textContent;
        return [name ?? "", swatch ? getComputedStyle(swatch).backgroundColor : ""] as const;
      }),
    );
    expect(
      charted.map(([name]) => name),
      `pools charted at ${id}`,
    ).toStrictEqual(swatches.map(([name]) => name));
    remember(charted, `in the chart at ${id}`);
    // A pool under the pointer keeps its own colour, the one its key shows.
    if (id === "1m") {
      const plot = blocks.getByRole("slider");
      await expect(plot.locator("path.chart__layer").first()).toBeAttached();
      const box = await plot.boundingBox();
      if (box) await plot.hover({ position: { x: box.width * 0.75, y: box.height * 0.7 } });
      const on = blocks.locator(".chart__layer--on");
      await expect(on).toHaveCount(1);
      const fill = await on.evaluate((l) => getComputedStyle(l).fill);
      expect(charted.map(([, c]) => c)).toContain(fill);
      await page.mouse.move(0, 0);
    }
  }
  // Every pool drawn has a colour no other pool has, and "Other pools" its own grey.
  expect(new Set(seen.values()).size).toBe(seen.size);
  expect([...seen.keys()]).toContain("Poolin");
});

// Regtest never retargets: its answer is mainnet's last twelve, at the scenario's heights.
test("past adjustments read newest first, up and down in words, and each row opens its block", async ({
  page,
}) => {
  await stubRetargets(page);
  await page.goto("/regtest/mining");
  const section = page.getByRole("region", { name: "Difficulty adjustments" });
  const table = section.getByRole("table", { name: "Difficulty adjustments, newest first" });
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(6, { timeout: 30_000 });
  await expect(rows.first()).toContainText(/Up 5\.54%.*148\.36\s?T/);
  await expect(rows.nth(2)).toContainText("Down 0.03%");
  // The arrow repeats the word; it is not read aloud, and no colour carries the direction.
  await expect(rows.first().locator(".mining-arrow")).toHaveAttribute("aria-hidden", "true");
  await section.getByRole("button", { name: "Show all 12 adjustments" }).click();
  await expect(rows).toHaveCount(12);
  await expect(rows.last()).toContainText("Up 1.72%");
  await tapRow(page, table, "a past adjustment");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("110");
});

test.describe("block health", () => {
  test.use({ consoleErrorsAllowed: [/status of 500/] });
  test("says when nothing is audited, and when the server refuses", async ({ page }) => {
    let refuse = true;
    await page.route(/\/regtest\/api\/v1\/mining\/blocks\/predictions\/\w+$/, (route) =>
      refuse
        ? route.fulfill({ status: 500, json: { error: "store unavailable" } })
        : route.continue(),
    );
    await page.goto("/regtest/mining");
    const health = page.getByRole("region", { name: "Blocks over time" });
    await health.getByRole("button", { name: "Match rate" }).click();
    await expect(health.getByText("Could not load the block audits")).toBeVisible({
      timeout: 30_000,
    });
    refuse = false;
    await health.getByRole("button", { name: "Try again" }).click();
    // Only the mining tests make audits, and they run after this one: regtest has none yet.
    await expect(health.getByText("No block audits stored for the last week")).toBeVisible();
    await health.getByRole("link", { name: "See all stored history" }).click();
    // The tab stays open across the period's change.
    await expect(health.getByText("No block audits stored for all time")).toBeVisible();
  });
});
