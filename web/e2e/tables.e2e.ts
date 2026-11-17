// Every table fits a phone's width with nothing cut off, and no page scrolls sideways (WCAG 1.4.10).
import type { Locator, Page } from "@playwright/test";
import { ARKADE_ID, withArkade } from "./ark-answers";
import { chain, expect, stubRetargets, test } from "./fixtures";
import { AUDIT } from "../src/components/audit/fakes";
import { ACINQ, mainnet, ONE, recorded, serve } from "./lightning-answers";
import { KEPT, LARGE, stubLarge } from "./large-address";
import { tablesFit, tapRow, wideFaces } from "./rows";

test.use({ consoleErrorsAllowed: [/status of (429|503)/] });

const PAGES = [
  { path: `/regtest/block/${chain.blocks[106]}`, table: "Transactions in this block" },
  { path: "/regtest/blocks", table: "Recent blocks, newest first" },
  {
    path: `/regtest/address/${chain.addresses.p2wpkh}`,
    table: "Transactions of this address, newest first",
  },
  {
    path: `/regtest/address/${chain.addresses.p2wpkh}?view=unspent`,
    table: "Unspent outputs of this address, newest first",
  },
  { path: `/regtest/tx/${chain.txs.script_types}`, table: null },
  {
    path: `/regtest/ark/arkade/vtxo/${ARKADE_ID}`,
    table: "The exit's transactions, in broadcast order",
  },
];

// The narrowest phone, strictly: 390 and 720 px are in the fit-or-scroll test below.
for (const width of [320]) {
  test(`every table fits at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await withArkade(page, true);
    for (const { path, table } of PAGES) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (table) {
        const t = page.getByRole("table", { name: table });
        await expect(t.getByRole("link").first()).toBeVisible();
        const box = await t.evaluate((el) => {
          const scroller = el.parentElement as HTMLElement;
          return { table: el.scrollWidth, room: scroller.clientWidth };
        });
        expect(box.table, `${path}: table width`).toBeLessThanOrEqual(box.room);
      } else {
        await expect(page.getByRole("list", { name: "Outputs" })).toBeVisible();
      }
      const scrolled = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrolled, `${path}: page width`).toBeLessThanOrEqual(width);
    }
  });
}

// Without the web font every engine draws figures in its own monospace, which can be wider: the
// blocks list must still fit a 320 px phone.
test.describe("without the web font", () => {
  // Each engine reports the refused font in its own words. WebKit also calls a summary fetch that
  // the next page's load cancels an "access control" failure: the app is same-origin.
  test.use({
    consoleErrorsAllowed: [
      /status of (429|503)|font|Failed to load resource|ERR_FAILED|due to access control checks/i,
    ],
  });

  test("the blocks list fits 320 px when the web font never arrives", async ({ page }) => {
    await page.route(/\.woff2$/, (route) => route.abort());
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/regtest/blocks");
    const t = page.getByRole("table", { name: "Recent blocks, newest first" });
    await expect(t.getByRole("link").first()).toBeVisible();
    const box = await t.evaluate((el) => ({
      table: el.scrollWidth,
      room: (el.parentElement as HTMLElement).clientWidth,
    }));
    expect(box.table).toBeLessThanOrEqual(box.room);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  });

  // Linux's fallback faces are wider than a Mac's: a 320 px page once scrolled sideways on CI's
  // runner alone. Wide faces are forced here, so any engine on any system shows the same.
  test("no page scrolls sideways at 320 px in wide fallback faces", async ({ page }) => {
    await page.route(/\.woff2$/, (route) => route.abort());
    await page.setViewportSize({ width: 320, height: 700 });
    // Each page with what shows it has loaded: a page is measured whole, never as its skeleton.
    const pages: [string, (p: Page) => Locator][] = [
      ["/regtest/", (p) => p.getByRole("table", { name: /newest transactions/ }).getByRole("link")],
      ["/regtest/blocks", (p) => p.getByRole("table").getByRole("link")],
      [`/regtest/block/${chain.blocks[106]}`, (p) => p.getByRole("table").getByRole("link")],
      ["/regtest/block/next", (p) => p.locator("main table a")],
      [`/regtest/tx/${chain.txs.script_types}`, (p) => p.locator(".tx-summary .amount")],
      [`/regtest/address/${chain.addresses.p2tr}`, (p) => p.getByRole("table").getByRole("link")],
      // Regtest's chain is months old: all of history has its pools table.
      ["/regtest/mining?period=all", (p) => p.locator("main table a")],
      ["/regtest/mempool", (p) => p.getByRole("slider")],
      ["/regtest/lightning", (p) => p.getByText("Lightning is switched off on Regtest")],
      [
        "/regtest/no/such/page",
        (p) => p.getByRole("main").getByRole("combobox", { name: "Search" }),
      ],
    ];
    for (const [path, ready] of pages) {
      await page.goto(path);
      await expect(ready(page).first()).toBeVisible();
      await page.evaluate(() => {
        const root = document.documentElement.style;
        root.setProperty("--font-sans", '"DejaVu Sans", Verdana, sans-serif');
        root.setProperty("--font-mono", '"DejaVu Sans Mono", "Courier New", monospace');
      });
      // One frame in the new faces before measuring.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const over = await page.evaluate(() =>
        [...document.querySelectorAll("main *")]
          .filter((el) => el.getBoundingClientRect().right > 320.5 && !el.closest(".table-scroll"))
          .slice(0, 4)
          .map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`),
      );
      const scrolled = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrolled, `${path}: past the edge: ${over.join(", ")}`).toBeLessThanOrEqual(320);
    }
  });
});

