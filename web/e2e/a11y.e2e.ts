// The accessibility pass (docs/FRONTEND.md "Accessibility"): every page type under axe-core, a
// keyboard walk, reduced motion, and the shell and a dense page at a large text size.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { chain, expect, stubRetargets, test } from "./fixtures";
import { KEPT, LARGE, stubLarge } from "./large-address";
import { ACINQ, mainnet, serve } from "./lightning-answers";

// axe-core is a development dependency only: read from node_modules and run in the page through
// Playwright, never bundled or served.
const REPLACEMENTS = (
  JSON.parse(
    readFileSync(new URL("../../fixtures/api-v1/replacements.json", import.meta.url), "utf8"),
  ) as { all: unknown }
).all;
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** WCAG 2.0 to 2.2, A and AA, and axe's best practices. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const OFF = {
  // A tile's name starts with the title in sight ("Block 110", "Next block"), as WCAG 2.5.3 asks;
  // the rule wants every figure drawn in the tile in its name, in the order drawn.
  "label-content-name-mismatch": { enabled: false },
};

interface Violation {
  id: string;
  nodes: { target: string[]; failureSummary?: string }[];
}

/** axe-core's violations on the page as it is now, one line each. */
async function axe(page: Page, only?: string[]): Promise<string[]> {
  // Fades still under way (they remain under reduced motion) would be measured half done.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await page.evaluate(AXE);
  const found = await page.evaluate(
    async ({ tags, rules, only: ids }) => {
      const run = (window as unknown as { axe: { run: (...a: unknown[]) => Promise<unknown> } }).axe
        .run;
      const r = (await run(document, {
        runOnly: ids ? { type: "rule", values: ids } : { type: "tag", values: tags },
        rules: ids ? {} : rules,
        resultTypes: ["violations"],
      })) as { violations: Violation[] };
      return r.violations;
    },
    { tags: TAGS, rules: OFF, only },
  );
  return found.flatMap((v) =>
    v.nodes.map((n) => `${v.id} at ${n.target.join(" ")}: ${n.failureSummary ?? ""}`),
  );
}

interface Stop {
  name: string;
  ring: boolean;
  covered: boolean;
}

interface Walked {
  /** Where focus was as each key was pressed, so after the key before had moved and scrolled it. */
  seen: (Stop | null)[];
  /** The focused element at each key pressed, every one since the walk began. */
  at: (Element | null)[];
  here: () => Stop | null;
}

/**
 * Notes where focus is at every Tab pressed from now on: its name, whether it shows a focus ring,
 * and whether the header covers it. Noted in the page, so a stop costs no round trip of its own.
 */
const record = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Walked;
    w.seen = [];
    w.at = [];
    w.here = (): Stop | null => {
      const e = document.activeElement;
      if (!(e instanceof HTMLElement) || e === document.body) return null;
      e.dataset["walked"] = "";
      // The ring is the element's own outline, or its field's (the search draws it on its box).
      let ring = false;
      for (const x of [e, e.parentElement]) {
        const s = x && getComputedStyle(x);
        if (s && s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) >= 2) ring = true;
      }
      const header = document.querySelector(".site-header");
      const box = e.getBoundingClientRect();
      const bottom =
        header && getComputedStyle(header).position === "sticky"
          ? header.getBoundingClientRect().bottom
          : 0;
      // Under the header where the header is painted over its top edge (the skip link is above it).
      const top = document.elementFromPoint(box.left + box.width / 2, Math.max(box.top + 1, 0));
      const covered =
        !header?.contains(e) && box.top < bottom - 1 && box.bottom > 0 && !!header?.contains(top);
      const name = (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 40);
      return { name: `${e.tagName.toLowerCase()} "${name}"`, ring, covered };
    };
    // Tab's own keydown only: a press of Shift+Tab or Alt+Tab is two.
    addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Tab") return;
        w.seen.push(w.here());
        w.at.push(document.activeElement);
      },
      { capture: true },
    );
  });

/** The stops noted since the last call, and focus as it is now. */
const noted = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Walked;
    return { seen: w.seen.splice(0), now: w.here() };
  });

/**
 * Presses Tab, or Shift+Tab, `n` times. Chromium is sent every press at once over its protocol,
 * which it handles in order; a round trip per press was most of this file's time in CI.
 */
async function press(page: Page, browserName: string, back: boolean, n: number) {
  if (browserName !== "chromium") {
    // Safari's Tab reaches only form fields unless the reader asks for more; Option-Tab reaches all.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    for (let i = 0; i < n; i++) await page.keyboard.press(back ? `Shift+${tab}` : tab);
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const key = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: back ? 8 : 0 };
  await Promise.all(
    Array.from({ length: n }, () => [
      cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }),
      cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }),
    ]).flat(),
  );
  await cdp.detach();
}

