// Every page type in a stand-in for a wider system font than a Mac's, across widths and in both
// schemes: nothing runs into anything, nothing is cut, amounts stay whole, tables fit their panels.
import { stripVTControlCharacters } from "node:util";
import { chain, expect, test } from "./fixtures";
import { frames, layoutFaults } from "./layout";
import { expectFaults, open, PAGES } from "./pages";
import { amountsIntact, tablesFit } from "./rows";

// Each width is a resize of one loaded page: WebKit calls a fetch the next page's load cancels an
// "access control" failure, though the app is same-origin and catches it.
test.use({ consoleErrorsAllowed: [/status of (429|503)|due to access control checks/] });

/** What a failed check says, on one line: its label and what it found. */
const said = (error: unknown) =>
  stripVTControlCharacters(String(error))
    .split("\n")
    .filter((l) => /^(Error|\+ {3}|Received)/.test(l.trim()) && !l.includes("Error: expect"))
    .map((l) => l.trim())
    .join(" ");

// `E2E_SWEEP=1`: the design's widths, the breakpoints (640, 1040) either side and every 40 px
// between, each in both schemes. Otherwise (pull requests) the widths where the sweep found
// faults, each in one scheme: the layout is the same in both.
const SWEEP = process.env["E2E_SWEEP"] === "1";
const NAMED = new Set([390, 639, 641, 1039, 1041, 1100]);
const WIDTHS = SWEEP
  ? Array.from({ length: 1441 - 320 }, (_, i) => 320 + i).filter(
      (w) => w % 40 === 0 || NAMED.has(w),
    )
  : [320, 400, 641, 1100];

for (const swept of PAGES) {
  test(`${swept.path} holds in a stand-in font at every width`, async ({ page }) => {
    test.setTimeout(SWEEP ? 240_000 : 30_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, swept);
    // Every fault at every width, so one run lists them all.
    const faults: string[] = [];
    for (const [i, width] of WIDTHS.entries()) {
      await page.setViewportSize({ width, height: 900 });
      const schemes: ("light" | "dark")[] = SWEEP
        ? ["light", "dark"]
        : [i % 2 === 0 ? "light" : "dark"];
      for (const colorScheme of schemes) {
        await page.emulateMedia({ colorScheme });
        await frames(page);
        const at = `${width} px, ${colorScheme}`;
        for (const f of await layoutFaults(page)) faults.push(`${at}: ${f}`);
        for (const check of [amountsIntact, tablesFit]) {
          try {
            await check(page, at);
          } catch (error) {
            faults.push(said(error));
          }
        }
      }
    }
    expectFaults(faults, swept, "fonts");
  });
}

// Every phone width a card's exact amount is near its edge, not one: Chromium on Linux draws this
// font's digits a whole pixel wide each, so at 320 px alone it never met the widths that
// WebKit's and Firefox's fractional digits ran past their card at (SB19).
test("a flow card's amount stays inside its card at every width from 320 to 340 px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/regtest/tx/${chain.txs.script_types}`);
  await expect(page.locator(".tx-flow__item .amount").first()).toBeVisible();
  const faults: string[] = [];
  for (let width = 320; width <= 340; width++) {
    await page.setViewportSize({ width, height: 900 });
    await frames(page);
    try {
      await amountsIntact(page, `${width} px`);
    } catch (error) {
      faults.push(said(error));
    }
  }
  expect(faults).toStrictEqual([]);
});