/** Lists on the regtest chain, each with what its rows open, and answers a list needs stubbed. */
const LISTS: { path: string; table: string | RegExp; stub?: (page: Page) => Promise<void> }[] = [
  { path: "/regtest/", table: /newest transactions/ },
  { path: "/regtest/blocks", table: "Recent blocks, newest first" },
  { path: `/regtest/block/${chain.blocks[106]}`, table: "Transactions in this block" },
  { path: "/regtest/block/next", table: /^Transactions in the next block/ },
  {
    path: `/regtest/address/${chain.addresses.p2wpkh}`,
    table: "Transactions of this address, newest first",
  },
  {
    path: `/regtest/address/${chain.addresses.p2wpkh}?view=unspent`,
    table: "Unspent outputs of this address, newest first",
  },
  // Above the node's cap: its unconfirmed transactions only.
  {
    path: `/regtest/address/${LARGE}`,
    table: /^Unconfirmed transactions of this address/,
    stub: (page) => stubLarge(page),
  },
  // Kept by the server's ledger: its newest confirmed transactions.
  {
    path: `/regtest/address/${LARGE}?ledger=kept`,
    table: /^Newest confirmed transactions of this address/,
    stub: (page) => stubLarge(page, { ledger: () => KEPT }),
  },
  { path: "/regtest/mining?period=all", table: /^Pools ranked by blocks found/ },
  { path: "/regtest/mining/pool/unknown", table: /^Blocks found by/ },
  // Regtest never retargets, so its past adjustments are mainnet's.
  { path: "/regtest/mining", table: "Difficulty adjustments, newest first", stub: stubRetargets },
];

// Only a row's small link text was a target once, and on four lists the whole row did nothing.
test.describe("a tap anywhere on any list's row", () => {
  // Each tap leaves a page whose fetches may still run: WebKit calls the ones the next load
  // cancels "access control" failures, though the app is same-origin and catches them.
  test.use({ consoleErrorsAllowed: [/status of (429|503)|due to access control checks/] });
  test("opens its item, at a phone's width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const { path, table, stub } of LISTS) {
      await stub?.(page);
      await page.goto(path);
      await tapRow(page, page.getByRole("table", { name: table }), path);
    }
  });
});

