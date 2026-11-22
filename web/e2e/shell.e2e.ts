import type { Page } from "@playwright/test";
import { groupDigits } from "../src/lib/format";
import { chain, expect, setProse, test } from "./fixtures";
import { layoutFaults } from "./layout";
import { lightningOn } from "./lightning-answers";

test("the app shell loads on /regtest/ with the regtest network shown", async ({ page }) => {
  await page.goto("/regtest/");
  await expect(page.locator("html")).toHaveAttribute("data-network", "regtest");
  await expect(page.getByRole("banner")).toContainText("Regtest");
  await expect(page).toHaveTitle(/^Regtest: .* \| rbitcoin\.space$/);
});

test("a deep link survives a reload", async ({ page }) => {
  const hash = chain.blocks[106];
  await page.goto(`/regtest/block/${hash}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Block 106");
  await expect(page.getByText(hash)).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(`/regtest/block/${hash}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Block 106");
  await expect(page.getByText(hash)).toBeVisible();
});

test("an unknown page shows the not-found page inside the shell", async ({ page }) => {
  const res = await page.goto("/regtest/no/such/page");
  // The server sends the app shell for any page path; the app decides what is there.
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  await expect(page.getByRole("banner")).toContainText("Regtest");
});

/**
 * How the page's two stacks set the site's own digit grouping, in em, measured at 100 px as Chromium
 * on Linux rounds each advance to a whole pixel: the gap a group adds, a word space beside it for
 * scale, and how far two figures of the same length differ in width (0 when they line up).
 * `tokens` measures the stylesheet's stacks, which a page whose font came late leaves out for that
 * load; otherwise the stacks this page is using.
 */
async function digitGroups(page: Page, tokens: boolean) {
  const text = {
    plain: "1293",
    grouped: groupDigits(1293),
    ones: groupDigits(111_111),
    eights: groupDigits(888_888),
  };
  return page.evaluate(
    async ({ fromTokens, t }) => {
      if (fromTokens) {
        for (const name of ["--font-sans", "--font-mono"]) {
          document.documentElement.style.removeProperty(name);
        }
        await document.fonts.load('100px "Recursive Gap"', t.grouped);
        await document.fonts.load('100px "Recursive Mono"', t.grouped);
      }
      const width = (family: string, content: string) => {
        const span = document.createElement("span");
        span.className = "num";
        span.style.fontSize = "100px";
        span.style.fontFamily = family;
        span.textContent = content;
        document.querySelector("main")?.append(span);
        const w = span.getBoundingClientRect().width;
        span.remove();
        return w / 100;
      };
      const stack = (family: string) => ({
        gap: width(family, t.grouped) - width(family, t.plain),
        space: width(family, "1 293") - width(family, t.plain),
        misalign: Math.abs(width(family, t.ones) - width(family, t.eights)),
      });
      return { sans: stack("var(--font-sans)"), mono: stack("var(--font-mono)") };
    },
    { fromTokens: tokens, t: text },
  );
}

test("digit groups show a visible narrow gap in every engine", async ({ page, browserName }) => {
  await page.goto("/regtest/no/such/page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  const { sans, mono } = await digitGroups(page, true);
  // The monospace's gap is our font's narrow space, 0.15 em, in every engine.
  expect(mono.gap).toBeCloseTo(0.15, 2);
  if (browserName === "firefox") {
    // Firefox takes the space from the font of the digits beside it, the system font's own narrow
    // space: 0.10 em in a Mac's, 0.20 in DejaVu Sans on Linux. Visible, and narrower than a word
    // space, so a figure never reads as two.
    expect(sans.gap).toBeGreaterThanOrEqual(0.095);
    expect(sans.gap).toBeLessThan(sans.space * 0.8);
  } else {
    // Chromium and WebKit take ours from "Recursive Gap", whatever the system font's is.
    expect(sans.gap).toBeCloseTo(0.15, 2);
  }
  for (const s of [sans, mono]) expect(s.misalign).toBeLessThan(0.005);
});

test.describe("when the web font fails", () => {
  // Each engine reports the refused font in its own words. The system's own prose font: it is
  // what draws a reader's digit groups when ours fails, and a stand-in would take its place.
  test.use({ consoleErrorsAllowed: [/font|Failed to load resource|ERR_FAILED/i], prose: "system" });
  test("digit groups keep a visible gap and figures line up", async ({ page }) => {
    await page.route(/\.woff2$/, (route) => route.abort());
    await page.goto("/regtest/no/such/page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    // The page took our faces out of its stacks: the system's fonts draw everything.
    const stacks = await page.evaluate(() => {
      const tokens = getComputedStyle(document.documentElement);
      return `${tokens.getPropertyValue("--font-sans")} ${tokens.getPropertyValue("--font-mono")}`;
    });
    expect(stacks).not.toContain("Recursive");
    const { sans, mono } = await digitGroups(page, false);
    // A system monospace's narrow space can be a whole cell (DejaVu Sans Mono's is), so a gap
    // there is at most a word space; columns of figures still line up digit for digit.
    expect(sans.gap).toBeGreaterThanOrEqual(0.095);
    expect(sans.gap).toBeLessThan(sans.space * 0.8);
    expect(mono.gap).toBeGreaterThanOrEqual(0.095);
    expect(mono.gap).toBeLessThanOrEqual(mono.space + 0.005);
    for (const s of [sans, mono]) expect(s.misalign).toBeLessThan(0.005);
  });
});

test("the not-found page offers the search and ways on", async ({ page }) => {
  await page.goto("/regtest/no/such/page");
  const main = page.getByRole("main");
  await expect(main.getByRole("combobox", { name: "Search" })).toBeVisible();
  await expect(main.getByRole("navigation", { name: "Where to go" }).getByRole("link")).toHaveCount(
    5,
  );
});

/** Whether two boxes overlap by more than a hairline. */
const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x + 1 < b.x + b.width &&
  b.x + 1 < a.x + a.width &&
  a.y + 1 < b.y + b.height &&
  b.y + 1 < a.y + a.height;

// A desktop at 200% zoom lays the page out at half its width in CSS pixels: the header must
// switch to its two-row form before the search and the sections collide.
for (const [name, viewport] of [
  ["a desktop at 200% zoom", { width: 720, height: 450 }],
  ["a phone", { width: 390, height: 844 }],
  ["a small phone", { width: 320, height: 640 }],
] as const) {
  test(`the header keeps search, network and sections apart on ${name}`, async ({ page }) => {
    // All four sections, as on a network with Lightning on.
    await lightningOn(page);
    await page.setViewportSize(viewport);
    await page.goto("/regtest/blocks");
    const header = page.getByRole("banner");
    // The search's box, which holds the field and its hints; the network switch is a plain label
    // when the server serves one network, as here.
    const search = await header.locator(".search__field").boundingBox();
    const network = await header.locator(".network__button").boundingBox();
    const theme = await header
      .getByRole("button", { name: /Switch to (light|dark) theme/ })
      .boundingBox();
    const links = await header.getByRole("navigation", { name: "Main" }).getByRole("link").all();
    expect(links).toHaveLength(4);
    expect(search && search.width).toBeGreaterThan(90);
    // The network and theme are a thumb's target too, however small they are drawn.
    expect(network && network.height).toBeGreaterThanOrEqual(43.5);
    expect(theme && Math.min(theme.width, theme.height)).toBeGreaterThanOrEqual(43.5);
    for (const link of links) {
      const box = await link.boundingBox();
      if (!box || !search || !network) throw new Error("missing header part");
      expect(overlaps(box, search), "a section over the search").toBe(false);
      expect(overlaps(box, network), "a section over the network").toBe(false);
      // In sight without scrolling the row sideways, and a thumb's target.
      expect(box.x + box.width, "a section past the edge").toBeLessThanOrEqual(viewport.width);
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
    // About 100 px at most on a phone, so the page starts in the first screen.
    const height = (await header.boundingBox())?.height ?? 0;
    expect(height).toBeLessThanOrEqual(viewport.width < 700 ? 101 : 110);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    // On a phone, searching takes the row: the field and its answer are nearly the page's width.
    if (viewport.width < 700) {
      // Too short for a node name, so Lightning, on here, does not take it.
      await header.getByRole("combobox", { name: "Search" }).fill("zz");
      await header.getByRole("combobox", { name: "Search" }).press("Enter");
      const panel = page.getByText("Nothing matches", { exact: true });
      await expect(panel).toBeVisible();
      const field = await header.locator(".search__field").boundingBox();
      expect(field && field.width).toBeGreaterThan(viewport.width * 0.85);
    }
  });
}

// The current section was once unmarked once a period was chosen or a child page opened.
test.describe("the main nav", () => {
  // It moves on as soon as the mark shows: WebKit calls a summary fetch the next page's load
  // cancels an "access control" failure, though the app is same-origin and the page catches it.
  test.use({ consoleErrorsAllowed: [/due to access control checks/] });
  test("marks the current section on every page under it, whatever the query", async ({ page }) => {
    await lightningOn(page);
    // Lightning is listed but off on this server: the block page's panel gets a block with none.
    await page.route(/\/regtest\/app\/lightning\/block\//, (route) =>
      route.fulfill({
        json: {
          opened: { count: 0, capacity: 0, channels: [] },
          closed: { count: 0, forced: 0, channels: [] },
        },
      }),
    );
    const routes: [string, string][] = [
      ["/regtest/blocks", "Blocks"],
      [`/regtest/block/${chain.blocks[106]}`, "Blocks"],
      ["/regtest/block/next", "Blocks"],
      ["/regtest/mempool", "Mempool"],
      ["/regtest/mempool?interval=2h", "Mempool"],
      ["/regtest/mempool?interval=all", "Mempool"],
      ["/regtest/rbf", "Mempool"],
      ["/regtest/mining", "Mining"],
      ["/regtest/mining?period=24h", "Mining"],
      ["/regtest/mining?period=all", "Mining"],
      ["/regtest/mining/pool/unknown", "Mining"],
      ["/regtest/lightning", "Lightning"],
      ["/regtest/lightning/rankings", "Lightning"],
    ];
    const nav = page.getByRole("navigation", { name: "Main" });
    const marked = async () =>
      nav
        .locator("a")
        .evaluateAll((all) =>
          all
            .filter(
              (a) =>
                a.getAttribute("aria-current") === "true" &&
                getComputedStyle(a, "::after").backgroundColor !== "rgba(0, 0, 0, 0)",
            )
            .map((a) => a.textContent),
        );
    for (const [path, section] of routes) {
      await page.goto(path);
      await expect.poll(marked, { message: path }).toStrictEqual([section]);
    }
    // In-page: a period chosen keeps the section marked.
    await page.goto("/regtest/mining");
    await page
      .getByRole("navigation", { name: "Period" })
      .getByRole("link", { name: /all time/ })
      .click();
    await expect(page).toHaveURL(/period=all$/);
    await expect.poll(marked).toStrictEqual(["Mining"]);
  });
});

// Safari zoomed the page into the Lightning search (its text under 16 px) and stayed zoomed; and a
// tapped control kept its hover look until something else was tapped.
test("on a touch screen no field is small enough to zoom into, and a tap leaves no hover behind", async ({
  browser,
  baseURL,
}) => {
  const touch = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  await setProse(touch);
  const page = await touch.newPage();
  for (const path of ["/regtest/", "/regtest/lightning", "/regtest/no/such/page"]) {
    await page.goto(`${baseURL ?? ""}${path}`);
    await expect(page.locator("input").first()).toBeAttached();
    const sizes = await page
      .locator("input")
      .evaluateAll((all) => all.map((i) => Number.parseFloat(getComputedStyle(i).fontSize)));
    for (const size of sizes) expect(size, path).toBeGreaterThanOrEqual(16);
  }
  // Hover styles are for pointers that hover: a button tapped keeps its resting look.
  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
  await page.goto(`${baseURL ?? ""}/regtest/mining`);
  // The chart switch already pressed, so the tap changes nothing but what a hover would.
  const button = page.locator('main .mining-tab[aria-pressed="true"]');
  await expect(button).toBeVisible();
  const rest = await button.evaluate((b) => getComputedStyle(b).backgroundColor);
  await button.tap();
  expect(await button.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe(rest);
  await touch.close();
});

/** The theme colours and colour scheme the page gives the browser's own chrome. */
const chrome = (page: Page) =>
  page.evaluate(() => ({
    theme: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) =>
      m.getAttribute("content"),
    ),
    scheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
  }));

// Safari kept its toolbar in the system's colour over a page toggled the other way.
test("the browser's chrome takes the colour of the scheme on screen, not only the system's", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/regtest/");
  await expect.poll(() => chrome(page)).toStrictEqual({ theme: ["#121518"], scheme: "dark" });
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect.poll(() => chrome(page)).toStrictEqual({ theme: ["#f4f6f7"], scheme: "light" });
});

// WebKit runs the app's script before a stylesheet linked after it has loaded: the chrome took
// the light colour over a dark page whenever the stylesheet came later than the script.
test("the browser's chrome is right when the stylesheet comes after the script", async ({
  page,
  browserName,
}) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/assets\/[^/]+\.css$/, async (route) => {
    await held;
    await route.continue();
  });
  // Whether the app's module has run: its script's load event, before any of the page's code.
  await page.addInitScript(() => {
    document.addEventListener(
      "load",
      (e) => {
        if (e.target instanceof HTMLScriptElement && e.target.type === "module") {
          Object.assign(window, { moduleRan: true });
        }
      },
      true,
    );
  });
  await page.emulateMedia({ colorScheme: "dark" });
  // Chromium and Firefox run the module only once the stylesheet is in. WebKit runs it first: the
  // stylesheet is held until it has, and until the page's one-second wait for its font has run out
  // on the page's own clock, after which the page draws whatever it has.
  const webkit = browserName === "webkit";
  if (webkit) await page.clock.install();
  const loaded = page.goto("/regtest/");
  if (webkit) {
    await expect.poll(() => page.evaluate(() => "moduleRan" in window)).toBe(true);
    await page.clock.runFor(1500);
  }
  release?.();
  if (webkit) await page.clock.resume();
  await loaded;
  await expect.poll(() => chrome(page)).toStrictEqual({ theme: ["#121518"], scheme: "dark" });
});

