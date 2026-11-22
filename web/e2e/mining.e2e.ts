import type { Page } from "@playwright/test";
import { chain, expect, stubRetargets, test } from "./fixtures";
import { tablesSettled, tapRow } from "./rows";

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

test.describe("in a wide prose font", () => {
  test("regtest's mining page fits a phone without scrolling sideways, every pool named whole", async ({
    page,
  }) => {
    // Regtest's difficulty, 0.00000000046565 written out, ran 10 to 19 px past a phone's width.
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 700 });
      // All of history, so every section holds figures.
      await page.goto("/regtest/mining?period=all");
      await expect(page.getByText(/^4\.66\s×\s10⁻¹⁰$/).first()).toBeVisible();
      const table = page.getByRole("table", { name: /Pools ranked by blocks found/ });
      await expect(table).toBeVisible({ timeout: 30_000 });
      const scrolled = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrolled, `page width at ${width} px`).toBeLessThanOrEqual(width);
      // Unknown's "98 empty" once kept its width and cut the name beside it to under a pixel.
      const names = table.locator(".mining-pool__name");
      // With no name found the check below would pass having checked nothing.
      await expect(names.first()).toBeVisible();
      // A cut name is clipped to one line, so its overflow is down as well as across. One pixel of
      // slack: each size is rounded to a whole pixel.
      const cut = await names.evaluateAll((all) =>
        all
          .filter((n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1)
          .map((n) => n.textContent),
      );
      expect(cut, `pool names cut at ${width} px`).toEqual([]);
    }
  });

  // Regtest's own "98 empty", and counts as large as mainnet's all-time ones from a routed answer.
  // Under its name the note once ran on past its column and over the Share figure beside it. Last,
  // the counts drawn larger than the text round them, as a browser's minimum font size draws them
  // without changing what an em is: a column sized in em was then narrower than its count.
  const sizes = [
    { text: 16, width: 320 },
    { text: 16, width: 360 },
    { text: 24, width: 320 },
    { text: 24, width: 360 },
    { text: 16, width: 320, drawn: "28px" },
  ];
  for (const counts of ["regtest's", "large"] as const) {
    test(`each pool's empty count stays whole in its own cell, ${counts}, at 16 and 24 px text and drawn larger`, async ({
      page,
      browserName,
    }) => {
      test.skip(
        browserName !== "chromium",
        "only Chromium lets a test set the browser's text size",
      );
      if (counts === "large") await routeLargeCounts(page);
      const cdp = await page.context().newCDPSession(page);
      const faults: string[] = [];
      for (const { text, width, drawn } of sizes) {
        await cdp.send("Page.setFontSizes", {
          fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/regtest/mining?period=all");
        const notes = page.locator(".mining-pool__empty");
        // Regtest's answer in place of the routed one would pass having drawn no large count.
        await expect(notes).toHaveText(
          counts === "large"
            ? [/^52\s560\sempty$/, /^12\s345\sempty$/, /^98\sempty$/]
            : [/^98\sempty$/],
          { timeout: 30_000 },
        );
        // Hidden notes match their text and give no boxes, so every check below would pass on none.
        for (const note of await notes.all()) await expect(note).toBeVisible();
        if (drawn !== undefined) {
          await notes.evaluateAll((all, size) => {
            for (const n of all) {
              (n.querySelector(".mining-pool__count") as HTMLElement).style.fontSize = size;
            }
          }, drawn);
        }
        // The table drops its columns in the frames after a resize: measure what it settles on.
        await tablesSettled(page);
        const found = await notes.evaluateAll((all) => {
          // The table scrolls inside its own panel: without it the page is no narrower.
          const pageWidth = () => document.documentElement.scrollWidth;
          const panel = all[0]?.closest<HTMLElement>(".table-scroll");
          const withTable = pageWidth();
          if (panel) panel.style.display = "none";
          const without = pageWidth();
          if (panel) panel.style.display = "";
          const wide =
            withTable > without
              ? [`the table widens the page from ${without} to ${withTable} px`]
              : [];
          return [
            ...wide,
            ...all.flatMap((note) => {
              const cell = note.closest("td") as HTMLTableCellElement;
              const share = cell.nextElementSibling as HTMLElement;
              const edge =
                cell.getBoundingClientRect().right -
                Number.parseFloat(getComputedStyle(cell).paddingRight);
              const box = note.getBoundingClientRect();
              const textOf = (el: Element) => {
                const range = document.createRange();
                range.selectNodeContents(el);
                return range;
              };
              const count = textOf(note.querySelector(".mining-pool__count") as Element);
              const figure = count.getBoundingClientRect();
              const shareText = textOf(share).getBoundingClientRect();
              const what = `"${note.textContent?.trim() ?? ""}"`;
              return [
                // One line, drawn: no rectangle at all is a count not drawn, two a count broken.
                ...(count.getClientRects().length !== 1 || figure.width <= 0
                  ? [`${what}: its count is drawn as ${count.getClientRects().length} lines`]
                  : []),
                // Half a pixel of slack for rounding.
                ...(box.right > edge + 0.5 || figure.right > edge + 0.5
                  ? [
                      `${what} runs ${(Math.max(box.right, figure.right) - edge).toFixed(1)} px past its cell`,
                    ]
                  : []),
                ...(box.right > shareText.left &&
                box.left < shareText.right &&
                box.bottom > shareText.top &&
                box.top < shareText.bottom
                  ? [`${what} covers the share "${share.textContent ?? ""}"`]
                  : []),
              ];
            }),
          ];
        });
        const at = `${width} px, ${text} px text${drawn === undefined ? "" : `, counts drawn at ${drawn}`}`;
        faults.push(...found.map((f) => `${at}: ${f}`));
      }
      expect(faults).toStrictEqual([]);
    });
  }

  // A cut name once broke at its first space and left its line half empty: "SBI Crypto" read
  // "SBI…", and "BTC Guild" and "BTC Nuggets" read the same. Names from the pool list, and six-digit
  // block counts and match rates as mainnet's all of history has. The names are drawn at 20 px as
  // well, larger than the em the column's floor is measured in, as a browser's minimum font size
  // draws them: "BTC Guild" is cut only then.
  test("a cut pool name fills its line, whatever spaces it has", async ({ page }) => {
    const names = ["SBI Crypto", "BTC Guild", "BTC Nuggets", "ST Mining Corp", "AntPool"];
    const pools = names.map((name, i) => ({
      poolId: i + 1,
      name,
      link: "",
      blockCount: 190_000 - i * 10_000,
      rank: i + 1,
      emptyBlocks: 0,
      slug: name.toLowerCase().replaceAll(" ", ""),
      avgMatchRate: 99.6 - i * 0.7,
      avgFeeDelta: null,
      poolUniqueId: i + 1,
    }));
    await page.route(/\/api\/v1\/mining\/pools\/all$/, (route) =>
      route.fulfill({
        json: {
          pools,
          blockCount: 900_000,
          lastEstimatedHashrate: 1e18,
          lastEstimatedHashrate1w: 1e18,
        },
      }),
    );
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/regtest/mining?period=all");
    const shown = page.locator(".mining-pool__name");
    await expect(shown).toHaveText(names, { timeout: 30_000 });
    await shown.evaluateAll((all) => {
      for (const el of all) el.style.fontSize = "17px";
    });
    await tablesSettled(page);
    // What each name shows: the characters on its first line, and how wide they are drawn.
    const drawn = await shown.evaluateAll((all) =>
      all.map((el) => {
        const node = el.firstChild as Text;
        const name = node.data;
        const box = (from: number, to: number) => {
          const range = document.createRange();
          range.setStart(node, from);
          range.setEnd(node, to);
          return range.getBoundingClientRect();
        };
        const top = box(0, 1).top;
        let line = 1;
        while (line < name.length && Math.abs(box(line, line + 1).top - top) < 1) line += 1;
        return {
          name,
          cut: el.scrollHeight > el.clientHeight + 1,
          shows: name.slice(0, line),
          width: box(0, line).width,
          next: line < name.length ? box(line, line + 1).width : 0,
          room: el.clientWidth,
        };
      }),
    );
    const cut = drawn.filter((d) => d.cut);
    // Neither "BTC" pool fits here: with none cut the checks would pass having tested nothing.
    expect(
      cut.map((d) => d.name),
      "the names cut at 320 px",
    ).toEqual(expect.arrayContaining(["SBI Crypto", "BTC Guild", "BTC Nuggets"]));
    // Filled: the line ends where the next character would not fit, not at a space short of it.
    for (const d of cut) {
      expect(d.room - d.width, `"${d.name}" shows "${d.shows}" in ${d.room} px`).toBeLessThan(
        d.next + 0.5,
      );
    }
    // The ellipsis is painted over the end of the line, which a range cannot see: the two must
    // still differ with the last character taken away.
    const btc = drawn.filter((d) => d.name.startsWith("BTC ")).map((d) => d.shows.slice(0, -1));
    expect(new Set(btc).size, `the two BTC pools show ${JSON.stringify(btc)}`).toBe(2);
  });
});