/**
 * Tabs through the whole page from the top, then back up with Shift+Tab: the skip link comes
 * first, every stop shows its focus ring and is never under the sticky header, and every control
 * in sight is reached in the order the page reads, header, main, then footer.
 */
async function walk(page: Page, browserName: string) {
  await record(page);
  const controls = await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
    return document.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [tabindex]",
    ).length;
  });
  // Focus after each press, until it leaves the page or comes back to the first stop. Presses go
  // in batches a little longer than the page's controls, and the walk is cut where it ended.
  const after: (Stop | null)[] = [];
  let end = -1;
  while (end < 0 && after.length < 400) {
    await press(page, browserName, false, controls + 2);
    // The first noted is focus before the batch's first press, which the last batch's end held.
    const { seen } = await noted(page);
    after.push(...(after.length > 0 ? seen : seen.slice(1)));
    end = after.findIndex((s, i) => !s || (i > 0 && s.name === after[0]?.name));
  }
  const stops = after.slice(0, end < 0 ? after.length : end) as Stop[];
  expect.soft(stops[0]?.name, "the first stop").toBe('a "Skip to content"');
  expect
    .soft(
      stops.filter((s) => !s.ring).map((s) => s.name),
      "stops without a focus ring",
    )
    .toEqual([]);
  expect
    .soft(
      stops.filter((s) => s.covered).map((s) => s.name),
      "stops under the header, tabbing down",
    )
    .toEqual([]);
  const order = await page.evaluate(() => {
    const parts = [".site-header", "#main", ".site-footer"];
    const tabbable = [
      ...document.querySelectorAll<HTMLElement>(
        "a[href], button, input, select, textarea, summary, [tabindex]",
      ),
    ].filter(
      (e) =>
        e.tabIndex >= 0 &&
        !(e as HTMLButtonElement).disabled &&
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility !== "hidden" &&
        !e.closest("[inert]"),
    );
    return {
      positive: tabbable.filter((e) => e.tabIndex > 0).length,
      missed: tabbable.filter((e) => !("walked" in e.dataset)).map((e) => e.outerHTML.slice(0, 80)),
      parts: tabbable
        .filter((e) => "walked" in e.dataset)
        .map((e) => parts.findIndex((p) => e.closest(p)))
        .filter((p) => p >= 0),
    };
  });
  expect.soft(order.positive, "a positive tabindex, which reorders the page").toBe(0);
  expect.soft(order.missed, "controls Tab never reached").toEqual([]);
  expect
    .soft(
      order.parts.every((p, i) => p >= (order.parts[i - 1] ?? 0)),
      "header, then main, then footer",
    )
    .toBe(true);
  // Back up the page from the last stop: focus scrolled into view from below must clear the
  // sticky header.
  // at[0] is focus before the first press, so the last stop's element is at[stops.length].
  await page.evaluate(
    (i) => ((window as unknown as Walked).at[i] as HTMLElement | null)?.focus(),
    stops.length,
  );
  await press(page, browserName, true, stops.length - 1);
  // The first noted is the last stop itself, focused from a script rather than by a key.
  const { seen, now } = await noted(page);
  const back = [...seen.slice(1), now].filter((s) => s?.covered).map((s) => s?.name);
  expect.soft(back, "stops under the header, tabbing up").toEqual([]);
}

/** Records every animation that moves something, from the first paint on. */
const watchMotion = (page: Page) =>
  page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { moved: Set<string> }).moved = seen;
    const look = () => {
      for (const a of document.getAnimations()) {
        const effect = a.effect as KeyframeEffect | null;
        const moves = (effect?.getKeyframes() ?? []).some((k) =>
          ["transform", "translate", "scale", "rotate"].some(
            (p) => k[p] !== undefined && k[p] !== "none",
          ),
        );
        const ms = Number(effect?.getComputedTiming().duration ?? 0);
        const name = a instanceof CSSAnimation ? a.animationName : "script";
        if (moves && ms > 0) seen.add(`${name} on ${String(effect?.target?.className)}`);
      }
    };
    setInterval(look, 30);
  });
const moved = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { moved: Set<string> }).moved]);

interface PageType {
  name: string;
  path: string;
  /** What the page shows once it has its data. */
  ready: (page: Page) => ReturnType<Page["getByRole"]>;
  before?: (page: Page) => Promise<void>;
}

