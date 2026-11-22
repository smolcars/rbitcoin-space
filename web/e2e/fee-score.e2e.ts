import type { Page } from "@playwright/test";
import { MAINNET_1W, MAINNET_24H, SIGNET_1W } from "../src/pages/fees/testdata";
import { expect, test } from "./fixtures";
import { serveScore } from "./score-answers";

const levels = (page: Page) => page.getByRole("heading", { level: 3 });

test("the home page's fee panel links to the track record, which keeps its window in the address", async ({
  page,
}) => {
  await page.goto("/regtest/");
  await page
    .getByRole("region", { name: "Fee to pay now" })
    .getByRole("link", { name: "Track record" })
    .click();
  await expect(page).toHaveURL(/\/regtest\/fees\/score$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fee track record");
  // Regtest's own answer: a young server has too few blocks for any share, or nothing at all.
  await expect(
    page.getByText("Too few blocks yet").first().or(page.getByText("Nothing recorded")),
  ).toBeVisible();
  const periods = page.getByRole("navigation", { name: "Period" });
  await expect(periods.getByRole("link", { name: /the last week/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const asked = page.waitForRequest(/\/regtest\/app\/fees\/score\?window=24h$/);
  await periods.getByRole("link", { name: /the last 24 hours/ }).click();
  await asked;
  await expect(page).toHaveURL(/\/regtest\/fees\/score\?window=24h$/);
  await expect(periods.getByRole("link", { name: /the last 24 hours/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("on a test network a level under its target is no fair test, beside those that meet theirs", async ({
  page,
}) => {
  await serveScore(page, MAINNET_1W);
  await page.goto("/regtest/fees/score");
  await expect(levels(page)).toHaveText(["No rush", "Low", "Medium", "High"]);
  const noRush = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "No rush" }) });
  // Regtest is a test network: the share and its interval stay, the verdict is not a failure.
  await expect(noRush.getByText("Not a fair test here")).toBeVisible();
  await expect(noRush.getByText("67.4%")).toBeVisible();
  await expect(noRush.locator(".fee-meter__range")).toHaveText("63.3–71.4%");
  await expect(
    page.getByRole("region", { name: "Mined in time" }).getByText(/On a test network/),
  ).toBeVisible();
  const high = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "High" }) });
  await expect(high.getByText("Meets target")).toBeVisible();
  await expect(page.getByRole("table", { name: /What each level recommended/ })).toBeVisible();
  await expect(page.getByRole("table", { name: /The answers and blocks behind/ })).toBeVisible();
  await expect(page.getByText(/^In 539 samples from this period/)).toBeVisible();
});

test.describe("on a phone, in a wide prose font", () => {
  test("at 320 and 360 px every figure is in sight and every table fits its panel", async ({
    page,
  }) => {
    await serveScore(page, MAINNET_1W);
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto("/regtest/fees/score");
    await expect(levels(page)).toHaveCount(4);
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 780 });
      const fit = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tables: [...document.querySelectorAll(".fee-score .table-scroll")].map(
          (t) => t.scrollWidth - t.clientWidth,
        ),
      }));
      expect(fit).toStrictEqual({ page: 0, tables: [0, 0] });
      // Each kind left out is named in its cell: none is dropped with a column.
      const evidence = page.getByRole("table", { name: /The answers and blocks behind/ });
      await expect(evidence.getByRole("row", { name: /^High/ })).toContainText(
        "34 not finished, 4 no clearing rate",
      );
      // The overpaid pair is mean over median in every row, each whole on its line, "under 0.01"
      // included (council A-C2).
      const pairs = await page.locator(".fee-score__pair").evaluateAll((els) =>
        els.map((e) => {
          const [mean, median] = [...e.querySelectorAll(".num")].map((n) =>
            n.getBoundingClientRect(),
          );
          const lh = Number.parseFloat(getComputedStyle(e).lineHeight);
          return {
            text: e.textContent ?? "",
            below: Math.round((median?.top ?? 0) - (mean?.top ?? 0)),
            whole: (mean?.height ?? 99) < lh * 1.5 && (median?.height ?? 99) < lh * 1.5,
          };
        }),
      );
      expect(pairs.some((p) => p.text.includes("under 0.01"))).toBe(true);
      for (const p of pairs) {
        expect(p.whole, p.text).toBe(true);
        expect(p.below, p.text).toBeGreaterThan(0);
        expect(p.below, p.text).toBe(pairs[0]?.below);
      }
      // Each legend item's swatch is on the line of its words (council N-C5).
      const apart = await page.evaluate(() => {
        const key = document.querySelector(".fee-score__key");
        const mid = (r: DOMRect) => (r.top + r.bottom) / 2;
        const words = (text: string) => {
          const walk = document.createTreeWalker(key ?? document.body, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode())
            if (n.textContent?.includes(text)) {
              const range = document.createRange();
              range.selectNodeContents(n);
              return range.getBoundingClientRect();
            }
          return undefined;
        };
        return [
          [".fee-key--target", "target"],
          [".fee-key--band", "interval"],
        ].map(([swatch, text]) => {
          const s = key?.querySelector(swatch ?? "")?.getBoundingClientRect();
          const w = words(text ?? "");
          return s && w ? Math.round(Math.abs(mid(s) - mid(w))) : -1;
        });
      });
      for (const d of apart) expect(d).toBeGreaterThanOrEqual(0);
      for (const d of apart) expect(d).toBeLessThan(8);
      // The period switch, wrapped under the title, starts at its left edge.
      const [title, periods] = await Promise.all([
        page.getByRole("heading", { level: 1 }).boundingBox(),
        page.getByRole("navigation", { name: "Period" }).boundingBox(),
      ]);
      expect(periods?.y).toBeGreaterThan((title?.y ?? 0) + (title?.height ?? 0) - 1);
      expect(Math.round(periods?.x ?? -1)).toBe(Math.round(title?.x ?? 0));
    }
  });
});