/** All of history as a busy network's, three pools with empty counts of five, five and two digits. */
async function routeLargeCounts(page: Page) {
  const pools = (
    [
      ["Foundry USA", 60_000, 52_560],
      ["Unknown", 30_000, 12_345],
      ["AntPool", 9_000, 98],
    ] as const
  ).map(([name, blockCount, emptyBlocks], i) => ({
    poolId: i + 1,
    name,
    link: "",
    blockCount,
    rank: i + 1,
    emptyBlocks,
    slug: name.toLowerCase().replaceAll(" ", ""),
    avgMatchRate: null,
    avgFeeDelta: null,
    poolUniqueId: i + 1,
  }));
  await page.route(/\/api\/v1\/mining\/pools\/all$/, (route) =>
    route.fulfill({
      json: {
        pools,
        blockCount: 99_000,
        lastEstimatedHashrate: 1e18,
        lastEstimatedHashrate1w: 1e18,
      },
    }),
  );
}

test("a chart draws and its readout shows the route's figure", async ({ page }) => {
  const route = "/regtest/api/v1/mining/blocks/fees/all";
  const chart = page.getByRole("slider", { name: /Average fees per block/ });
  let reward = "";
  // The server refreshes its answer while the backfill runs: compare until both see the same one.
  await expect(async () => {
    const points = (await (await page.request.get(route)).json()) as { avgFees: number }[];
    // Exact, grouped as sats read: `0.00 000 018 BTC` (the matchers read its spaces as spaces).
    const sats = Math.round(points.at(-1)?.avgFees ?? 0);
    const eight = String(sats % 1e8).padStart(8, "0");
    reward = `${Math.floor(sats / 1e8)}.${eight.slice(0, 2)} ${eight.slice(2, 5)} ${eight.slice(5)} BTC`;
    // Fees is the tab shown first.
    await page.goto("/regtest/mining?period=all");
    await expect(chart).toHaveAttribute(
      "aria-valuetext",
      new RegExp(`Fees per block ${reward.replaceAll(".", "\\.").replaceAll(" ", "\\s")}`),
      {
        timeout: 3_000,
      },
    );
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