const PAGES: PageType[] = [
  {
    name: "home",
    path: "/regtest/",
    ready: (p) => p.getByRole("list", { name: "Mined blocks, newest first" }).getByRole("link"),
  },
  { name: "blocks", path: "/regtest/blocks", ready: (p) => p.getByRole("cell").first() },
  {
    name: "block",
    path: `/regtest/block/${chain.blocks[106]}`,
    ready: (p) => p.getByRole("img", { name: /Map of the block/ }),
  },
  {
    name: "transaction",
    path: `/regtest/tx/${chain.txs.script_types}`,
    ready: (p) => p.getByRole("list", { name: "Outputs" }),
  },
  {
    name: "address",
    path: `/regtest/address/${chain.addresses.p2wpkh}`,
    ready: (p) => p.getByRole("button", { name: /show the exact amount/ }).first(),
  },
  {
    name: "address above the node's cap",
    path: `/regtest/address/${LARGE}`,
    ready: (p) => p.getByRole("table", { name: /^Unconfirmed transactions/ }).getByRole("link"),
    before: (p) => stubLarge(p),
  },
  {
    name: "projected block",
    path: "/regtest/block/next",
    ready: (p) => p.getByRole("heading", { level: 1, name: "Next block" }),
  },
  { name: "mempool", path: "/regtest/mempool", ready: (p) => p.getByRole("slider").first() },
  {
    name: "mining",
    path: "/regtest/mining",
    ready: (p) => p.getByRole("table").first(),
    before: stubRetargets,
  },
  {
    name: "pool",
    path: "/regtest/mining/pool/unknown",
    ready: (p) => p.getByRole("table").first(),
  },
  {
    name: "replacements",
    path: "/regtest/rbf",
    ready: (p) => p.getByRole("table").first(),
    // Mainnet's stories (as rbf.e2e.ts draws them): regtest has none this long.
    before: async (p) => {
      await p.route(/\/regtest\/api\/v1\/replacements$/, (r) => r.fulfill({ json: REPLACEMENTS }));
    },
  },
  {
    name: "not found",
    path: "/regtest/no/such/page",
    ready: (p) => p.getByRole("heading", { level: 1, name: "Page not found" }),
  },
  {
    name: "Lightning",
    path: "/regtest/lightning?interval=1w",
    ready: (p) => p.getByRole("slider").first(),
    before: (p) => serve(p, mainnet()),
  },
  {
    name: "Lightning node",
    path: `/regtest/lightning/node/${ACINQ}`,
    ready: (p) => p.getByRole("slider").first(),
    before: (p) => serve(p, mainnet()),
  },
  {
    name: "Lightning channel",
    path: "/regtest/lightning/channel/811984x2037x0",
    ready: (p) => p.getByRole("table").first(),
    before: (p) => serve(p, mainnet()),
  },
  {
    name: "Lightning rankings",
    path: "/regtest/lightning/rankings",
    ready: (p) => p.getByRole("table").first(),
    before: (p) => serve(p, mainnet()),
  },
  {
    name: "Lightning search",
    path: "/regtest/lightning/search?q=acinq",
    ready: (p) => p.getByRole("link", { name: "ACINQ" }).first(),
    before: (p) => serve(p, mainnet()),
  },
  {
    name: "address kept by the server's ledger",
    path: `/regtest/address/${LARGE}?ledger=kept`,
    ready: (p) =>
      p.getByRole("table", { name: /^Newest confirmed transactions/ }).getByRole("link"),
    before: (p) => stubLarge(p, { ledger: () => KEPT }),
  },
  {
    name: "address being added up",
    path: `/regtest/address/${LARGE}?ledger=adding`,
    ready: (p) => p.getByRole("region", { name: "Adding up this address for the first time" }),
    before: (p) => stubLarge(p, { ledger: () => ({ state: "seeding", seconds: 95 }) }),
  },
];

