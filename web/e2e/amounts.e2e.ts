// Amounts at their longest, at a phone's width: never broken inside, never parted from their unit,
// never run into a neighbour. Real pages, their answers given the largest values they can hold.
import { readFileSync } from "node:fs";
import type { Locator, Page, Route } from "@playwright/test";
import { chain, expect, stubRetargets, test } from "./fixtures";
import { amountsIntact, copyNotesClear, exactsInside } from "./rows";

/** 21 million BTC to the satoshi, a 13-digit sat amount, the largest msat limit, fine rates. */
const ALL_BTC = 2_099_999_997_690_000;
const SATS_13 = 1_234_567_890_123;
const MSAT_MAX = 2_100_000_000_000_000_000;
const ACINQ = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";

const recorded = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/lightning/app/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

/** Answers a route with its real reply, changed. */
async function swell(page: Page, url: RegExp, change: (json: Record<string, unknown>) => void) {
  await page.route(url, async (route: Route) => {
    const reply = await route.fetch();
    const json = (await reply.json()) as Record<string, unknown>;
    change(json);
    await route.fulfill({ response: reply, json });
  });
}

async function lightning(page: Page) {
  const policy = {
    base_fee_msat: 1_234_567_890,
    cltv_delta: 2016,
    enabled: true,
    fee_rate: 999_999,
    last_update: 1_794_456_478,
    max_htlc_msat: MSAT_MAX,
    min_htlc_msat: 1,
  };
  const channel = recorded("channel-811984x2037x0");
  channel["capacity"] = ALL_BTC;
  for (const end of ["node_one", "node_two"]) {
    (channel[end] as Record<string, unknown>)["policy"] = policy;
  }
  const node = recorded("node-acinq");
  node["capacity"] = ALL_BTC;
  const answers: Record<string, unknown> = {
    status: recorded("status"),
    [`nodes/${ACINQ}`]: node,
    [`nodes/${ACINQ}/history`]: recorded("node-acinq-history"),
    "channels/811984x2037x0": channel,
    "channels/811984x2037x0/fees": recorded("channel-811984x2037x0-fees"),
  };
  await page.route(/\/regtest\/app\/lightning\//, async (route) => {
    const url = new URL(route.request().url());
    const key = url.pathname.replace(/^\/regtest\/app\/lightning\//, "");
    // Lightning on only for the Lightning pages: elsewhere the server says it is off, as it is.
    const fromLightning = page.url().includes("/lightning/");
    const json = key === "status" && !fromLightning ? undefined : answers[key];
    // Anything not recorded is the server's own answer (regtest runs without Lightning).
    await (json === undefined ? route.continue() : route.fulfill({ json }));
  });
}

async function esplora(page: Page) {
  await swell(page, /\/regtest\/api\/tx\/[0-9a-f]{64}$/, (tx) => {
    // A large fee a real transaction can pay: 13 digits of fee on 141 vB would be a rate no
    // transaction has. The 13-digit figures are on the address and block pages.
    tx["fee"] = 12_345_678;
    for (const out of tx["vout"] as Record<string, unknown>[]) out["value"] = ALL_BTC;
    for (const input of tx["vin"] as { prevout?: Record<string, unknown> | null }[]) {
      if (input.prevout) input.prevout["value"] = ALL_BTC;
    }
  });
  await swell(page, /\/regtest\/api\/address\/[^/]+$/, (a) => {
    a["chain_stats"] = {
      ...(a["chain_stats"] as object),
      funded_txo_sum: ALL_BTC + SATS_13,
      spent_txo_sum: SATS_13,
    };
  });
  await swell(page, /\/regtest\/app\/block\/[0-9a-f]{64}\/summary$/, (s) => {
    s["fees"] = SATS_13;
    s["fee_rate"] = {
      min: 0.101,
      p10: 1.234,
      p25: 12.345,
      median: 123.456,
      p75: 1234.567,
      p90: 12_345.678,
      max: 123_456.789,
    };
  });
  await swell(page, /\/regtest\/api\/v1\/mining\/pool\/unknown$/, (p) => {
    p["totalReward"] = String(ALL_BTC);
  });
}