// A test to a width and kind of list: each is its own client, so no reader's allowance is spent on
// 24 page loads. All eleven in one outran 30 s in WebKit at a phone's pixel density on CI's runner,
// where a page's first frames after loading take up to a second each.
for (const width of [320, 390, 720]) {
  for (const [kind, lists] of [
    ["the chain's", LISTS.slice(0, 4)],
    ["an address's", LISTS.slice(4, 8)],
    ["mining's", LISTS.slice(8)],
  ] as const) {
    test(`every table fits its panel or shows that it scrolls, at ${width} px: ${kind} lists`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const { path, table, stub } of lists) {
        await stub?.(page);
        await page.goto(path);
        await expect(
          page.getByRole("table", { name: table }).locator("tbody tr").first(),
        ).toBeVisible({ timeout: 30_000 });
        await tablesFit(page, `${path} at ${width} px`);
      }
    });
  }
}

// Only a row's small link text was a target once: on a phone the whole row opens its item.
test("a tap anywhere on a list's row opens its item, and the keyboard meets it once", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/regtest/blocks");
  const table = page.getByRole("table", { name: "Recent blocks, newest first" });
  const row = table.getByRole("row").nth(1);
  const height = await row.getByRole("link").first().textContent();
  // Its transaction count, far from any link: pressed where it is, as a thumb would.
  const cell = await row.getByRole("cell").nth(2).boundingBox();
  if (!cell) throw new Error("no cell");
  await page.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await expect(page).toHaveURL(/\/regtest\/block\/[0-9a-f]{64}$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(height ?? "-");
  // The row's own link is hidden from the keyboard and from screen readers: one stop a row.
  await page.goBack();
  await expect(table.locator(".table__rowlink").first()).toHaveAttribute("tabindex", "-1");
  await expect(table.locator(".table__rowlink").first()).toHaveAttribute("aria-hidden", "true");
});

