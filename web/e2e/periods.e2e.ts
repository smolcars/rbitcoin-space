// Every chart with period choices, on a phone: the choices one row with the chosen one in sight,
// the coverage note two lines at most, and the plot and its time axis on the first screen of its
// panel (docs/DESIGN.md "The intervals are one row"), and every label on the plot whole inside it.
// The Lightning overview's once wrapped "All" onto a second row and took four lines to say its
// coverage, putting its time axis below the first screen at 320 px; the mining page's fee axis once
// ran its regtest labels ("0.0000002 BTC") off the plot's left edge and the screen's.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mainnet, recorded, serve } from "./lightning-answers";

/** A day of the network's ten-minute samples with three missing: the overview's longest note. */
function gappyDay() {
  const week = recorded("statistics-1w") as { points: Record<string, number>[]; to: number };
  const one = week.points[0] ?? {};
  const to = week.to;
  return {
    ...week,
    interval: "24h",
    from: to - 86_400,
    first: to - 30 * 86_400,
    complete: false,
    sampled: 140,
    slots: 143,
    points: Array.from({ length: 140 }, (_, i) => ({
      ...one,
      time: to - 86_400 + (i + 3) * 600,
      channels: (one["channels"] ?? 0) + Math.round(i / 10),
    })),
  };
}

/**
 * Each page with period choices, opened where its chosen period is far along the row, and the
 * charts it draws there. A chart's panel is its section; the mempool's coverage note heads the
 * page, above it (its first screen from the page's top is checked in mempool.e2e.ts).
 */
const PAGES = [
  { path: "/regtest/mempool?interval=all", charts: [/The mempool's size/] },
  { path: "/regtest/lightning?interval=24h", charts: [/Lightning channels/] },
  { path: "/regtest/lightning?interval=1m", charts: [/Lightning channels/] },
  // Regtest has no pools, hashrate or audits: of the mining charts, it draws the blocks'.
  { path: "/regtest/mining?period=all", charts: [/Average fees per block/] },
];

const SIZES = [
  { width: 390, height: 844 },
  { width: 320, height: 700 },
];

/** What breaks the rule on the page as drawn now, in words. */
async function faults(page: Page, chart: RegExp): Promise<string[]> {
  const plot = page.getByRole("slider", { name: chart });
  await plot.scrollIntoViewIfNeeded();
  await expect(plot.locator("svg text").first()).toBeAttached();
  return plot.evaluate((el) => {
    const out: string[] = [];
    const ul = document.querySelector("nav[aria-label='Period'] ul");
    if (!ul) return ["no period choices"];
    const rows = new Set([...ul.children].map((li) => Math.round(li.getBoundingClientRect().top)));
    if (rows.size !== 1) out.push(`the periods take ${rows.size} rows`);
    const box = ul.getBoundingClientRect();
    const current = ul.querySelector("[aria-current='page']")?.getBoundingClientRect();
    if (!current || current.left < box.left - 1 || current.right > box.right + 1) {
      out.push("the chosen period is out of sight");
    }
    const panel = el.closest("section");
    const note =
      panel?.querySelector(".ln-coverage, .mining-coverage") ??
      document.querySelector(".mempool-coverage");
    if (note) {
      const range = document.createRange();
      range.selectNodeContents(note);
      // Tops more than half a line apart: the hatch swatch beside the words sits a pixel off.
      const tops = [...range.getClientRects()].map((r) => r.top);
      tops.sort((x, y) => x - y);
      const lines = tops.filter((t, i) => i === 0 || t - (tops[i - 1] ?? t) > 8).length;
      if (lines > 2) out.push(`the coverage takes ${lines} lines`);
    }
    // The plot and every label on it, the dates under it included, under the sticky header.
    const header = document.querySelector(".site-header")?.getBoundingClientRect().height ?? 0;
    const bottom = Math.max(
      ...[...el.querySelectorAll("svg, svg text")].map((e) => e.getBoundingClientRect().bottom),
    );
    const fold = bottom - (panel?.getBoundingClientRect().top ?? 0);
    const screen = window.innerHeight - header;
    if (fold > screen) {
      out.push(`the time axis ends ${Math.round(fold)} px into a ${screen} px screen`);
    }
    // Where each label's text runs, from its own position and length: Firefox's boxes for SVG text
    // reach 3 px past the glyphs on each side.
    const width = el.querySelector("svg")?.getBoundingClientRect().width ?? 0;
    for (const label of el.querySelectorAll<SVGTextElement>("svg text")) {
      const length = label.getComputedTextLength();
      const anchor = label.getAttribute("text-anchor");
      const x = Number(label.getAttribute("x"));
      const start = anchor === "end" ? x - length : anchor === "middle" ? x - length / 2 : x;
      if (start < -0.5 || start + length > width + 0.5) {
        out.push(`"${label.textContent ?? ""}" runs off the plot`);
      }
    }
    return out;
  });
}

// A test a page: all four in one outran its time in WebKit at a phone's pixel density on a slow
// runner.
for (const { path, charts } of PAGES) {
  test(`every chart's periods are one row, its time axis on the first screen of its panel: ${path}`, async ({
    page,
  }) => {
    await serve(page, {
      ...mainnet(),
      "statistics/24h": gappyDay(),
      "statistics/1m": { ...(recorded("statistics-1w") as object), interval: "1m" },
      "movers?period=24h": { ...(recorded("movers-1w") as object), period: "24h" },
      "movers?period=1m": { ...(recorded("movers-1w") as object), period: "1m" },
    });
    const found: string[] = [];
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.goto(path);
      for (const chart of charts)
        found.push(...(await faults(page, chart)).map((f) => `${path} at ${size.width} px: ${f}`));
    }
    expect(found).toStrictEqual([]);
  });
}