// The check itself: each kind of fault it exists for, built on a page, is found; the same text
// in a box that scrolls on that axis is not.
test("the layout check finds text over text, text cut on any edge, a short form's or a fitted ID's lost end, and a wrapped label", async ({
  page,
}) => {
  await page.goto("/regtest/no/such/page");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.evaluate(() => {
    const main = document.querySelector("main");
    const add = (parent: Element, css: Record<string, string>, text = "") => {
      const el = document.createElement("div");
      Object.assign(el.style, css);
      el.textContent = text;
      parent.append(el);
      return el;
    };
    const host = add(main ?? document.body, { position: "relative", height: "440px" });
    const at = (top: number): Record<string, string> => ({
      position: "absolute",
      top: `${top}px`,
      left: "0",
      font: "20px/24px sans-serif",
      whiteSpace: "nowrap",
    });
    add(host, at(0), "Overlap one");
    add(host, { ...at(0), left: "40px" }, "Overlap two");
    add(host, { ...at(40), height: "10px", overflow: "hidden" }, "Cut below");
    // Cut sideways by a hidden box inside a scrolling one: scrolling cannot show it.
    const scroller = add(host, { ...at(80), width: "200px", overflowX: "auto" });
    add(scroller, { width: "30px", overflow: "hidden" }, "Cut inside a scroller");
    // A hidden box wider than its scroller: scrolling shows the box's width, not the text past it.
    const narrow = add(host, { ...at(110), width: "100px", overflowX: "auto" });
    add(narrow, { width: "150px", overflow: "hidden" }, "Cut past a wider hidden box, too");
    // A scroller wider than the hidden box around it: its last 100 px never come into sight.
    const narrowWindow = add(host, { ...at(250), width: "100px", overflow: "hidden" });
    const wide = add(narrowWindow, { width: "200px", overflowX: "auto" });
    add(wide, { whiteSpace: "nowrap" }, "Past a narrower window, its far end");
    // Clipped below only: `overflow-y: clip` beside a visible x.
    add(host, { ...at(290), height: "10px", overflowY: "clip" }, "Clipped on one axis");
    // A short form with its whole in a title: cut after its "…" it lost its end; cut before it, it
    // gave way at its head, as a cut ID does.
    const whole = "mwLW3XDqcAYmYKp8VDEYXweSBJ5mTUAuat";
    add(host, { ...at(320), width: "100px", overflow: "hidden" }, "mwLW3XD…UAuat").title = whole;
    add(host, { ...at(350), width: "40px", overflow: "hidden" }, "mwLW3XD…").title = whole;
    // The same in Hash's markup, a head and a tail: the tail cut wholly out of sight.
    const split = add(host, { ...at(380), width: "40px", overflow: "hidden" });
    split.title = whole;
    split.className = "hash--ends";
    add(split, { display: "inline" }, "nB3eG7k…").className = "hash__head";
    add(split, { display: "inline" }, "Zq9Xw").className = "hash__tail";
    // A table's fitted ID: the whole value in two halves, its tail cut wholly out of sight.
    const fitted = add(host, { ...at(410), width: "40px", overflow: "hidden" });
    fitted.title = whole;
    fitted.className = "hash--fit";
    add(fitted, { display: "inline" }, whole.slice(0, -8)).className = "hash__head";
    add(fitted, { display: "inline" }, whole.slice(-8)).className = "hash__tail";
    // Only scrolled out of sight: scrolling shows it.
    add(host, { ...at(140), width: "60px", overflowX: "auto" }, "Scrolls along");
    const row = add(host, { ...at(200), width: "300px", whiteSpace: "normal" });
    const button = document.createElement("button");
    button.style.width = "60px";
    button.textContent = "Two words";
    row.append(button);
  });
  const faults = await layoutFaults(page);
  expect(faults.join("\n")).toMatch(
    /"Overlap one".*runs into "Overlap two"|"Overlap two".*runs into "Overlap one"/,
  );
  expect(faults.join("\n")).toContain('"Cut below" is cut');
  expect(faults.join("\n")).toContain('"Cut inside a scroller" is cut');
  expect(faults.join("\n")).toContain('"Cut past a wider hidden box, too" is cut');
  expect(faults.join("\n")).toContain('"Past a narrower window, its far end" is cut');
  expect(faults.join("\n")).toContain('"Clipped on one axis" is cut');
  expect(faults.join("\n")).not.toContain("Scrolls along");
  expect(faults.join("\n")).toContain('"mwLW3XD…UAuat" loses its end');
  expect(faults.join("\n")).not.toMatch(/"mwLW3XD…" /);
  expect(faults.join("\n")).toContain('"nB3eG7k…Zq9Xw" loses its end');
  expect(faults.join("\n")).toContain('"mwLW3XDqcAYmYKp8VDEYXweSBJ5mTUAuat" loses its end');
  expect(faults.join("\n")).toContain('the label "Two words" wraps');
});
