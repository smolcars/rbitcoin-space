// The accessibility pass (docs/FRONTEND.md "Accessibility"): every page in e2e/pages.ts under
// axe-core, a keyboard walk, reduced motion, and at a large text size.
import type { Page } from "@playwright/test";
import { axe } from "./axe";
import { chain, expect, test } from "./fixtures";
import { expectFaults, open, PAGES } from "./pages";
import { tablesSettled } from "./rows";

interface Stop {
  /** The element's own number, so a second control of the same name is not the first again. */
  id: number;
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
    const ids = new Map<Element, number>();
    // A picture's control draws its ring as a stroke on a shape inside it: at least 2 px, visible,
    // in --color-focus, the colour the site keeps for focus, so a diagram's own strokes never count.
    const svgRing = (e: SVGElement): boolean => {
      const probe = document.createElementNS("http://www.w3.org/2000/svg", "g");
      probe.style.stroke = "var(--color-focus)";
      e.append(probe);
      const focus = getComputedStyle(probe).stroke;
      probe.remove();
      return [...e.querySelectorAll("*")].some((x) => {
        const s = getComputedStyle(x);
        return (
          s.stroke === focus &&
          Number.parseFloat(s.strokeWidth) >= 2 &&
          Number.parseFloat(s.strokeOpacity) > 0 &&
          s.visibility !== "hidden"
        );
      });
    };
    w.here = (): Stop | null => {
      const e = document.activeElement;
      // A picture's controls are SVG elements (the Arkade exit path's nodes).
      if (!(e instanceof HTMLElement || e instanceof SVGElement) || e === document.body)
        return null;
      if (!ids.has(e)) ids.set(e, ids.size);
      // The ring is the element's own outline, or its field's (the search draws it on its box).
      let ring = false;
      for (const x of [e, e.parentElement]) {
        const s = x && getComputedStyle(x);
        if (s && s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) >= 2) ring = true;
      }
      if (e instanceof SVGElement) ring ||= svgRing(e);
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
      return { id: ids.get(e) ?? -1, name: `${e.tagName.toLowerCase()} "${name}"`, ring, covered };
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
 * in sight is reached in the order the page reads, header, main, then footer. Returns what fails.
 */
async function walk(page: Page, browserName: string): Promise<string[]> {
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
    end = after.findIndex((s, i) => !s || (i > 0 && s.id === after[0]?.id));
  }
  const stops = after.slice(0, end < 0 ? after.length : end) as Stop[];
  // Only the stops kept count as reached: presses past the end went round again.
  await page.evaluate((n) => {
    for (const e of (window as unknown as Walked).at.slice(1, n + 1)) {
      if (e instanceof HTMLElement || e instanceof SVGElement) e.dataset["walked"] = "";
    }
  }, stops.length);
  const found: string[] = [];
  if (stops[0]?.name !== 'a "Skip to content"') {
    found.push(`the first stop is ${stops[0]?.name ?? "nothing"}, not a "Skip to content"`);
  }
  for (const s of stops) {
    if (!s.ring) found.push(`no focus ring: ${s.name}`);
    if (s.covered) found.push(`under the header, tabbing down: ${s.name}`);
  }
  const order = await page.evaluate(() => {
    const parts = [".site-header", "#main", ".site-footer"];
    const tabbable = [
      ...document.querySelectorAll<HTMLElement | SVGElement>(
        "a[href], button, input, select, textarea, summary, [tabindex]",
      ),
    ].filter(
      (e) =>
        e.tabIndex >= 0 &&
        !(e as HTMLButtonElement).disabled &&
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility !== "hidden" &&
        !e.closest("[inert]") &&
        // Folded away in a closed <details>, which Tab rightly passes.
        !e.closest("details:not([open]) > :not(summary)"),
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
  if (order.positive > 0) {
    found.push(`a positive tabindex on ${order.positive}, which reorders the page`);
  }
  for (const m of order.missed) found.push(`Tab never reaches ${m}`);
  if (!order.parts.every((p, i) => p >= (order.parts[i - 1] ?? 0))) {
    found.push("the stops are not header, then main, then footer");
  }
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
  for (const s of [...seen.slice(1), now]) {
    if (s?.covered) found.push(`under the header, tabbing up: ${s.name}`);
  }
  return found;
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
 * WCAG's reflow at 320 px, and a large text size: a phone's at 320 px and 200% on a desktop, on
 * the page as loaded, resized and its text set larger, as a reader does. A browser's text size is
 * its default font size, which Chromium alone lets a test set. Returns what fails.
 */
async function largeText(page: Page, browserName: string): Promise<string[]> {
  const chromium = browserName === "chromium";
  const sizes = [
    { width: 320, height: 640, text: 16 },
    ...(chromium
      ? [
          { width: 320, height: 640, text: 24 },
          { width: 1280, height: 800, text: 32 },
        ]
      : []),
  ];
  const cdp = chromium ? await page.context().newCDPSession(page) : undefined;
  // The walk leaves focus on the skip link, which shows while focused. Every disclosure is opened
  // here, before the first size settles: what one holds can mount a moment after it opens.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    for (const d of document.querySelectorAll("details")) d.open = true;
  });
  const found: string[] = [];
  for (const size of sizes) {
    const at = `${size.width} px at ${size.text} px text`;
    await page.setViewportSize(size);
    await cdp?.send("Page.setFontSizes", {
      fontSizes: { standard: size.text, fixed: Math.round((size.text * 13) / 16) },
    });
    // At rest, as a page loaded at this size is: anything the change set moving has finished.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );
    await tablesSettled(page);
    const { scroll, out } = await overflow(page);
    if (scroll > 0) found.push(`${at}: the page scrolls ${scroll} px sideways`);
    for (const e of out) found.push(`${at}: ${e} reaches past the window`);
    const links = await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link")
      .evaluateAll((all) => all.map((a) => a.getBoundingClientRect()));
    const apart = links.every((a, i) =>
      links.slice(i + 1).every((b) => a.right <= b.left + 1 || a.bottom <= b.top + 1),
    );
    if (!apart) found.push(`${at}: the sections run into each other`);
    // A short screen keeps the whole of it for the page: the header scrolls away.
    const sticky = await page
      .getByRole("banner")
      .evaluate((h) => getComputedStyle(h).position === "sticky");
    if (sticky !== size.height / size.text >= 30) {
      found.push(`${at}: the header ${sticky ? "sticks on a short screen" : "scrolls away"}`);
    }
  }
  return found;
}

test.describe("every page", () => {
  // The address above the cap is refused its totals (a stand-in 503), as the node does.
  test.use({ reducedMotion: "reduce", consoleErrorsAllowed: [/status of 503/] });
  for (const swept of PAGES) {
    test(`${swept.path}: no checker finding in either theme, a keyboard walk, no movement under reduced motion, and reflow at large text sizes`, async ({
      page,
      browserName,
    }) => {
      await watchMotion(page);
      await open(page, swept);
      const found = (await axe(page)).map((f) => `axe-core, light: ${f}`);
      await page.emulateMedia({ colorScheme: "dark" });
      found.push(...(await axe(page, ["color-contrast"])).map((f) => `contrast, dark: ${f}`));
      await page.emulateMedia({ colorScheme: "light" });
      // A keyboard is a desktop's; a phone's run checks the rest.
      const desktop = (page.viewportSize()?.width ?? 0) > 640;
      const walked = desktop ? await walk(page, browserName) : undefined;
      found.push(...(await moved(page)).map((m) => `moves under reduced motion: ${m}`));
      expectFaults(found, swept, "a11y");
      if (walked) expectFaults(walked, swept, "walk");
      // Last: it opens every disclosure and changes the window and the text size.
      expectFaults(await largeText(page, browserName), swept, "largeText");
    });
  }
});

// The walk's ring check for a picture's controls: a stroke that is always there is no ring.
test("an SVG control's ring is a focus-coloured stroke, not any stroke it always has", async ({
  page,
}) => {
  await page.goto("/regtest/no/such/page");
  // Built through the CSSOM: the policy refuses style attributes and elements.
  await page.evaluate(() => {
    const ns = "http://www.w3.org/2000/svg";
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      "g.probe { outline: none !important } g.ringed:focus-visible circle { stroke: var(--color-focus) }",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const svg = document.createElementNS(ns, "svg");
    for (const [name, stroke] of [
      ["always", "#888"],
      ["ringed", "none"],
    ] as const) {
      const g = document.createElementNS(ns, "g");
      g.setAttribute("class", `probe ${name}`);
      g.setAttribute("tabindex", "0");
      const c = document.createElementNS(ns, "circle");
      for (const [k, v] of [
        ["r", "9"],
        ["cx", "10"],
        ["cy", "10"],
        ["stroke", stroke],
        ["stroke-width", "2"],
      ] as const)
        c.setAttribute(k, v);
      g.append(c);
      svg.append(g);
    }
    document.querySelector("main")?.prepend(svg);
  });
  await record(page);
  await page.locator("g.always").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const { seen } = await noted(page);
  expect(seen.map((s) => s?.ring)).toStrictEqual([false, true]);
});

// Escape closes what opened and gives focus back to what opened it.
test("Escape closes the network menu and the search's answer", async ({ page, browserName }) => {
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  // A second network, so the switch is a menu rather than a label.
  await page.route("**/app/config", (r) =>
    r.fulfill({ json: { networks: ["regtest", "signet"], version: "test" } }),
  );
  await open(page, {
    path: `/regtest/address/${chain.addresses.p2tr}`,
    ready: (p) => p.getByRole("button", { name: /^Copy the exact balance/ }),
  });

  const network = page.getByRole("button", { name: /^Network: Regtest/ });
  await network.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator("#network-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(network).toBeFocused();

  const search = page.getByRole("combobox", { name: "Search" });
  await search.fill("nothing like an id");
  await search.press("Enter");
  // The answer is said, and Tab reaches its links, after the search's own scan button.
  await expect(page.getByRole("status").filter({ hasText: "Nothing matches" })).toHaveCount(1);
  await expect(page.getByText("Nothing matches", { exact: true })).toBeVisible();
  expect(await axe(page), "axe-core, the search's answer open").toEqual([]);
  await page.keyboard.press(tab);
  await expect(page.getByRole("button", { name: "Scan a QR code" })).toBeFocused();
  await page.keyboard.press(tab);
  await expect(page.locator(".search__panel a").first()).toBeFocused();
  await search.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Nothing matches", { exact: true })).toBeHidden();
  await expect(search).toBeFocused();
});

// The command palette is a modal dialog over the page: its field, list and hints, with results of
// several kinds, empty and typed, in both themes.
test("the command palette has no checker finding, empty and with results, in either theme", async ({
  page,
}) => {
  await page.goto("/regtest/blocks");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blocks");
  // ⌘K where the browser says it is Apple's (the WebKit profiles), Ctrl K elsewhere.
  const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent));
  await page.keyboard.press(apple ? "Meta+k" : "Control+k");
  const dialog = page.getByRole("dialog", { name: "Go to" });
  await expect(dialog.getByRole("option").first()).toBeVisible();
  expect.soft(await axe(page), "axe-core, the palette empty").toEqual([]);
  await dialog.getByRole("combobox").fill("2024-04-20");
  await expect(dialog.getByRole("group", { name: "Go to a date" })).toBeVisible();
  await dialog.getByRole("combobox").fill("106");
  await expect(dialog.getByRole("option").first()).toContainText("Block 106");
  expect.soft(await axe(page), "axe-core, the palette with results").toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect.soft(await axe(page, ["color-contrast"]), "contrast, dark").toEqual([]);
});

test("the QR scanner has no checker finding, in either theme", async ({ page }) => {
  await page.goto("/regtest/blocks");
  await page.getByRole("button", { name: "Scan a QR code" }).click();
  const dialog = page.getByRole("dialog", { name: "Scan a QR code" });
  // Headless Chromium has no camera: the scanner says so, beside the picture it offers instead.
  await expect(dialog.getByRole("status")).not.toHaveText("Starting the camera…");
  await expect(dialog).toBeFocused();
  expect.soft(await axe(page), "axe-core, the scanner").toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect.soft(await axe(page, ["color-contrast"]), "contrast, dark").toEqual([]);
});

test("the block field has no checker finding, open and refusing what was typed, in either theme", async ({
  page,
}) => {
  await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
  await page.getByRole("button", { name: "As of a block" }).click();
  const field = page.getByLabel("Block height or date");
  await expect(field).toBeVisible();
  expect.soft(await axe(page), "axe-core, the field open").toEqual([]);
  await field.fill("nonsense");
  await field.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  expect.soft(await axe(page), "axe-core, the field refusing").toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect.soft(await axe(page, ["color-contrast"]), "contrast, dark").toEqual([]);
  await page.goto(`/regtest/address/${chain.addresses.p2tr}?at=x`);
  await expect(page.getByRole("heading", { name: "“x” is not a block height" })).toBeVisible();
  await page.getByRole("button", { name: "Another block" }).click();
  expect.soft(await axe(page), "axe-core, a parameter that is no height, dark").toEqual([]);
});