// Fitting once ran only when the panel changed width: figures that arrived later and widened the
// table left it scrolling, droppable columns and all.
test("a table that grows after it is drawn drops another column to fit", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/regtest/blocks");
  const table = page.getByRole("table", { name: "Recent blocks, newest first" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await expect(table.getByRole("link", { name: "Unknown" }).first()).toBeVisible();
  const gone = () => table.locator("thead th.table__gone").count();
  const before = await gone();
  // A wide name lands in a row, as a long pool name might.
  await table
    .locator("tbody tr")
    .first()
    .locator("td")
    .filter({ visible: true })
    .nth(1)
    .evaluate((td) => {
      const wide = document.createElement("span");
      wide.style.display = "inline-block";
      wide.style.width = "260px";
      td.append(wide);
    });
  await expect.poll(gone).toBeGreaterThan(before);
  await tablesFit(page, "/regtest/blocks after a wider row");
});

// Tables that appear only on a tap were outside the rule once: the audit's list on a phone put the
// fee rate it is sorted by off-screen. Every table shown on interaction is held to it too.
// The narrowest phone and where a desktop drops columns: 390 lies between them. A test a width and
// page: more in one outran 30 s in WebKit at a phone's pixel density on CI's runner.
for (const width of [320, 720]) {
  test(`the audit's list, opened on a tap, fits its panel or shows that it scrolls, at ${width} px`, async ({
    page,
  }) => {
    const block = chain.blocks[106];
    const txid = (n: number) => n.toString(16).padStart(64, "a");
    // A block the server audited: its totals in the summary, and the list behind the button.
    await page.route(/\/regtest\/app\/blocks\/summary\?/, async (route) => {
      const reply = await route.fetch();
      const all = (await reply.json()) as Record<string, unknown>[];
      for (const one of all) if (one["id"] === block) one["audit"] = AUDIT;
      await route.fulfill({ response: reply, json: all });
    });
    await page.route(new RegExp(`/regtest/app/block/${block}/audit$`), (route) =>
      route.fulfill({
        json: {
          ...AUDIT,
          id: block,
          height: 106,
          time: 1_767_225_600,
          seen_at: 1_767_225_600,
          complete: true,
          txs: Array.from({ length: 30 }, (_, i) => ({
            txid: txid(i + 1),
            kind: "missing",
            vsize: 1_234_567,
            rate: 12_345_678,
            first_seen: 1_767_225_000,
          })),
        },
      }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/regtest/block/${block}`);
    await page.getByRole("button", { name: "Show the transactions that differ" }).click();
    await expect(page.locator(".audit-list tbody tr").first()).toBeVisible();
    await tablesFit(page, `the audit's list at ${width} px`);
    // The column it is sorted by is in sight, not behind a scroll.
    const inSight = await page.locator(".audit-list .table-scroll").evaluate((scroller) => {
      const header = [...scroller.querySelectorAll("th")].find((th) =>
        (th.textContent ?? "").includes("sat/vB"),
      );
      if (!header) return false;
      return header.getBoundingClientRect().right <= scroller.getBoundingClientRect().right + 1;
    });
    expect(inSight, `the audit's fee rate at ${width} px`).toBe(true);
  });

  // The figures behind each chart.
  for (const path of [
    "/regtest/mempool?interval=2h",
    "/regtest/mining?period=all",
    `/regtest/address/${chain.addresses.p2tr}`,
  ]) {
    test(`the figures behind ${path}'s charts, opened on a tap, fit their panel or show that they scroll, at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      // The mempool's one plot keeps its figures under its panel; the other charts, in their caption.
      const figures = page.locator(".chart__figures > summary, .mempool-figures-table > summary");
      await expect(figures.first()).toBeVisible({ timeout: 30_000 });
      for (const f of await figures.all()) if (await f.isVisible()) await f.click();
      await expect(
        page.locator(".chart__figures table, .mempool-figures-table table").first(),
      ).toBeVisible();
      await tablesFit(page, `${path}'s figures at ${width} px`);
    });
  }
}

// A chart's figures are its precise text alternative, read whole at every width the page takes,
// with no sideways scroll. A node's history once put its capacity past a 320 px phone's edge; its
// fee figures, side by side in a half-page panel, cut both capacity columns at 1440 px; the mining
// page's block health and fee rates scrolled on a phone. Each table is held to its own box, in the
// faces the site was built with and in wider ones.
const FIGURES_WIDTHS = [320, 390, 720, 1024, 1280, 1440];

/** The figures' answers and checks, for a test at `width`. */
async function figuresAt(page: Page, width: number) {
  // The largest node's figures, with a change between its midnights: the widest a time and a
  // capacity get.
  const acinq = recorded("node-acinq-history") as { from: number; points: object[] };
  const [midnight, now] = acinq.points;
  await serve(page, {
    ...mainnet(),
    [`nodes/${ACINQ}/history`]: {
      ...acinq,
      points: [midnight, { time: 1_794_550_123, channels: 1805, capacity: 27_655_420_454 }, now],
    },
  });
  // Mainnet-sized fee rates: regtest's blocks pay almost nothing.
  await page.route(/\/regtest\/api\/v1\/mining\/blocks\/fee-rates\//, (route) =>
    route.fulfill({
      json: Array.from({ length: 20 }, (_, i) => ({
        avgHeight: 975_000 + i * 10,
        timestamp: 1_794_000_000 + i * 6000,
        avgFee_0: 0.1,
        avgFee_10: 12.25,
        avgFee_25: 25.5,
        avgFee_50: 101.5,
        avgFee_75: 210.25,
        avgFee_90: 1250.5,
        avgFee_100: 4000,
      })),
    }),
  );
  const section = (name: string) =>
    page.locator("section", { has: page.getByRole("heading", { name, exact: true }) });
  /** Opens the figures of `names`. */
  const open = async (names: string[]) => {
    for (const name of names) {
      for (const details of await section(name).locator(".chart__figures").all()) {
        if (!(await details.locator("> summary").isVisible())) continue;
        await details.locator("> summary").click();
        await expect(details.locator("table").first()).toBeVisible();
      }
    }
  };
  /** Each open figures table in `names` is no wider than its own box, every cell inside it. */
  const whole = async (names: string[], label: string) => {
    let seen = 0;
    for (const name of names) {
      for (const t of await section(name).locator(".chart__table table").all()) {
        seen += 1;
        const fit = await t.evaluate((el) => {
          const scroll = el.closest(".table-scroll") as HTMLElement;
          const region = (el.closest(".chart__table") as HTMLElement).getBoundingClientRect();
          const box = scroll.getBoundingClientRect();
          const right = Math.min(box.right, region.right) + 0.5;
          return {
            over: Math.max(0, Math.round(el.getBoundingClientRect().width - box.width)),
            fades: "moreEnd" in scroll.dataset,
            out: [...el.querySelectorAll("th, td")]
              .filter((c) => c.getClientRects().length > 0)
              .filter((c) => c.getBoundingClientRect().right > right)
              .map((c) => c.textContent),
          };
        });
        expect(fit, `${label}: ${name}`).toStrictEqual({ over: 0, fades: false, out: [] });
      }
    }
    expect(seen, `${label}: figures to measure`).toBeGreaterThan(0);
  };
  /** In the site's own faces, then in wider ones, the page as it is. */
  const bothFaces = async (names: string[], label: string) => {
    await whole(names, label);
    await wideFaces(page);
    await whole(names, `${label} in wide faces`);
  };
  await page.setViewportSize({ width, height: 900 });
  return { open, bothFaces, section };
}

// A node's pages, then each view of the mining page, a test each: seven page loads in one test
// outran its time in WebKit at a phone's pixel density on CI's runner.
for (const width of FIGURES_WIDTHS) {
  test(`a chart's figures fit whole at ${width} px: a node's history and fees`, async ({
    page,
  }) => {
    const { open, bothFaces } = await figuresAt(page, width);
    for (const node of [ACINQ, ONE]) {
      // Each in its own view: the past, then its fees by the view's tab, with no reload.
      await page.goto(`/regtest/lightning/node/${node}?view=history`);
      await expect(page.getByRole("slider")).toBeVisible();
      await open(["Over time"]);
      await bothFaces(["Over time"], `${node.slice(0, 8)}'s past at ${width} px`);
      await page
        .getByRole("navigation", { name: "Node views" })
        .getByRole("link", { name: "Fees" })
        .click();
      await open(["Fee rates"]);
      await bothFaces(["Fee rates"], `${node.slice(0, 8)}'s fees at ${width} px`);
    }
  });

  // Every view of the block figures, each on a fresh page in the site's own faces; fee rates as
  // wide as mainnet's, two ranges and a median.
  for (const view of ["Fees", "Fee rates", "Size"]) {
    test(`a chart's figures fit whole at ${width} px: the mining page's, ${view}`, async ({
      page,
    }) => {
      const { open, bothFaces, section } = await figuresAt(page, width);
      const blocks = section("Blocks over time");
      await page.goto("/regtest/mining?period=all");
      if (view === "Fees") {
        await expect(page.locator("main table a").first()).toBeVisible({ timeout: 30_000 });
        // Regtest draws what it can of them: its hashrate means nothing, and its blocks are few.
        await expect(page.locator(".chart__figures > summary").first()).toBeVisible();
      }
      await blocks.getByRole("button", { name: view, exact: true }).click();
      await expect(blocks.getByRole("button", { name: view, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(blocks.getByRole("slider")).toBeVisible({ timeout: 30_000 });
      // The page's other figures once, beside the first view's (regtest may have none of them).
      const names =
        view === "Fees" ? ["Hashrate and difficulty", "Blocks over time"] : ["Blocks over time"];
      await open(names);
      await bothFaces(names, `/mining's ${view} at ${width} px`);
    });
  }
}
