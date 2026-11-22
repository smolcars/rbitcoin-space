import type { Page } from "@playwright/test";
import { expect, setProse, test } from "./fixtures";

test("the home page links to the mempool's history, which switches interval in the address", async ({
  page,
}) => {
  await page.goto("/regtest/");
  await page.getByRole("link", { name: "Mempool history" }).click();
  await expect(page).toHaveURL(/\/regtest\/mempool$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mempool history");
  const periods = page.getByRole("navigation", { name: "Period" });
  // A young server has nothing yet or its first minutes: either is an answer, never an error.
  const answered = page
    .getByText("Nothing recorded yet")
    .or(page.getByRole("slider", { name: /The mempool's size by fee rate/ }));
  await expect(answered).toBeVisible();
  // Its records begin inside the day, so the view starts where they do, and says so in the
  // choice it marks: "24 h" is kept for the whole day.
  const recorded = periods.getByRole("link", { name: /^Recorded/ });
  await expect(recorded).toHaveAttribute("aria-current", "page");
  await expect(periods.getByRole("link", { name: /the last 24 hours/ })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await periods.getByRole("link", { name: /the last 24 hours/ }).click();
  await expect(page).toHaveURL(/\/regtest\/mempool\?interval=24h$/);
  await expect(periods.getByRole("link", { name: /the last 24 hours/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(recorded).toHaveCount(0);
  await expect(page.getByText("No data stored").first()).toBeVisible();
  await periods.getByRole("link", { name: /the last 2 hours/ }).click();
  await expect(page).toHaveURL(/\/regtest\/mempool\?interval=2h$/);
  await expect(periods.getByRole("link", { name: /the last 2 hours/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(answered).toBeVisible();
});

// e2e.sh stores 20 minutes an hour old before the server starts, through the sampler's own writer
// (crates/engine/examples/history_seed.rs): minute i holds 901 + i transactions, and 8 to 12 are
// missing. The sampler's own timing is the engine's tests' to prove (docs/STORE.md). Newest first,
// as the figures table lists them.
const STORED = Array.from({ length: 20 }, (_, i) => 19 - i)
  .filter((i) => i < 8 || i > 12)
  .map((i) => String(901 + i));

test("the page shows the minutes the server stored, with the gap where none was", async ({
  page,
}) => {
  await page.goto("/regtest/mempool?interval=2h");
  const chart = page.getByRole("slider", { name: /The mempool's size by fee rate/ });
  await expect(chart).toHaveAttribute("aria-valuetext", /UTC: Total [\d.]+/);
  await expect(page.getByText(/^(Under 1|\d+)% recorded, from .* UTC\.$/)).toBeVisible();
  const figures = page.getByRole("region", { name: /The mempool's size by fee rate.*, figures/ });
  await page.getByText("Show the figures").click();
  // The table renders after the click: wait for it before reading it once.
  await expect(
    figures.getByRole("columnheader", { name: "Transactions", exact: true }),
  ).toBeVisible();
  const column = (await figures.locator("th").allInnerTexts()).indexOf("Transactions");
  expect(column).toBeGreaterThan(0);
  // Twelve bands: the lowest split three ways, as the server records it.
  for (const band of ["under 0.12 sat/vB", "0.12–0.15 sat/vB", "0.15–0.2 sat/vB", "10+ sat/vB"]) {
    await expect(figures.getByRole("columnheader", { name: band, exact: true })).toBeAttached();
  }
  // The stored minutes are the oldest rows, exactly, so nothing fills the gap; a minute the server
  // records live while the test runs is newer than all of them.
  const counts = await figures.locator(`tbody td:nth-child(${column + 1})`).allInnerTexts();
  expect(counts.slice(-STORED.length)).toEqual(STORED);
});

// The plot once started 650 to 700 px down a phone, its time axis off the first screen.
test("a phone sees the whole size chart, time axis and all, on its first screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/regtest/mempool", "/regtest/mempool?interval=24h"]) {
    await page.goto(path);
    const chart = page.getByRole("slider", { name: /The mempool's size by fee rate/ });
    await expect(chart).toHaveAttribute("aria-valuetext", /UTC: Total [\d.]+/);
    // In the wide faces a Linux machine falls back to, as well as these: CI's runner once put the
    // axis 15 px below the fold that a Mac's fonts kept above it.
    await page.evaluate(() => {
      const root = document.documentElement.style;
      root.setProperty("--font-sans", '"DejaVu Sans", Verdana, sans-serif');
      root.setProperty("--font-mono", '"DejaVu Sans Mono", "Courier New", monospace');
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    // The plot and every label on it, the dates under it included, end above the fold.
    const bottom = await chart.evaluate((el) =>
      Math.max(
        ...[el, ...el.querySelectorAll("svg, svg text")].map(
          (e) => e.getBoundingClientRect().bottom,
        ),
      ),
    );
    expect(bottom, path).toBeLessThanOrEqual(844);
    // Above it, one row of periods and one line of coverage.
    const periods = page.getByRole("navigation", { name: "Period" }).locator("ul");
    const rows = await periods.evaluate(
      (ul) =>
        new Set([...ul.children].map((li) => Math.round(li.getBoundingClientRect().top))).size,
    );
    expect(rows, path).toBe(1);
    const coverage = page.locator(".mempool-coverage");
    if ((await coverage.count()) > 0) {
      const lines = await coverage.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        // Tops more than half a line apart: the hatch swatch beside the words sits a pixel off.
        const tops = [...range.getClientRects()].map((r) => r.top);
        tops.sort((x, y) => x - y);
        return tops.filter((t, i) => i === 0 || t - (tops[i - 1] ?? t) > 8).length;
      });
      expect(lines, `${path}: coverage lines`).toBe(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    // The readout above the plot holds the time, total, transactions and lowest rate.
    await expect(page.locator(".mempool-now")).toContainText(/UTC.*tx, from [\d.]+ sat\/vB/);
    // "Show the figures" is a finger's target.
    const figures = page.getByText("Show the figures");
    expect((await figures.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

/** Two hours of mainnet-like minutes: the bulk under 0.15, blocks mined in some minutes. */
function mainnetLike() {
  const to = Math.floor(Date.now() / 60_000) * 60;
  const points = Array.from({ length: 116 }, (_, i) => ({
    time: to - (115 - i) * 60,
    bands: [
      18_000_000, 8_000_000, 40_000, 200_000, 90_000, 150_000, 30_000, 180_000, 140_000, 10_000,
      5000, 2000,
    ],
    vsize: 26_847_000,
    count: 45_000 + i,
    fees: 4_000_000,
    min_fee_rate: 100,
    samples: 1,
    in_count: 10,
    // Arrivals step up in the second hour, so the flow's ten-minute means differ along the plot.
    in_vsize: i < 60 ? 120_000 : 240_000,
    out_count: 9,
    out_vsize: i % 10 === 0 ? 98_765_432 : 1_234_567,
    mined_count: i % 10 === 0 ? 3000 : 0,
    mined_vsize: i % 10 === 0 ? 87_654_321 : 0,
  }));
  const from = points[0]?.time ?? to;
  return {
    complete: true,
    first: from,
    from,
    to: to + 59,
    interval: "2h",
    minutes: 116,
    sampled: 116,
    step: 60,
    points,
  };
}

test("a tap anywhere along a phone's plot reads it without moving it", async ({
  browser,
  baseURL,
}) => {
  const touch = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  await setProse(touch);
  const page = await touch.newPage();
  await page.route(/\/app\/mempool\/history\/2h$/, (r) => r.fulfill({ json: mainnetLike() }));
  await page.goto(`${baseURL ?? ""}/regtest/mempool?interval=2h`);
  const plot = page.getByRole("slider", { name: /The mempool's size by fee rate/ });
  await expect(plot).toHaveAttribute("aria-valuetext", /UTC/);
  await plot.scrollIntoViewIfNeeded();
  const top = () => plot.evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
  const at = await top();
  const box = await plot.locator("svg").boundingBox();
  if (!box) throw new Error("no plot");
  // Every eleventh minute, on the size and on the flow: mined minutes and quiet ones both come up.
  for (let k = 0; k < 116; k += 11) {
    for (const y of [0.3, 0.85]) {
      await page.touchscreen.tap(box.x + (box.width * (k + 0.5)) / 116, box.y + box.height * y);
      expect(await top(), `tap at minute ${k}`).toBe(at);
    }
  }
  await touch.close();
});

// The key is the readout at the crosshair and the filter: one press hides the cheap bulk so the
// dearer bands fill the plot, and the flow's figures follow the same crosshair as the bands'.
test("the fee key filters the bands and reads both charts at the crosshair", async ({ page }) => {
  await page.route(/\/app\/mempool\/history\/2h$/, (r) => r.fulfill({ json: mainnetLike() }));
  await page.goto("/regtest/mempool?interval=2h");
  const plot = page.getByRole("slider", { name: /The mempool's size by fee rate/ });
  await expect(plot).toHaveAttribute("aria-valuetext", /UTC/);
  const layers = page.locator(".mempool-canvas svg path.mempool-layer");
  await expect(layers).toHaveCount(12);
  await page.getByRole("button", { name: "From 0.15 up" }).click();
  await expect(layers).toHaveCount(10);
  await expect(page.locator(".mempool-now")).toContainText(/ of 26\.85 MvB/);
  await expect(page.getByRole("button", { name: /^under 0\.12/ })).toHaveClass(/mempool-band--off/);
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(layers).toHaveCount(12);
  await expect(page.locator(".mempool-band--off")).toHaveCount(0);

  const arrived = page.locator(".mempool-flowkey li").first();
  const when = page.locator(".mempool-now__when");
  const box = await plot.locator("svg").boundingBox();
  if (!box) throw new Error("no plot");
  // Near the start, arrivals were 2,000 vB/s; near the end, 4,000.
  await page.mouse.move(box.x + box.width * 0.2, box.y + 40);
  const early = await when.textContent();
  await expect(arrived).toContainText(/2\s000 vB\/s/);
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height - 40);
  await expect(when).not.toHaveText(early ?? "");
  await expect(arrived).toContainText(/4\s000 vB\/s/);
  // The pointer gone, the latest minute again.
  await page.mouse.move(box.x + box.width / 2, box.y - 200);
  await expect(plot).toHaveAttribute("aria-valuemax", "115");
  await expect(plot).toHaveAttribute("aria-valuenow", "115");
});

// Where the lowest band was split, the stacked layers once fell away from the total at the join:
// each layer slid across the minute between bookkeepings. The stack must always meet the line.
test.describe("the join between ten and twelve bands", () => {
  const SPANS = {
    "2h": [60, 116],
    "24h": [600, 140],
    "1w": [3600, 160],
    all: [86_400, 40],
  } as const;
  const rest = [123_806, 40_000, 200_000, 90_000, 150_000, 30_000, 180_000, 140_000, 10_000];
  /** A history whose points have ten bands, then twelve (or the reverse), each summing to vsize. */
  function mixed(interval: keyof typeof SPANS, unsplitFirst: boolean) {
    const [step, n] = SPANS[interval];
    const to = Math.floor(Date.now() / 1000 / step) * step;
    const from = to - (n - 1) * step;
    const points = Array.from({ length: n }, (_, i) => {
      const split = unsplitFirst ? i >= n - 12 : i < 12;
      const low = 26_100_000 + i * 2000;
      const bands = split
        ? [7_402_366, low - 7_402_366 - 123_806, 123_806, ...rest]
        : [low, ...rest];
      const vsize = bands.reduce((s, b) => s + b, 0);
      return {
        time: from + i * step,
        bands,
        vsize,
        count: 45_000,
        fees: 4_000_000,
        min_fee_rate: 100,
        samples: step / 60,
        in_count: 10,
        in_vsize: 1000,
        out_count: 9,
        out_vsize: 900,
        mined_count: 0,
        mined_vsize: 0,
      };
    });
    const minutes = (n * step) / 60;
    return {
      complete: true,
      first: from,
      from,
      to: to + step - 1,
      interval,
      minutes,
      sampled: minutes,
      step,
      points,
    };
  }

  // A test to a width and a direction, so they run side by side.
  for (const width of [390, 1440])
    for (const unsplitFirst of [true, false]) {
      test(`at ${width} px the filled layers meet the total at every x, ${unsplitFirst ? "ten then twelve" : "twelve then ten"}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        for (const interval of ["2h", "24h", "1w", "all"] as const) {
          await page.unrouteAll();
          await page.route(new RegExp(`/regtest/app/mempool/history/${interval}$`), (route) =>
            route.fulfill({ json: mixed(interval, unsplitFirst) }),
          );
          await page.goto(`/regtest/mempool?interval=${interval}`);
          const svg = page.locator(".mempool-canvas svg").first();
          await expect(svg.locator("path.mempool-layer").first()).toBeAttached();
          const [worst, slant] = await svg.evaluate((el) => {
            const layers = [...el.querySelectorAll<SVGPathElement>("path.mempool-layer")];
            // The layer of minutes from before the split, drawn first: at the bottom.
            const unsplit = layers[0];
            // getBBox gives x, y, width and height only (an SVGRect has no right or bottom).
            const boxes = layers.map((l) => l.getBBox());
            const left = Math.min(...boxes.map((r) => r.x));
            const top0 = Math.min(...boxes.map((r) => r.y));
            const box = {
              x: left,
              y: top0,
              right: Math.max(...boxes.map((r) => r.x + r.width)),
              bottom: Math.max(...boxes.map((r) => r.y + r.height)),
            };
            const filled = (x: number, y: number) =>
              layers.some((l) => l.isPointInFill(new DOMPoint(x, y)));
            let most = 0;
            // Where the unsplit layer is drawn, its top sits as far below the total as anywhere
            // (the bands above 0.2): a wedge sloping to the floor at the join would not.
            const below: number[] = [];
            // Across the plot, the join included, a little in from either end: every user unit, or
            // every second where a point's step is several units wide (1440 px), so no step is
            // passed over.
            const stride = box.right - box.x > 600 ? 2 : 1;
            let lastTop: number | undefined;
            for (let x = box.x + 1; x < box.right - 1; x += stride) {
              // The fill runs from the floor up, unbroken: its top by halving.
              let top = box.y - 1;
              let bottom = box.bottom - 0.5;
              if (!filled(x, bottom)) {
                lastTop = undefined;
                continue;
              }
              for (let k = 0; k < 12; k++) {
                const mid = (top + bottom) / 2;
                if (filled(x, mid)) bottom = mid;
                else top = mid;
              }
              // The stack is whole from its top to the floor: a layer that slid at the join leaves a
              // wedge of nothing between it and the next.
              for (let y = bottom + 0.5; y < box.bottom - 0.5; y += 0.5) {
                if (!filled(x, y)) most = Math.max(most, 2);
              }
              // And its top follows the total, which moves by a few hundred vB a step: never a dip.
              if (lastTop !== undefined) most = Math.max(most, Math.abs(bottom - lastTop));
              lastTop = bottom;
              if (unsplit?.isPointInFill(new DOMPoint(x, box.bottom - 0.5))) {
                let up = box.y - 1;
                let down = box.bottom - 0.5;
                for (let k = 0; k < 12; k++) {
                  const mid = (up + down) / 2;
                  if (unsplit.isPointInFill(new DOMPoint(x, mid))) down = mid;
                  else up = mid;
                }
                below.push(down - bottom);
              }
            }
            const spread = below.length > 0 ? Math.max(...below) - Math.min(...below) : 0;
            return [most, spread];
          });
          const label = `${interval}, ${unsplitFirst ? "ten then twelve" : "twelve then ten"}`;
          expect(worst, `${label}: the stack whole and its top unbroken`).toBeLessThan(2);
          expect(slant, `${label}: the unsplit layer up to its join`).toBeLessThan(2);
        }
      });
    }
});

/** A point on screen inside one of the size chart's bands: where a pointer or finger finds one. */
async function pointOnABand(p: Page): Promise<{ x: number; y: number }> {
  await p.locator(".mempool-canvas svg").first().scrollIntoViewIfNeeded();
  const point = await p
    .locator(".mempool-canvas svg")
    .first()
    .evaluate((svg) => {
      const ctm = (svg as SVGSVGElement).getScreenCTM();
      for (const layer of svg.querySelectorAll<SVGPathElement>("path.mempool-layer")) {
        const b = layer.getBBox();
        for (let fy = 0.2; fy < 1; fy += 0.2) {
          for (let fx = 0.1; fx < 1; fx += 0.1) {
            const at = new DOMPoint(b.x + b.width * fx, b.y + b.height * fy);
            if (ctm && layer.isPointInFill(at)) {
              const screen = at.matrixTransform(ctm);
              return { x: screen.x, y: screen.y };
            }
          }
        }
      }
      return null;
    });
  if (!point) throw new Error("no band drawn");
  return point;
}

// A band under the pointer was once repainted in the pink accent: a 25 MvB magenta slab on the
// most natural gesture, its colour no longer its key's. It keeps its own colour now.
test("a band under the pointer, a finger or the keys keeps its colour, and a tap away lets it go", async ({
  browser,
  page,
}) => {
  const plotLayers = (p: typeof page) =>
    p.locator(".mempool-canvas svg path.mempool-layer").evaluateAll((all) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return {
        accent,
        layers: all.map((l) => ({
          on: l.classList.contains("mempool-layer--on"),
          fill: getComputedStyle(l).fill,
          stroke: getComputedStyle(l).stroke,
        })),
      };
    });
  await page.goto("/regtest/mempool?interval=2h");
  const chart = page.getByRole("slider", { name: /The mempool's size by fee rate/ });
  await expect(chart).toHaveAttribute("aria-valuetext", /UTC: Total [\d.]+/);
  const before = await plotLayers(page);
  // The pointer over the stack's lowest part, at the right, where the seeded minutes are.
  const onBand = await pointOnABand(page);
  await page.mouse.move(onBand.x, onBand.y);
  await expect(page.locator(".mempool-canvas .mempool-layer--on")).toHaveCount(1);
  const during = await plotLayers(page);
  for (const [k, l] of during.layers.entries()) {
    expect(l.fill, `layer ${k}`).toBe(before.layers[k]?.fill);
    expect(l.fill, `layer ${k}`).not.toBe(during.accent);
    expect(l.stroke, `layer ${k}`).not.toBe(during.accent);
  }
  // The keys move the reading, and paint nothing in the accent either.
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  for (const l of (await plotLayers(page)).layers) expect(l.fill).not.toBe(during.accent);

  // A finger: a tap picks a band; a tap anywhere else lets it go.
  const touch = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  await setProse(touch);
  const phone = await touch.newPage();
  await phone.goto(`${new URL(page.url()).origin}/regtest/mempool?interval=2h`);
  const phoneChart = phone.getByRole("slider", { name: /The mempool's size by fee rate/ });
  await expect(phoneChart).toHaveAttribute("aria-valuetext", /UTC: Total [\d.]+/);
  const onPhoneBand = await pointOnABand(phone);
  const plotTop = () =>
    phoneChart.evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));
  const top = await plotTop();
  await phone.touchscreen.tap(onPhoneBand.x, onPhoneBand.y);
  await expect(phone.locator(".mempool-canvas .mempool-layer--on")).toHaveCount(1);
  // The key names the band picked, beside or under the plot.
  await expect(phone.locator(".mempool-band--on")).toHaveCount(1);
  expect(await plotTop()).toBe(top);
  for (const l of (await plotLayers(phone)).layers) expect(l.fill).not.toBe(during.accent);
  await phone.getByRole("heading", { level: 1 }).tap();
  await expect(phone.locator(".mempool-canvas .mempool-layer--on")).toHaveCount(0);
  await expect(phone.locator(".mempool-band--on")).toHaveCount(0);
  expect(await plotTop()).toBe(top);
  await touch.close();
});

// After Back, Safari brought the period row back scrolled where it was, the chosen one out of sight.
test("the chosen period is in sight on a phone's row, also after going back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const periods = page.getByRole("navigation", { name: "Period" });
  const chosenInView = () =>
    periods.locator("ul").evaluate((ul) => {
      const current = ul.querySelector<HTMLElement>('[aria-current="page"]');
      if (!current) return false;
      const r = current.getBoundingClientRect();
      const box = ul.getBoundingClientRect();
      return r.left >= box.left - 1 && r.right <= box.right + 1;
    });
  await page.goto("/regtest/mempool?interval=4y");
  await expect.poll(chosenInView).toBe(true);
  await periods.getByRole("link", { name: /the last 2 hours/ }).click();
  await expect(page).toHaveURL(/interval=2h$/);
  await expect.poll(chosenInView).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/interval=4y$/);
  await expect.poll(chosenInView).toBe(true);
});