/** Opens a page type and waits until its data is drawn and nothing is still loading. */
async function open(page: Page, t: PageType) {
  await t.before?.(page);
  await page.goto(t.path);
  await expect(t.ready(page).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.state--loading, [aria-busy="true"]')).toHaveCount(0);
}

test.describe("every page type", () => {
  // The address above the cap is refused its totals (a stand-in 503), as the node does.
  test.use({ reducedMotion: "reduce", consoleErrorsAllowed: [/status of 503/] });
  for (const t of PAGES) {
    test(`${t.name}: no checker finding in either theme, a keyboard walk, and no movement under reduced motion`, async ({
      page,
      browserName,
    }) => {
      await watchMotion(page);
      await open(page, t);
      expect.soft(await axe(page), "axe-core, light").toEqual([]);
      await page.emulateMedia({ colorScheme: "dark" });
      expect.soft(await axe(page, ["color-contrast"]), "contrast, dark").toEqual([]);
      await page.emulateMedia({ colorScheme: "light" });
      // A keyboard is a desktop's; a phone's run checks the rest.
      if ((page.viewportSize()?.width ?? 0) > 640) await walk(page, browserName);
      expect.soft(await moved(page), "movement under reduced motion").toEqual([]);
    });
  }
});

// Escape closes what opened and gives focus back to what opened it.
test("Escape closes the network menu, an exact amount and the search's answer", async ({
  page,
  browserName,
}) => {
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  // A second network, so the switch is a menu rather than a label.
  await page.route("**/app/config", (r) =>
    r.fulfill({ json: { networks: ["regtest", "signet"], version: "test" } }),
  );
  await open(page, PAGES[4] as PageType);

  const network = page.getByRole("button", { name: /^Network: Regtest/ });
  await network.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator("#network-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(network).toBeFocused();

  const exact = page.getByRole("button", { name: /show the exact amount/ }).first();
  await exact.focus();
  await page.keyboard.press("Enter");
  const copy = page.getByRole("button", { name: /^Copy the exact/ });
  await expect(copy).toBeVisible();
  await page.keyboard.press(tab);
  await expect(copy).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(copy).toBeHidden();
  await expect(exact).toBeFocused();

  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill("nothing like an id");
  await search.press("Enter");
  // The answer is said, and Tab reaches its links.
  await expect(page.getByRole("status").filter({ hasText: "Nothing matches" })).toHaveCount(1);
  await expect(page.getByText("Nothing matches", { exact: true })).toBeVisible();
  expect(await axe(page), "axe-core, the search's answer open").toEqual([]);
  await page.keyboard.press(tab);
  await expect(page.locator(".search__panel a").first()).toBeFocused();
  await search.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Nothing matches", { exact: true })).toBeHidden();
  await expect(search).toBeFocused();
});

/** Content wider than the screen outside anything that scrolls, with every disclosure open. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) d.open = true;
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const e of document.querySelectorAll("body *")) {
      const box = e.getBoundingClientRect();
      if (box.width === 0 || (box.right <= width + 1 && box.left >= -1)) continue;
      let clipped = false;
      for (let p = e.parentElement; p && !clipped; p = p.parentElement) {
        clipped = getComputedStyle(p).overflowX !== "visible";
      }
      if (!clipped) out.push(`${e.tagName.toLowerCase()}.${e.getAttribute("class") ?? ""}`);
    }
    return { scroll: document.documentElement.scrollWidth - width, out: out.slice(0, 5) };
  });

/**
 * WCAG's reflow at 320 px, and a large text size: a phone's at 320 px and 200% on a desktop. A
 * browser's text size is its default font size, which Chromium alone lets a test set.
 */
// The blocks list and the transaction page, as the page types above wait for them.
for (const [name, type] of [
  ["the shell", PAGES[1]],
  ["a dense page", PAGES[3]],
] as const) {
  test(`${name} reflows at 320 px and at a large text size, nothing cut or overlapping`, async ({
    page,
    browserName,
  }) => {
    const sizes = [
      { width: 320, height: 640, text: 16 },
      ...(browserName === "chromium"
        ? [
            { width: 320, height: 640, text: 24 },
            { width: 1280, height: 800, text: 32 },
          ]
        : []),
    ];
    for (const size of sizes) {
      const label = `${size.width} px at ${size.text} px text`;
      await page.setViewportSize(size);
      if (browserName === "chromium") {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Page.setFontSizes", {
          fontSizes: { standard: size.text, fixed: Math.round((size.text * 13) / 16) },
        });
      }
      await open(page, type as PageType);
      expect(await overflow(page), label).toEqual({ scroll: 0, out: [] });
      const links = await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link")
        .evaluateAll((all) => all.map((a) => a.getBoundingClientRect()));
      const apart = links.every((a, i) =>
        links.slice(i + 1).every((b) => a.right <= b.left + 1 || a.bottom <= b.top + 1),
      );
      expect(apart, `${label}: the sections apart`).toBe(true);
      // A short screen keeps the whole of it for the page: the header scrolls away.
      const sticky = await page
        .getByRole("banner")
        .evaluate((h) => getComputedStyle(h).position === "sticky");
      expect(sticky, `${label}: the header sticks only on a screen tall enough`).toBe(
        size.height / size.text >= 30,
      );
    }
  });
}
