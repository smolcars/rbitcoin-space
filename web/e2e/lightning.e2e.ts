import { chain, expect, test } from "./fixtures";
import { ACINQ, mainnet, recorded, serve } from "./lightning-answers";
import { tablesFit, tapRow } from "./rows";

test("the header offers no Lightning on regtest, where it is off, and a typed address says so", async ({
  page,
}) => {
  await page.goto("/regtest/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Mining" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Lightning" })).toHaveCount(0);
  await page.goto("/regtest/lightning");
  await expect(page.getByText("Lightning is switched off on Regtest")).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);

  for (const path of [`/regtest/lightning/node/${ACINQ}`, "/regtest/lightning/channel/1x2x3"]) {
    await page.goto(path);
    await expect(page.getByText("Lightning is switched off on Regtest")).toBeVisible();
  }
});

test("a transaction page on a network without Lightning asks only its status", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/app/lightning/")) asked.push(new URL(r.url()).pathname);
  });
  await page.goto(`/regtest/tx/${chain.txs.script_types}`);
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  await expect.poll(() => asked).toStrictEqual(["/regtest/app/lightning/status"]);
  await expect(page.getByRole("heading", { name: "Lightning" })).toHaveCount(0);
});

// "← Nodes by open channels" once pushed "History" onto a line of its own on a phone.
test("a node reached from a ranking keeps its section's links on one line on a phone", async ({
  page,
}) => {
  // The ranking by channels in the recorded ranking's shape.
  await serve(page, { ...mainnet(), "rankings/channels?limit=100": recorded("rankings-capacity") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/regtest/lightning/rankings?by=channels");
  await page.getByRole("main").getByRole("link", { name: "ACINQ" }).first().click();
  await expect(page.locator(".ln-nav__back")).toHaveText("← Nodes by open channels");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const tops = await page
      .locator(".ln-nav__item")
      .evaluateAll((all) => all.map((a) => Math.round(a.getBoundingClientRect().top)));
    expect(new Set(tops).size, `${width} px: ${tops.join(", ")}`).toBe(1);
  }
});

test("the overview, a node and a channel, from mainnet's answers", async ({ page }) => {
  await serve(page, mainnet());
  await page.goto("/regtest/lightning");
  await expect(page.getByRole("heading", { name: "The network now" })).toBeVisible();
  await expect(page.locator("dl").getByText(/^36\s228$/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Newest channels" })).toBeVisible();

  const connected = page.getByRole("table", { name: "The five nodes with the most channels" });
  await connected.getByRole("link", { name: "ACINQ" }).click();
  await expect(page).toHaveURL(`/regtest/lightning/node/${ACINQ}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ACINQ");
  await expect(page.getByText("Page 1 of 73")).toBeVisible();

  await page.getByRole("link", { name: "811984x2037x0" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Channel 811984x2037x0");
  // Back to where the reader came from: the node, by its name.
  await expect(page.locator(".ln-nav__back")).toHaveText("← ACINQ");
  await expect(page.getByRole("heading", { name: "Who charges what" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^811\s984$/ })).toHaveAttribute(
    "href",
    /^\/regtest\/block\/0{18}/,
  );
});

test("the header's search suggests nodes by name, on a phone too, and opens one", async ({
  page,
}) => {
  await serve(page, mainnet());
  await page.goto("/regtest/lightning");
  const field = page.getByRole("search").getByRole("combobox", { name: "Search" });
  const list = page.getByRole("listbox", { name: "Lightning nodes" });
  // Escape closes the list and keeps the query.
  await field.fill("acinq");
  await expect(list).toBeVisible();
  await field.press("Escape");
  await expect(list).toBeHidden();
  await expect(field).toHaveValue("acinq");
  await field.fill("acinq");
  await expect(list.getByRole("option")).toHaveText([
    /^ACINQ.*03864ef025/,
    "All results for “acinq”",
  ]);
  await field.press("ArrowDown");
  await expect(field).toHaveAttribute("aria-activedescendant", /option-0$/);
  await field.press("Enter");
  await expect(page).toHaveURL(`/regtest/lightning/node/${ACINQ}`);

  // Enter on a name, with no suggestion picked, opens every result.
  await field.fill("acinq");
  await expect(list).toBeVisible();
  await field.press("Enter");
  await expect(page).toHaveURL("/regtest/lightning/search?q=acinq");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Results for “acinq”");
  await expect(page.getByRole("main").getByRole("link", { name: "ACINQ" })).toHaveAttribute(
    "href",
    `/regtest/lightning/node/${ACINQ}`,
  );

  // A phone: the list spans the searching row, inside the screen, and a press opens a node.
  await page.setViewportSize({ width: 320, height: 640 });
  await field.fill("acinq");
  const box = await list.boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await list.getByRole("option").first().click();
  await expect(page).toHaveURL(`/regtest/lightning/node/${ACINQ}`);
});

test("hostile names stay inert text and never widen the page", async ({ page }) => {
  const hostile = ['<img src=x onerror="pwned=1">', "‮QNICA", "😀".repeat(5000), "W".repeat(10_000)];
  const node = (alias: string, i: number) => ({
    id: `03${String(i).repeat(64)}`,
    alias,
    capacity: 100_000_000,
    channels: 3,
  });
  await serve(page, {
    status: recorded("status"),
    "search?q=acinq": { nodes: hostile.map((a, i) => node(a, i)), channels: [] },
    [`nodes/${ACINQ}`]: {
      ...(recorded("node-acinq") as object),
      alias: hostile[3],
      color: "red;x",
    },
    [`nodes/${ACINQ}/history`]: recorded("node-acinq-history"),
  });
  await page.goto("/regtest/lightning/search?q=acinq");
  await expect(page.getByText("�QNICA")).toBeVisible();
  await expect(page.getByText(hostile[0] ?? "")).toBeVisible();
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  await expect(page.locator("main img")).toHaveCount(0);
  const wide = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
  expect(await wide()).toBe(false);

  await page.goto(`/regtest/lightning/node/${ACINQ}`);
  await expect(page.getByRole("button", { name: "Show the whole name" })).toBeVisible();
  expect(await wide()).toBe(false);
});

test("a transaction page links the channel its transaction opened", async ({ page }) => {
  const overview = recorded("overview") as { opened: { id: string }[] };
  await serve(page, {
    status: recorded("status"),
    [`tx/${chain.txs.script_types}`]: { opened: overview.opened.slice(0, 1), closed: [] },
  });
  await page.goto(`/regtest/tx/${chain.txs.script_types}`);
  await expect(page.getByText("This transaction opened Lightning channel")).toBeVisible();
  await expect(
    page.getByRole("link", { name: overview.opened[0]?.id ?? "missing" }),
  ).toHaveAttribute("href", `/regtest/lightning/channel/${overview.opened[0]?.id ?? ""}`);
});

// The narrowest phone, strictly: 390 and 720 px are in "Lightning's lists" below.
for (const width of [320]) {
  test(`every Lightning table fits at ${width} px`, async ({ page }) => {
    await serve(page, mainnet());
    await page.setViewportSize({ width, height: 800 });
    for (const path of [
      "/regtest/lightning",
      `/regtest/lightning/node/${ACINQ}`,
      "/regtest/lightning/search?q=acinq",
      "/regtest/lightning/rankings",
      "/regtest/lightning/channel/811984x2037x0",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // Every page here links a node once its answer is drawn.
      await expect(
        page.locator('main a[href*="/lightning/node/"]:not(.table__rowlink)').first(),
      ).toBeVisible();
      for (const t of await page.getByRole("table").all()) {
        const box = await t.evaluate((el) => ({
          table: el.scrollWidth,
          room: (el.parentElement as HTMLElement).clientWidth,
        }));
        expect(box.table, `${path}: table width`).toBeLessThanOrEqual(box.room);
      }
      // What sticks out past the viewport, named, so a failure on another platform says why.
      const over = await page.evaluate((w) => {
        const out: string[] = [];
        for (const el of document.querySelectorAll("main *")) {
          const r = el.getBoundingClientRect();
          if (r.right > w + 0.5 && !el.closest(".table-scroll")) {
            out.push(
              `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""} ${Math.round(r.right)}`,
            );
          }
        }
        return out.slice(0, 5);
      }, width);
      const scrolled = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrolled, `${path}: page width; past it: ${over.join(", ")}`).toBeLessThanOrEqual(
        width,
      );
    }
  });
}

// Right-aligned figures once ran into the next column's text ("RankNode", "0.17000000Active"):
// at every width, the text of neighbouring cells keeps a gutter between them.
for (const width of [360, 768, 1440]) {
  test(`every Lightning table keeps a gutter between columns at ${width} px`, async ({ page }) => {
    await serve(page, mainnet());
    await page.setViewportSize({ width, height: 900 });
    for (const path of [`/regtest/lightning/node/${ACINQ}`, "/regtest/lightning/rankings"]) {
      await page.goto(path);
      await expect(
        page.locator('main a[href*="/lightning/node/"]:not(.table__rowlink)').first(),
      ).toBeVisible();
      const tight = await page.evaluate(() => {
        const out: string[] = [];
        for (const row of document.querySelectorAll("main table tr")) {
          const boxes = [...row.querySelectorAll("th, td")]
            .filter((c) => (c as HTMLElement).offsetParent !== null)
            .map((c) => {
              // The visible text only: a unit hidden for screen readers takes no room.
              let left = Number.POSITIVE_INFINITY;
              let right = Number.NEGATIVE_INFINITY;
              const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
              for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                if (n.parentElement?.closest(".visually-hidden, .table__long")) continue;
                const range = document.createRange();
                range.selectNodeContents(n);
                for (const r of range.getClientRects()) {
                  if (r.width === 0) continue;
                  left = Math.min(left, r.left);
                  right = Math.max(right, r.right);
                }
              }
              return {
                left,
                right,
                extent: right > left ? right - left : 0,
                text: c.textContent ?? "",
              };
            })
            .filter((b) => b.extent > 0);
          for (let i = 1; i < boxes.length; i++) {
            const a = boxes[i - 1];
            const b = boxes[i];
            if (a && b && b.left - a.right < 8) out.push(`${a.text}|${b.text}`);
          }
        }
        return out.slice(0, 5);
      });
      expect(tight, `${path} at ${width} px`).toStrictEqual([]);
    }
  });
}

test("History in the section's links lands on the overview's chart from any Lightning page", async ({
  page,
}) => {
  await serve(page, mainnet());
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const from of [
      `/regtest/lightning/node/${ACINQ}`,
      "/regtest/lightning/channel/811984x2037x0",
      "/regtest/lightning/rankings",
    ]) {
      await page.goto(from);
      const nav = page.getByRole("navigation", { name: "Lightning" });
      await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Rankings" })).toBeVisible();
      await nav.getByRole("link", { name: "History" }).click();
      await expect(page).toHaveURL(/\/regtest\/lightning#history$/);
      // One current destination: the chart, now the reader is on it.
      await expect(nav.locator('[aria-current="location"]')).toHaveText("History");
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
      const heading = page.getByRole("heading", { name: "Over time" });
      await expect(heading).toBeInViewport();
      // Clear of the sticky header, not under it.
      const header = await page.locator(".site-header").boundingBox();
      const top = (await heading.boundingBox())?.y ?? 0;
      expect(top, `${from} at ${width} px`).toBeGreaterThanOrEqual(
        (header?.y ?? 0) + (header?.height ?? 0),
      );
    }
  }
});

test.describe("Lightning's lists", () => {
  // A tap opens a node or channel with no recorded answer, which the stand-in refuses with a 500.
  test.use({ consoleErrorsAllowed: [/status of 500/] });
  const pages = [
    "/regtest/lightning",
    "/regtest/lightning/rankings",
    `/regtest/lightning/node/${ACINQ}`,
    "/regtest/lightning/search?q=acinq",
  ];

  // A phone shows a node's channels as cards (policies-node.e2e.ts), not a table.
  const tabled = (width: number) => pages.filter((p) => width >= 640 || !p.includes("/node/"));

  test("every row opens its item from anywhere on it, at a phone's width", async ({ page }) => {
    await serve(page, mainnet());
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of tabled(390)) {
      await page.goto(path);
      const tables = page.locator("table.table--rows");
      await expect(tables.first()).toBeVisible();
      const count = await tables.count();
      for (let i = 0; i < count; i++) {
        if (i > 0) await page.goto(path);
        await tapRow(page, page.locator("table.table--rows").nth(i), `${path}, table ${i + 1}`);
      }
    }
  });

  // A test a width: all three in one outran 30 s in WebKit at a phone's pixel density on CI's runner.
  for (const width of [320, 390, 720]) {
    test(`every table fits its panel or shows that it scrolls, at ${width} px`, async ({
      page,
    }) => {
      await serve(page, mainnet());
      await page.setViewportSize({ width, height: 900 });
      for (const path of tabled(width)) {
        await page.goto(path);
        await expect(page.locator("table.table--rows tbody tr").first()).toBeVisible();
        await tablesFit(page, `${path} at ${width} px`);
      }
    });
  }
});

test("the overview's own links mark one current place at a time", async ({ page }) => {
  await serve(page, mainnet());
  await page.goto("/regtest/lightning");
  const nav = page.getByRole("navigation", { name: "Lightning" });
  await expect(nav.locator(":is([aria-current='page'], [aria-current='location'])")).toHaveText(
    "Overview",
  );
});

// The network's totals are samples every ten minutes: while there are few, each is marked, so a
// line between two reads as two looks rather than a measurement of the time between.
test("the overview marks its samples while they are few, and not once they are many", async ({
  page,
}) => {
  const point = recorded("statistics-1w") as { points: Record<string, number>[] } & Record<
    string,
    unknown
  >;
  const one = point.points[0] ?? {};
  const series = (n: number) => ({
    ...point,
    complete: true,
    first: 1_794_508_200 - (n - 1) * 600,
    from: 1_794_508_200 - (n - 1) * 600,
    to: 1_794_508_219,
    sampled: n,
    slots: n,
    points: Array.from({ length: n }, (_, i) => ({
      ...one,
      time: 1_794_508_200 - (n - 1 - i) * 600,
      channels: (one["channels"] ?? 0) + i * 3,
    })),
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [n, marks] of [
    [3, 6],
    [400, 0],
  ] as const) {
    await serve(page, { ...mainnet(), "statistics/1w": series(n) });
    await page.goto("/regtest/lightning");
    await expect(page.getByRole("slider", { name: /Lightning channels/ })).toBeVisible();
    await expect(page.locator(".ln-history .chart__mark")).toHaveCount(marks);
  }
});