const PAGES = [
  "/regtest/lightning/channel/811984x2037x0",
  `/regtest/lightning/node/${ACINQ}`,
  `/regtest/tx/${chain.txs.script_types}`,
  `/regtest/address/${chain.addresses.p2tr}`,
  `/regtest/block/${chain.blocks[106]}`,
  "/regtest/mining/pool/unknown",
  // Its past adjustments, mainnet's: words, arrows and difficulties in one row.
  "/regtest/mining",
  // Replacements: their fees and rates.
  "/regtest/rbf",
];

/** Opens a page with every figure in, in the wide faces a Linux machine falls back to. */
async function load(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Every figure in: nothing still loading.
  await expect(page.locator("main [aria-busy='true'], main .skel")).toHaveCount(0, {
    timeout: 15_000,
  });
  // CI's runner once broke a line a Mac's fonts kept whole.
  await page.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty("--font-sans", '"DejaVu Sans", Verdana, sans-serif');
    root.setProperty("--font-mono", '"DejaVu Sans Mono", "Courier New", monospace');
  });
}

const COPY_PAGE = /\/(block|tx|address|channel|node)\//;

// A test to a width and to a kind of check: four that run side by side, not one long one that
// held the browser job for 16 s on CI's runner.
for (const width of [320, 390]) {
  // Both schemes on each load: the figures' layout is the same, and each load costs a page.
  test(`amounts at their longest stay whole at ${width} px, in both schemes`, async ({ page }) => {
    await lightning(page);
    await esplora(page);
    await stubRetargets(page);
    // On the same loads at 390 px: every copy control copies plain text of its kind (below).
    const copies = width === 390;
    await recordCopies(page);
    await page.setViewportSize({ width, height: 900 });
    for (const path of PAGES) {
      await page.emulateMedia({ colorScheme: "light" });
      await load(page, path);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        await amountsIntact(page, `${path} at ${width} px, ${colorScheme}`);
      }
      // The pages with copy controls; the mining pages and the replacements' ids have none.
      if (!COPY_PAGE.test(path)) continue;
      await copyNotesClear(page, `${path} at ${width} px`);
      if (copies) await copiesPlain(page, path);
    }
  });

  // Each exact amount opens whole and on screen, whatever column it is in, moving nothing.
  test(`every exact amount opens whole and on screen at ${width} px`, async ({ page }) => {
    await lightning(page);
    await esplora(page);
    // In the dark scheme, as when these checks followed the amounts' light and dark passes.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width, height: 900 });
    // The pages that have them: a channel's terms and an address's totals (a node page has none).
    for (const path of PAGES.filter((p) => /channel|address/.test(p))) {
      await load(page, path);
      await exactsInside(page, `${path} at ${width} px`);
    }
  });
}