// Every period at every size, one page load a period, in CI's wider prose font: at 1280, 360 and
// 320 px with 16, 24 and 32 px text, between the layouts at 700, 900 and 1100 px with 24 and 32 px,
// and at 630 px with 16 px (council F-C8, A-C1, A-C3, N-C6; code review S-1, G-2, G-3, S-5, G-6).
// - The rows: each is one named layout with its own figure, "mined within" line and line ends,
//   never a mix of two; no verdict leaves the window and the page never scrolls sideways.
// - The meters: every line has a real width (a third of its row at least), all start and end at
//   one x with the target one vertical line, and no interval label touches the tick, the share's
//   mark or the line.
// - The tables: a table is shown only where it fits and grouped only where it does not, each group
//   its level's name over all its figures; at 32 px on a phone one is grouped, and back at 16 px
//   mainnet's week is two tables again.
// - The periods show all four with nothing to scroll; nothing of the page runs past the window.
// Each period is served a different answer: too few blocks, mainnet's week, signet's all-zero
// week, and the widest labels there are.
test.describe("every period at every width and text size, in a wide prose font", () => {
  const wide = structuredClone(MAINNET_1W) as { levels: Record<string, unknown>[] };
  for (const l of wide.levels) Object.assign(l, { met: 0.9985, interval: [0.9975, 0.9992] });
  const answers: Record<string, unknown> = {
    "24h": MAINNET_24H,
    "1w": MAINNET_1W,
    "1m": SIGNET_1W,
    all: wide,
  };
  const SIZES = [
    ...[1280, 360, 320].flatMap((w) => [16, 24, 32].map((px) => [w, px] as const)),
    ...[700, 900, 1100].flatMap((w) => [24, 32].map((px) => [w, px] as const)),
    [630, 16] as const,
  ];

  /** What is wrong with the meters and the page's width as drawn now. */
  const meterFaults = (page: Page) =>
    page.evaluate(() => {
      const out: string[] = [];
      const meet = (a: DOMRect, b: DOMRect) =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const rows = [...document.querySelectorAll(".fee-level")];
      const edges = rows.map((row) => {
        const meter = row.querySelector(".fee-meter");
        const t = meter?.querySelector(".fee-meter__track")?.getBoundingClientRect();
        const tick = meter?.querySelector(".fee-meter__target")?.getBoundingClientRect();
        const width = row.getBoundingClientRect().width;
        if (!t || t.width < width / 3)
          out.push(`a line ${Math.round(t?.width ?? 0)} px wide in a ${Math.round(width)} px row`);
        const label = meter?.querySelector(".fee-meter__range")?.getBoundingClientRect();
        for (const part of [".fee-meter__target", ".fee-meter__mark", ".fee-meter__track"]) {
          const r = meter?.querySelector(part)?.getBoundingClientRect();
          if (label && r && meet(label, r)) out.push(`the interval's label touches ${part}`);
        }
        return [t?.left ?? -1, t?.right ?? -1, tick?.left ?? -1];
      });
      for (const i of [0, 1, 2]) {
        const xs = edges.map((e) => e[i] ?? -1);
        if (Math.max(...xs) - Math.min(...xs) > 1)
          out.push(`${["left", "right", "tick"][i]} ${xs.map((x) => Math.round(x)).join(", ")}`);
      }
      // The row's layout, told by its grid, and the parts that layout shows or hides with it.
      const LAYOUTS: Record<string, [align: string, said: boolean, ends: boolean]> = {
        "name figure meter verdict": ["normal", true, true],
        "name verdict figure meter": ["normal", true, true],
        "name figure name verdict meter meter": ["end", false, false],
        "name figure verdict meter": ["start", false, false],
      };
      for (const row of rows) {
        const areas = [...getComputedStyle(row).gridTemplateAreas.matchAll(/[a-z]+/g)]
          .map((m) => m[0])
          .filter((a) => a !== "detail")
          .join(" ");
        const shown = (sel: string) => {
          const e = row.querySelector(sel);
          return !!e && getComputedStyle(e).display !== "none";
        };
        const figure = row.querySelector(".fee-level__figure");
        const has: [string, boolean, boolean] = [
          figure ? getComputedStyle(figure).justifyItems : "",
          shown(".fee-level__said"),
          shown(".fee-meter__end"),
        ];
        const want = LAYOUTS[areas];
        if (!want || want.join(",") !== has.join(","))
          out.push(`a row laid out as "${areas}" with ${has.join(", ")}: not one layout`);
        const verdict = row.querySelector(".fee-level__verdict")?.getBoundingClientRect();
        if (!verdict || verdict.left < -0.5 || verdict.right > window.innerWidth + 0.5)
          out.push(
            `a verdict at ${Math.round(verdict?.left ?? -1)}–${Math.round(verdict?.right ?? -1)} px`,
          );
      }
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth) out.push(`the page ${root.scrollWidth} px wide`);
      const periods = document.querySelector(".periods ul");
      if (periods && periods.scrollWidth > periods.clientWidth + 1) out.push("the periods scroll");
      // The site's header is not this page's; the measured table hides within its own box.
      for (const e of document.querySelectorAll(".fee-score *"))
        if (
          !e.closest(".level-table__table, .visually-hidden") &&
          e.getBoundingClientRect().right > window.innerWidth + 0.5
        )
          out.push(`${e.tagName.toLowerCase()}.${e.className} runs past the window`);
      return out;
    });

  /** Each table: whether it is too wide for its panel, whether it is grouped, and its groups. */
  const tables = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll(".level-table")].map((box) => {
        const scroller = box.querySelector<HTMLElement>(".table-scroll");
        return {
          wide: (scroller?.scrollWidth ?? 0) > (scroller?.clientWidth ?? 0) + 1,
          grouped: box.classList.contains("level-table--grouped"),
          groups: [...box.querySelectorAll(".level-group")].map(
            (g) =>
              `${g.querySelector(".level-group__name")?.textContent ?? ""}:${g.querySelectorAll("dd").length}`,
          ),
        };
      }),
    );

  test("the meters, the tables and the periods hold", async ({ page }) => {
    test.setTimeout(60_000);
    await page.route(/\/regtest\/app\/fees\/score\?window=(\w+)$/, (r) => {
      const w = new URL(r.request().url()).searchParams.get("window") ?? "";
      return r.fulfill({ json: { ...(answers[w] as object), window: w } });
    });
    const faults: string[] = [];
    for (const w of Object.keys(answers)) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/regtest/fees/score?window=${w}`);
      await expect(page.locator(".fee-level")).toHaveCount(4);
      for (const [width, px] of SIZES) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((f) => (document.documentElement.style.fontSize = `${f}px`), px);
        const at = `${w}, ${width} px, ${px} px text`;
        // The tables are fitted in the frame after a resize notice: wait for the state, never a
        // count of frames, and read the page once it is settled.
        await expect
          .poll(async () => (await tables(page)).every((t) => t.wide === t.grouped), {
            message: at,
          })
          .toBe(true);
        for (const f of await meterFaults(page)) faults.push(`${at}: ${f}`);
        const now = await tables(page);
        for (const t of now)
          if (t.grouped)
            expect(t.groups, at).toStrictEqual(["No rush:3", "Low:3", "Medium:3", "High:3"]);
        if (width < 400 && px === 32)
          expect(
            now.some((t) => t.grouped),
            at,
          ).toBe(true);
      }
      // Back to the default text on a phone: mainnet's week fits as two tables again.
      if (w === "1w") {
        await page.evaluate(() => (document.documentElement.style.fontSize = ""));
        await expect
          .poll(async () => (await tables(page)).map((t) => t.grouped))
          .toStrictEqual([false, false]);
      }
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    }
    expect(faults).toStrictEqual([]);
  });
});

test("switching the window replaces every figure with that window's", async ({ page }) => {
  const answers: Record<string, unknown> = { "1w": MAINNET_1W, "24h": MAINNET_24H };
  await page.route(/\/regtest\/app\/fees\/score\?window=(\w+)$/, (r) =>
    r.fulfill({ json: answers[new URL(r.request().url()).searchParams.get("window") ?? ""] }),
  );
  await page.goto("/regtest/fees/score?window=1w");
  const met = (name: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name }) })
      .locator(".fee-level__met");
  const evidence = page.getByRole("table", { name: /The answers and blocks behind/ });
  const highJudged = evidence.getByRole("row", { name: /^High/ }).getByRole("cell").nth(1);
  await expect(met("No rush")).toHaveText("67.4%");
  await expect(met("High")).toHaveText("88.5%");
  await expect(highJudged).toHaveText("19\u202F521");
  await page
    .getByRole("navigation", { name: "Period" })
    .getByRole("link", { name: /the last 24 hours/ })
    .click();
  await expect(page).toHaveURL(/window=24h$/);
  await expect(met("No rush")).toHaveText("–");
  await expect(met("High")).toHaveText("86.3%");
  await expect(highJudged).toHaveText("2\u202F846");
});

test("a level with too few blocks shows no share", async ({ page }) => {
  await serveScore(page, MAINNET_24H);
  await page.goto("/regtest/fees/score?window=24h");
  const noRush = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "No rush" }) });
  await expect(noRush.getByText("Too few blocks yet")).toBeVisible();
  await expect(
    noRush.getByText(/A share is given from 30 blocks; 6 blocks have decided/),
  ).toBeVisible();
  await expect(noRush.locator(".fee-level__met")).toHaveText("–");
});

test.describe("a server without the mempool engine", () => {
  test.use({ consoleErrorsAllowed: [/status of 503/] });
  test("says it keeps no track record", async ({ page }) => {
    await page.route(/\/regtest\/app\/fees\/score(\?|$)/, (r) =>
      r.fulfill({
        status: 503,
        headers: { "Retry-After": "1" },
        json: { error: "the mempool engine is off on this server" },
      }),
    );
    await page.goto("/regtest/fees/score");
    await expect(page.getByText("This server keeps no fee track record")).toBeVisible();
  });
});

test("the palette opens the track record by name", async ({ page }) => {
  await page.goto("/regtest/");
  await page
    .getByRole("list", { name: "Mined blocks, newest first" })
    .getByRole("link")
    .first()
    .waitFor();
  const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent));
  await page.keyboard.press(apple ? "Meta+k" : "Control+k");
  const palette = page.getByRole("dialog", { name: "Go to" });
  await palette.getByRole("combobox").fill("fee track");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(
    "Fee track record",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/regtest\/fees\/score$/);
});