// At 150% page zoom a phone is about 268 px wide: the search shrank to "Se" and the sections touched.
test("the header keeps a usable search and apart sections down to a zoomed phone's width", async ({
  page,
}) => {
  for (const width of [320, 268]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/regtest/");
    const search = page.getByRole("combobox", { name: "Search" });
    const box = await search.boundingBox();
    expect(box?.width ?? 0, `search at ${width} px`).toBeGreaterThanOrEqual(
      width >= 300 ? 90 : 200,
    );
    // The placeholder whole: its text fits the field.
    const fits = await search.evaluate((input: HTMLInputElement) => {
      const probe = document.createElement("span");
      const style = getComputedStyle(input);
      probe.style.font = style.font;
      probe.textContent = input.placeholder;
      document.body.append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      // From the box: Firefox gives an input's clientWidth without its padding, Chromium with.
      const edges = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] as const;
      const room = edges.reduce(
        (r, e) => r - Number.parseFloat(style[e]),
        input.getBoundingClientRect().width,
      );
      return w <= room + 1;
    });
    expect(fits, `placeholder at ${width} px`).toBe(true);
    const links = await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link")
      .evaluateAll((all) => all.map((a) => a.getBoundingClientRect()));
    for (let i = 1; i < links.length; i++) {
      expect((links[i]?.left ?? 0) >= (links[i - 1]?.right ?? 0), `sections at ${width} px`).toBe(
        true,
      );
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

// At 320 px and 32 px text the four sections ran into each other: "BlocksMempoolMiningLightning".
test.describe("on a phone at a large text size", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 800 } });
  test("the header's sections stay whole and apart, and the header fits", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "only Chromium lets a test set the browser's text size");
    await lightningOn(page);
    const cdp = await page.context().newCDPSession(page);
    for (const text of [16, 20, 24, 32]) {
      await cdp.send("Page.setFontSizes", {
        fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
      });
      await page.goto("/regtest/blocks");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // The header alone: what the page under it does at this size is its own test's.
      await page.locator("main, footer").evaluateAll((all) => {
        for (const el of all) (el as HTMLElement).style.display = "none";
      });
      const label = `${text} px text`;
      const parts = await page.getByRole("banner").evaluate((header) => {
        const box = (el: Element | null) => el?.getBoundingClientRect() ?? new DOMRect();
        return {
          root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          search: box(header.querySelector(".search__field")),
          links: [...header.querySelectorAll("nav a")].map((a) => {
            const name = document.createRange();
            name.selectNodeContents(a);
            return { box: box(a), name: name.getBoundingClientRect() };
          }),
        };
      });
      expect(parts.root, label).toBe(text);
      expect(parts.links, label).toHaveLength(4);
      for (const [i, { box, name }] of parts.links.entries()) {
        // Its name inside its own target, and the target a thumb's.
        expect(name.left >= box.left && name.right <= box.right, `${label}: link ${i} whole`).toBe(
          true,
        );
        expect(Math.min(box.width, box.height), `${label}: link ${i}`).toBeGreaterThanOrEqual(43.5);
        expect(overlaps(box, parts.search), `${label}: link ${i} over the search`).toBe(false);
        for (const other of parts.links.slice(i + 1))
          expect(overlaps(box, other.box), `${label}: links ${i} apart`).toBe(false);
      }
      // No text over other text or cut, no label wrapped, and the page no wider than the window.
      expect(await layoutFaults(page), label).toStrictEqual([]);
    }
  });
});