// On a desktop too, each "Copied" clears the value it copied (at a phone's widths: above). A test
// a page: five in one outran its time in WebKit at a phone's pixel density on CI's runner.
for (const path of PAGES.filter((p) => COPY_PAGE.test(p))) {
  test(`every copy control's confirmation stays clear of its value on a desktop: ${path}`, async ({
    page,
  }) => {
    await lightning(page);
    await esplora(page);
    await recordCopies(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await load(page, path);
    await copyNotesClear(page, `${path} on a desktop`);
  });
}

// One exact amount open at a time, and a scroll closes it (Safari never focused the button, so
// closing on blur left them open, two at once). A press elsewhere is the test below.
test("an exact amount closes on scrolling, and when another opens", async ({ page }) => {
  await lightning(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/regtest/lightning/channel/811984x2037x0");
  const controls = page.locator("main button:has(+ .exact)");
  await expect(controls.first()).toBeVisible();
  const open = page.locator(".exact:not([hidden])");
  await controls.nth(1).click();
  await expect(open).toHaveCount(1);
  await controls.nth(0).click();
  await expect(open).toHaveCount(1);
  await expect(controls.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(controls.nth(1)).toHaveAttribute("aria-expanded", "false");
  // The scroll a finger makes fires the same event; WebKit's test driver does not wheel the page.
  await page.evaluate(() => {
    window.scrollBy(0, 120);
  });
  await expect(open).toHaveCount(0);
  // A figure just under the sticky header opens its note below it, never over the header. A short
  // window, so the page scrolls far enough to put the figure there, but tall enough (30em) for the
  // header to stick.
  await page.setViewportSize({ width: 390, height: 520 });
  const first = controls.first();
  const gap = await first.evaluate((el) => {
    const header = () =>
      document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
    window.scrollBy(0, el.getBoundingClientRect().top - header() - 4);
    return el.getBoundingClientRect().top - header();
  });
  expect(gap, "the figure sits just under the header").toBeLessThan(12);
  await first.click();
  await expect(open).toHaveCount(1);
  const [top, header] = await open.evaluate((el) => [
    el.getBoundingClientRect().top,
    document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0,
  ]);
  expect(top).toBeGreaterThanOrEqual(header ?? 0);
});

type Input = "mouse" | "finger";

/**
 * Presses the middle of `target` with a mouse or a finger, at that point rather than through the
 * locator: Playwright retries a press whose target is covered until the test's time runs out. The
 * point is checked first, so a pop-up over it fails at once and says so.
 */
async function pressOn(page: Page, input: Input, target: Locator) {
  const at = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    // Across its middle, from the centre out, to the first point nothing covers.
    for (const f of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const x = r.left + r.width * f;
      const hit = document.elementFromPoint(x, y);
      if (hit !== null && el.contains(hit)) return { x, y };
    }
    return undefined;
  });
  if (!at) throw new Error("something covers the whole of the press's target");
  await (input === "finger" ? page.touchscreen.tap(at.x, at.y) : page.mouse.click(at.x, at.y));
}

/** Opens, by a press of `input`, an exact amount well away from `target`, and checks it opened. */
async function openAwayFrom(page: Page, input: Input, target: Locator) {
  const controls = page.locator("main button:has(+ .exact)");
  const i = await controls.evaluateAll(
    (all, t) => {
      const goal = t.getBoundingClientRect();
      return all.findIndex((b) => {
        const r = b.getBoundingClientRect();
        const away = r.bottom < goal.top - 60 || r.top > goal.bottom + 60;
        return r.width > 0 && r.top > 80 && r.bottom < innerHeight - 8 && away;
      });
    },
    await target.elementHandle(),
  );
  expect(i, "an exact amount on screen away from the target").toBeGreaterThanOrEqual(0);
  await pressOn(page, input, controls.nth(i));
  await expect(page.locator(".exact:not([hidden])")).toHaveCount(1);
}

// With an exact amount open, a press anywhere else only closes it, as the network menu does:
// Safari closed it and also opened the disclosure, or followed the link, under the finger. Safari
// sends a tap as touch, then a mouse's events and a click, so a finger is pressed as well as a
// mouse. The next press does what it touches; another figure opens in one press.
for (const input of ["mouse", "finger"] as const) {
  test(`a ${input}'s press outside an open exact amount only closes it`, async ({
    browser,
    browserName,
    extraHTTPHeaders,
    page: fixturePage,
  }) => {
    // A finger's own context: touch, and a phone's mobile viewport where the engine has one.
    const context =
      input === "finger"
        ? await browser.newContext({
            hasTouch: true,
            isMobile: browserName !== "firefox",
            // Tall enough for the whole page: a scroll would close the pop-up.
            viewport: { width: 390, height: 2000 },
            ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
          })
        : undefined;
    const page = context ? await context.newPage() : fixturePage;
    if (!context)
      await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height: 2000 });
    await lightning(page);
    const path = "/regtest/lightning/channel/811984x2037x0";
    await page.goto(path);
    const open = page.locator(".exact:not([hidden])");
    const about = page.locator("details.more", { hasText: "Whose fee is whose" });
    const summary = about.locator("summary");
    const node = page.locator(`main a[href$="/lightning/node/${ACINQ}"]`).first();
    const theme = page.locator(".site-header button[aria-label^='Switch to']");
    await expect(summary).toBeVisible();

    // A disclosure: the pop-up closes, the disclosure stays shut; the next press opens it.
    await openAwayFrom(page, input, summary);
    await pressOn(page, input, summary);
    await expect(open).toHaveCount(0);
    expect(await about.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    await pressOn(page, input, summary);
    expect(await about.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);

    // A button: the theme stays as it was.
    await openAwayFrom(page, input, summary);
    const scheme = await theme.getAttribute("aria-label");
    await pressOn(page, input, theme);
    await expect(open).toHaveCount(0);
    await expect(theme).toHaveAttribute("aria-label", scheme ?? "");

    // Another figure: it opens in the same press, as before.
    await openAwayFrom(page, input, summary);
    const other = page.locator("main button[aria-expanded='false']:has(+ .exact)").filter({
      visible: true,
    });
    await pressOn(page, input, other.first());
    await expect(open).toHaveCount(1);

    // A link: the page stays; the next press follows it. Escape closes with nothing armed.
    await openAwayFrom(page, input, node);
    await pressOn(page, input, node);
    await expect(open).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(path);
    await openAwayFrom(page, input, node);
    await page.keyboard.press("Escape");
    await expect(open).toHaveCount(0);
    await pressOn(page, input, node);
    await expect(page).toHaveURL(new RegExp(`/lightning/node/${ACINQ}$`));
    await context?.close();
  });
}

