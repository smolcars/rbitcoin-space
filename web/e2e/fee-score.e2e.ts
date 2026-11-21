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

// CI's prose font is wider than this machine's (docs/FRONTEND.md "Other systems' fonts").
test.describe("on a phone, in a wide prose font", () => {
  test.use({ prose: "wide" });
  for (const width of [320, 360]) {
    test(`at ${width} px every figure is in sight and every table fits its panel`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 780 });
      await serveScore(page, MAINNET_1W);
      await page.goto("/regtest/fees/score");
      await expect(levels(page)).toHaveCount(4);
      await page.evaluate(() => document.fonts.ready);
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
    });
  }
});

// Each meter's written interval is clear of the target's tick, the share's mark and the track, at
// a desktop width and at 24 px text, on mainnet's figures and on signet's (all at 0%) (council F-C8).
test.describe("the meters' labels, in a wide prose font", () => {
  test.use({ prose: "wide" });
  for (const [name, answer] of [
    ["mainnet", MAINNET_1W],
    ["signet", SIGNET_1W],
  ] as const) {
    for (const big of [false, true]) {
      test(`on ${name}'s figures${big ? " at 24 px text" : ""}, no label touches the tick, the mark or the line`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await serveScore(page, answer);
        await page.goto("/regtest/fees/score");
        await expect(levels(page)).toHaveCount(4);
        if (big) await page.evaluate(() => (document.documentElement.style.fontSize = "24px"));
        await page.evaluate(() => document.fonts.ready);
        const touching = await page.evaluate(() => {
          const meet = (a: DOMRect, b: DOMRect) =>
            a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          const found: string[] = [];
          for (const meter of document.querySelectorAll(".fee-meter")) {
            const label = meter.querySelector(".fee-meter__range")?.getBoundingClientRect();
            if (!label) continue;
            for (const part of [".fee-meter__target", ".fee-meter__mark", ".fee-meter__track"]) {
              const r = meter.querySelector(part)?.getBoundingClientRect();
              if (r && meet(label, r)) found.push(`${meter.textContent ?? ""} ${part}`);
            }
          }
          return found;
        });
        expect(touching).toStrictEqual([]);
      });
    }
  }
});

// One coordinate system down the panel: every level's line starts and ends at the same x, and its
// target tick is one vertical line, whatever each row holds (a share or none, a short or a wide
// interval), on every period and at every width (council A-C1). Each period is served a different
// answer: too few blocks, mainnet's week, signet's all-zero week, and the widest labels there are.
test.describe("the meters share one line, in a wide prose font", () => {
  test.use({ prose: "wide" });
  const wide = structuredClone(MAINNET_1W) as { levels: Record<string, unknown>[] };
  for (const l of wide.levels) Object.assign(l, { met: 0.9985, interval: [0.9975, 0.9992] });
  const answers: Record<string, unknown> = {
    "24h": MAINNET_24H,
    "1w": MAINNET_1W,
    "1m": SIGNET_1W,
    all: wide,
  };
  for (const width of [1280, 360, 320]) {
    test(`at ${width} px on every period`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route(/\/regtest\/app\/fees\/score\?window=(\w+)$/, (r) => {
        const w = new URL(r.request().url()).searchParams.get("window") ?? "";
        return r.fulfill({ json: { ...(answers[w] as object), window: w } });
      });
      const faults: string[] = [];
      for (const w of Object.keys(answers)) {
        await page.goto(`/regtest/fees/score?window=${w}`);
        await expect(page.locator(".fee-level")).toHaveCount(4);
        await page.evaluate(() => document.fonts.ready);
        const edges = await page.evaluate(() =>
          [...document.querySelectorAll(".fee-meter")].map((m) => {
            const t = m.querySelector(".fee-meter__track")?.getBoundingClientRect();
            const tick = m.querySelector(".fee-meter__target")?.getBoundingClientRect();
            return [t?.left ?? -1, t?.right ?? -1, tick?.left ?? -1];
          }),
        );
        for (const i of [0, 1, 2]) {
          const xs = edges.map((e) => e[i] ?? -1);
          if (Math.max(...xs) - Math.min(...xs) > 1)
            faults.push(
              `${w}: ${["left", "right", "tick"][i]} ${xs.map((x) => Math.round(x)).join(", ")}`,
            );
        }
      }
      expect(faults).toStrictEqual([]);
    });
  }
});

// At a phone's width and any text size neither table scrolls sideways: where one does not fit
// its panel each level is a labelled group, its figures under its name; where it fits, the compact
// table stays (council A-C3).
test.describe("the two tables at larger text, in a wide prose font", () => {
  test.use({ prose: "wide" });
  for (const width of [320, 360]) {
    test(`at ${width} px, no figure is scrolled away from its level`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await serveScore(page, MAINNET_1W);
      await page.goto("/regtest/fees/score");
      await expect(levels(page)).toHaveCount(4);
      const faults: string[] = [];
      for (const px of [16, 24, 32]) {
        await page.evaluate((f) => (document.documentElement.style.fontSize = `${f}px`), px);
        await page.evaluate(() => document.fonts.ready);
        // Two frames: the fit is measured in the next one.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const state = await page.evaluate(() =>
          [...document.querySelectorAll(".level-table")].map((box) => {
            const scroller = box.querySelector<HTMLElement>(".table-scroll");
            const grouped = box.classList.contains("level-table--grouped");
            const groups = [...box.querySelectorAll(".level-group")].map((g) => ({
              name: g.querySelector(".level-group__name")?.textContent ?? "",
              figures: g.querySelectorAll("dd").length,
            }));
            const wide = (scroller?.scrollWidth ?? 0) > (scroller?.clientWidth ?? 0) + 1;
            return { grouped, wide, groups };
          }),
        );
        for (const [i, t] of state.entries()) {
          const at = `${px} px text, table ${i + 1}`;
          // Shown as a table only where it fits; grouped only where it does not.
          if (t.wide !== t.grouped) faults.push(`${at}: wide ${t.wide}, grouped ${t.grouped}`);
          if (t.grouped) {
            expect(
              t.groups.map((g) => g.name),
              at,
            ).toStrictEqual(["No rush", "Low", "Medium", "High"]);
            for (const g of t.groups) expect(g.figures, at).toBe(3);
          }
        }
        // At the default size both compact tables stay.
        if (px === 16) for (const t of state) expect(t.grouped).toBe(false);
        // Nothing of the page's own runs past the window (the site's header is not this page's;
        // the periods and the measured table scroll or hide within their own boxes).
        const past = await page.evaluate(() =>
          [...document.querySelectorAll(".fee-score *")]
            .filter((e) => !e.closest(".periods, .level-table__table, .visually-hidden"))
            .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5)
            .map((e) => `${e.tagName.toLowerCase()}.${e.className}`),
        );
        expect(past, `${px} px text`).toStrictEqual([]);
      }
      expect(faults).toStrictEqual([]);
    });
  }
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