// A copied value is pasted into wallets, spreadsheets and calculators: it once carried the page's
// grouping space ("5 954.38071385"). Every copy control copies plain text of its kind, checked
// as the page hands it to the clipboard, the same in every engine.
const COPIED: [RegExp, RegExp][] = [
  [/transaction ID|block hash|merkle root/, /^[0-9a-f]{64}$/],
  [/public key/, /^0[23][0-9a-f]{64}$/],
  [/address$/, /^(?:bcrt1[02-9ac-hj-np-z]{8,87}|[1-9A-HJ-NP-Za-km-z]{25,35})$/],
  [/in BTC$/, /^-?\d+\.\d{8}$/],
  [/in msat$/, /^\d+$/],
  [/channel id$/, /^\d+x\d+x\d+$/],
  [/channel id as one number$/, /^\d+$/],
  [/channel id in lnd's form$/, /^\d+:\d+:\d+$/],
  [/hex$|^Copy item \d+$/, /^(?:[0-9a-f]{2})+$/],
  // A node's key at its first announced address, as a wallet takes it to connect.
  [/connect string$/, /^0[23][0-9a-f]{64}@\S+$/],
];

/** Records what the page hands the clipboard, in place of the clipboard itself. */
async function recordCopies(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { copied });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
}

/** Clicks every copy control on the page, those in closed pop-ups too, in one call. */
async function copiesPlain(page: Page, path: string) {
  const pairs = await page.evaluate(() => {
    const copied = (window as unknown as { copied: string[] }).copied;
    return [...document.querySelectorAll<HTMLButtonElement>("main button.copy")].map((b) => {
      const before = copied.length;
      b.click();
      // Its own copy, not the last button's: exactly one new entry.
      return [b.title, copied.length - before, copied.at(-1) ?? ""] as const;
    });
  });
  expect(pairs.length, `${path}: copy controls`).toBeGreaterThan(0);
  for (const [label, added, text] of pairs) {
    expect(added, `${path}: "${label}" copied once`).toBe(1);
    const kind = COPIED.find(([name]) => name.test(label));
    expect(kind, `${path}: "${label}" is a kind this test knows`).toBeDefined();
    expect(text, `${path}: "${label}"`).toMatch(kind?.[1] ?? /^$/);
  }
}
