// The command palette (src/palette): opened by Ctrl K (⌘K on Apple's keyboards) or the header's
// hint, loaded on first open, and every kind of result leading to its page.
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { withInvoice } from "./decode-answers";
import { ACINQ, mainnet, serve } from "./lightning-answers";

// A regtest block hash has no leading zeros, so a hash is asked for as a transaction first.
test.use({ consoleErrorsAllowed: [/status of 404/] });

const palette = (page: Page) => page.getByRole("dialog", { name: "Go to" });
const field = (page: Page) => palette(page).getByRole("combobox", { name: "Go to" });
const options = (page: Page) => palette(page).getByRole("option");
/** The option the field points at. */
const selected = (page: Page) => palette(page).locator('[role="option"][aria-selected="true"]');

const POOLS = [
  { name: "Unknown", slug: "unknown", unique_id: 0 },
  { name: "Foundry USA", slug: "foundryusa", unique_id: 111 },
  { name: "<img src=x onerror=alert(1)>", slug: "hostile", unique_id: 112 },
  { name: "AntPool", slug: "antpool", unique_id: 44 },
];

/** Whether the run's browser says it is Apple's (the WebKit profiles do): its shortcut is ⌘K. */
const onApple = (page: Page) =>
  page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent));
/** Presses the palette's shortcut as this platform's reader would. */
async function shortcut(page: Page) {
  await page.keyboard.press((await onApple(page)) ? "Meta+k" : "Control+k");
}

async function withPools(page: Page) {
  await page.route(/\/regtest\/api\/v1\/mining\/pools$/, (r) => r.fulfill({ json: POOLS }));
}

test("its shortcut opens it from any page, loading its code only then, and Escape closes it", async ({
  page,
}) => {
  const asked: string[] = [];
  page.on("request", (r) => asked.push(new URL(r.url()).pathname));
  await page.goto("/regtest/blocks");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blocks");
  expect(asked.filter((p) => /\/Palette-[^/]+\.(js|css)$/.test(p))).toStrictEqual([]);

  await shortcut(page);
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  expect(asked.filter((p) => /\/Palette-[^/]+\.js$/.test(p))).toHaveLength(1);
  // Tab never reaches the page behind it.
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Tab");
    const outside = await page.evaluate(() => {
      const a = document.activeElement;
      return a !== null && a !== document.body && a.closest("dialog") === null;
    });
    expect(outside).toBe(false);
  }
  await field(page).focus();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);

  // The shortcut works from inside a text field too, and pressed again it closes.
  const search = page.getByRole("combobox", { name: "Search" });
  await search.focus();
  await shortcut(page);
  await expect(field(page)).toBeFocused();
  await shortcut(page);
  await expect(palette(page)).toHaveCount(0);
  await expect(search).toBeFocused();
  // "/" still belongs to the header search.
  await page.getByRole("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
});

test("the header's opener opens it, and a press outside closes it and gives focus back", async ({
  page,
}) => {
  await page.goto("/regtest/");
  const apple = await onApple(page);
  const hint = page.getByRole("button", { name: "Go to", exact: true });
  // A phone's run has no room for the hint: its way in is beside its search.
  const phone = !(await hint.isVisible());
  let opener = hint;
  if (phone) {
    opener = page.getByRole("combobox", { name: "Search" });
    await opener.click();
    await page.getByRole("button", { name: "Go to a page, pool or date" }).click();
  } else {
    await expect(hint).toHaveAttribute("aria-keyshortcuts", apple ? "Meta+K" : "Control+K");
    await expect(hint).toHaveText(apple ? "⌘K" : "CtrlK");
    await hint.click();
  }
  await expect(field(page)).toBeFocused();
  // Nothing typed: the pages, then the actions.
  await expect(palette(page).getByRole("group", { name: "Pages" })).toBeVisible();
  await expect(palette(page).getByRole("group", { name: "Actions" })).toBeVisible();
  await expect(selected(page)).toContainText("Home");
  await page.mouse.click(5, 5);
  await expect(palette(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("arrow keys, Home and End move the selection; a pointer selects without taking focus", async ({
  page,
}) => {
  await page.goto("/regtest/");
  await shortcut(page);
  const input = field(page);
  await expect(selected(page)).toContainText("Home");
  const count = await options(page).count();
  expect(count).toBeGreaterThan(4);
  const activeIs = async (i: number) => {
    const id = await options(page).nth(i).getAttribute("id");
    await expect(input).toHaveAttribute("aria-activedescendant", id ?? "");
    await expect(options(page).nth(i)).toHaveAttribute("aria-selected", "true");
  };
  await activeIs(0);
  await page.keyboard.press("ArrowDown");
  await activeIs(1);
  await page.keyboard.press("End");
  await activeIs(count - 1);
  await page.keyboard.press("ArrowDown");
  await activeIs(0);
  await page.keyboard.press("ArrowUp");
  await activeIs(count - 1);
  await page.keyboard.press("Home");
  await activeIs(0);
  await options(page).nth(2).hover();
  await activeIs(2);
  await expect(input).toBeFocused();
  // Typing goes on in the field, and the count is said once it settles.
  await page.keyboard.type("blo");
  await expect(input).toHaveValue("blo");
  await expect(selected(page)).toContainText("Blocks");
  await expect(palette(page).getByRole("status")).toHaveText(/^\d+ results?$/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/regtest/blocks");
  await expect(palette(page)).toHaveCount(0);
});

const kinds: { kind: string; query: string; row: RegExp; url: string | RegExp }[] = [
  { kind: "a page", query: "min", row: /Mining\s*Page/, url: "/regtest/mining" },
  { kind: "a height", query: "106", row: /Block 106/, url: "/regtest/block/106" },
  {
    kind: "a block hash",
    query: chain.blocks[106],
    row: /Transaction or block/i,
    url: `/regtest/block/${chain.blocks[106]}`,
  },
  {
    kind: "a transaction",
    query: chain.txs.payment,
    row: /Transaction or block/i,
    url: `/regtest/tx/${chain.txs.payment}`,
  },
  {
    kind: "an address",
    query: chain.addresses.p2tr,
    row: /P2TR address/,
    url: `/regtest/address/${chain.addresses.p2tr}`,
  },
  {
    kind: "a payment string",
    query: "lightning:LNBC20M1EXAMPLE",
    row: /Lightning invoice/,
    url: /\/decode#lightning%3ALNBC20M1EXAMPLE$/,
  },
];

for (const c of kinds) {
  test(`${c.kind} leads to its page`, async ({ page }) => {
    await withInvoice(page);
    await page.goto("/regtest/");
    await shortcut(page);
    await field(page).fill(c.query);
    await expect(options(page).first()).toContainText(c.row);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(c.url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
}

test("a pool leads to its page, and a hostile pool name is only text", async ({ page }) => {
  await withPools(page);
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await page.goto("/regtest/");
  await shortcut(page);
  await field(page).fill("img");
  const hostile = palette(page).getByRole("option", { name: /<img src=x onerror=alert\(1\)>/ });
  await expect(hostile).toBeVisible();
  await expect(palette(page).locator("img")).toHaveCount(0);
  expect(dialogs).toBe(0);
  await field(page).fill("foundry");
  const group = palette(page).getByRole("group", { name: "Mining pools" });
  await expect(group.getByRole("option")).toHaveText([/Foundry USA\s*Mining pool/]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/regtest/mining/pool/foundryusa");
});

test("a date leads to the newest block by the end of that day in UTC", async ({ page }) => {
  const asked: string[] = [];
  await page.route(/\/regtest\/api\/v1\/mining\/blocks\/timestamp\/\d+$/, (r) => {
    asked.push(new URL(r.request().url()).pathname.split("/").at(-1) ?? "");
    return r.fulfill({
      json: { height: 106, hash: chain.blocks[106], timestamp: "2024-04-20T23:50:00.000Z" },
    });
  });
  await page.goto("/regtest/");
  await shortcut(page);
  await field(page).fill("20 April 2024");
  const row = palette(page).getByRole("group", { name: "Go to a date" }).getByRole("option");
  await expect(row).toContainText("20 Apr 2024, end of the day UTC");
  await expect(row).toContainText("Block 106, the newest by then");
  expect(asked).toStrictEqual([String(Date.UTC(2024, 3, 20, 23, 59, 59) / 1000)]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/regtest/block/${chain.blocks[106]}`);
});

test("a Lightning name lists nodes with their keys and leads to one", async ({ page }) => {
  await serve(page, mainnet());
  await page.goto("/regtest/");
  await shortcut(page);
  await field(page).fill("acinq");
  const group = palette(page).getByRole("group", { name: "Lightning nodes" });
  const node = group.getByRole("option").first();
  await expect(node).toContainText("ACINQ");
  // The alias is a claim; the key beside it is the identity.
  await expect(node).toContainText(`${ACINQ.slice(0, 8)}…${ACINQ.slice(-8)}`);
  // The catch-all comes after everything that matched by name.
  await expect(options(page).last()).toContainText("All Lightning results");
  // The catch-all was the row shown selected before the nodes came, so it keeps the selection
  // (the reader's Enter opens what they saw); the reader moves up to the node.
  await expect(selected(page)).toContainText("All Lightning results");
  await page.keyboard.press("Home");
  await expect(selected(page)).toContainText("ACINQ");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/regtest/lightning/node/${ACINQ}`);
});

test.describe("actions", () => {
  // Signet is listed but not served here: its page's requests fail once it is open.
  test.use({ consoleErrorsAllowed: [/status of (404|502|503)/] });
  test("switch the theme and the network", async ({ page }) => {
    await page.route(/\/app\/config$/, async (route) => {
      const response = await route.fetch();
      const config = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...config, networks: ["regtest", "signet"] } });
    });
    await page.goto("/regtest/blocks");
    await shortcut(page);
    await field(page).fill("dark");
    await expect(selected(page)).toContainText("Switch to dark theme");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(palette(page)).toHaveCount(0);

    await shortcut(page);
    await field(page).fill("signet");
    await expect(selected(page)).toContainText("Switch to Signet");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/signet/blocks");
  });
});

test("a phone opens it from beside its search as a sheet, with what was typed", async ({
  page,
}) => {
  await withPools(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/regtest/");
  // At rest the header has no room for it; while the search has focus it hangs under the search,
  // over the page, and the sections stay where they are.
  const go = page.getByRole("button", { name: "Go to a page, pool or date" });
  await expect(go).toBeHidden();
  const nav = page.getByRole("navigation", { name: "Main" });
  const before = await nav.boundingBox();
  const search = page.getByRole("combobox", { name: "Search" });
  await search.click();
  await search.fill("foundry");
  await expect(go).toBeVisible();
  await expect(nav).toBeVisible();
  expect(await nav.boundingBox()).toStrictEqual(before);
  const under = await go.boundingBox();
  const searchBox = await page.locator(".search__field").boundingBox();
  expect(under && searchBox && under.y >= searchBox.y + searchBox.height).toBe(true);
  expect(under?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  await go.click();
  await expect(field(page)).toHaveValue("foundry");
  await expect(field(page)).toBeFocused();
  const box = await palette(page).locator(".palette__panel").boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(340);
  expect(box?.y ?? 99).toBeLessThan(20);
  await expect(palette(page).getByRole("option", { name: /Foundry USA/ })).toBeVisible();
  // As if the on-screen keyboard took half the screen: the sheet stays above it.
  await page.setViewportSize({ width: 360, height: 320 });
  const shrunk = await palette(page).locator(".palette__panel").boundingBox();
  expect((shrunk?.y ?? 0) + (shrunk?.height ?? 999)).toBeLessThanOrEqual(320);
});

// The hint shares the header search's cell: where there is no room for both, the hint gives way,
// never the search's placeholder; it shows at some width on either side of the 65em break. Lightning and Ark on, so the sections take their most room.
test("the hint never cuts the header search's placeholder", async ({ page }) => {
  await page.route(/\/app\/config$/, async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...config, lightning: ["regtest"], ark: { regtest: ["bark"] } },
    });
  });
  await page.goto("/regtest/blocks");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveCount(5);
  const cut: string[] = [];
  for (let width = 641; width <= 1600; width += 23) {
    await page.setViewportSize({ width, height: 800 });
    const room = await page.getByRole("combobox", { name: "Search" }).evaluate((el) => {
      const input = el as HTMLInputElement;
      const s = getComputedStyle(input);
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return 0;
      ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const space =
        input.clientWidth - Number.parseFloat(s.paddingLeft) - Number.parseFloat(s.paddingRight);
      return space - ctx.measureText(input.placeholder).width;
    });
    // Where the hint is hidden the field is as it was before it (at 1,055 px it is 3 px short of
    // its words with every section on, hint or not): only the hint's own cost is held here.
    const hinted = await page.locator(".palette-hint").isVisible();
    if (hinted && room < 0) cut.push(`${width} px: ${Math.round(room)} px short`);
  }
  expect(cut).toStrictEqual([]);
  for (const width of [800, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator(".palette-hint")).toBeVisible();
  }
});

/** Holds the answers to `pattern` until `release` is called; returns how many were asked. */
async function hold(page: Page, pattern: RegExp, answer?: unknown) {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const seen = { count: 0 };
  await page.route(pattern, async (route) => {
    seen.count += 1;
    await gate;
    await (answer === undefined ? route.continue() : route.fulfill({ json: answer }));
  });
  return { seen, release: () => open() };
}

test.describe("an explicit lookup", () => {
  test("is not cancelled by the suggestions' timer when Enter comes at once", async ({ page }) => {
    // With Lightning on, the timer would ask for node names 280 ms after the last key.
    await serve(page, mainnet());
    const status = await hold(page, /\/regtest\/api\/tx\/[0-9a-f]{64}\/status$/);
    await page.goto("/regtest/");
    await shortcut(page);
    await field(page).fill(chain.txs.payment);
    await page.keyboard.press("Enter");
    await expect(selected(page)).toContainText("Looking up");
    await page.waitForTimeout(600);
    status.release();
    await expect(page).toHaveURL(`/regtest/tx/${chain.txs.payment}`);
  });

  test("of a date is not cancelled by the timer's own date request", async ({ page }) => {
    const stamp = await hold(page, /\/regtest\/api\/v1\/mining\/blocks\/timestamp\/\d+$/, {
      height: 106,
      hash: chain.blocks[106],
      timestamp: "2024-04-20T23:50:00.000Z",
    });
    await page.goto("/regtest/");
    await shortcut(page);
    await field(page).fill("2024-04-20");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    stamp.release();
    await expect(page).toHaveURL(`/regtest/block/${chain.blocks[106]}`);
  });

  test("that answers after Back never moves the reader, and the palette closes", async ({
    page,
  }) => {
    const status = await hold(page, /\/regtest\/api\/tx\/[0-9a-f]{64}\/status$/);
    await page.goto("/decode");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Blocks" })
      .click();
    await expect(page).toHaveURL(/\/blocks$/);
    await shortcut(page);
    await field(page).fill(chain.txs.payment);
    await page.keyboard.press("Enter");
    await expect(selected(page)).toContainText("Looking up");
    await page.goBack();
    await expect(page).toHaveURL("/decode");
    await expect(palette(page)).toHaveCount(0);
    status.release();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL("/decode");
  });

  test("asks nothing more once the palette has closed", async ({ page }) => {
    const pools = await hold(page, /\/regtest\/api\/v1\/mining\/pools$/, POOLS);
    const asked: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/blocks/timestamp/")) asked.push(r.url());
    });
    await page.goto("/regtest/");
    await shortcut(page);
    await field(page).fill("2024-04-20");
    // The timer has fired and waits for the pool list.
    await expect.poll(() => pools.seen.count).toBe(1);
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
    pools.release();
    await page.waitForTimeout(500);
    expect(asked).toStrictEqual([]);
  });
});

test.describe("a failed date lookup", () => {
  test.use({ consoleErrorsAllowed: [/status of 502/] });
  test("says so, not that there is no block", async ({ page }) => {
    await page.route(/\/regtest\/api\/v1\/mining\/blocks\/timestamp\/\d+$/, (r) =>
      r.fulfill({ status: 502, json: { error: "node unavailable" } }),
    );
    await page.goto("/regtest/");
    await shortcut(page);
    await field(page).fill("2024-04-20");
    const row = palette(page).getByRole("group", { name: "Go to a date" }).getByRole("option");
    await expect(row).toContainText("Could not look this up");
    await expect(row).not.toContainText("no block");
  });
});

test.describe("with a test network's errors allowed", () => {
  test.use({ consoleErrorsAllowed: [/status of (404|502)/] });
  test("today's date is asked for in whole seconds, and its answer shown", async ({ page }) => {
    const asked: string[] = [];
    await page.route(/\/regtest\/api\/v1\/mining\/blocks\/timestamp\/[^/]+$/, (r) => {
      asked.push(new URL(r.request().url()).pathname.split("/").at(-1) ?? "");
      return r.fulfill({ status: 404, json: { error: "none" } });
    });
    // Time moves on between the ask and its answer, as on a slow phone: today's moment, which is
    // now, is no longer the one asked about when the answer is shown.
    await page.clock.install();
    await page.goto("/regtest/");
    await shortcut(page);
    await field(page).fill(new Date().toISOString().slice(0, 10));
    await page.clock.runFor(1500);
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toMatch(/^\d+$/);
    await expect(selected(page)).toContainText("history has no block by then");
  });
});

test("a late row never changes which row Enter opens; the Lightning catch-all comes last", async ({
  page,
}) => {
  await serve(page, { ...mainnet(), "search?q=dark": { nodes: [], channels: [] } });
  const pools = await hold(page, /\/regtest\/api\/v1\/mining\/pools$/, [
    ...POOLS,
    { name: "Darkside", slug: "darkside", unique_id: 200 },
  ]);
  await page.goto("/regtest/");
  await shortcut(page);
  await field(page).fill("dark");
  await expect(options(page).first()).toContainText("Switch to dark theme");
  await expect(options(page).last()).toContainText("All Lightning results");
  await page.keyboard.press("Home");
  await expect(selected(page)).toContainText("Switch to dark theme");
  pools.release();
  await expect(palette(page).getByRole("option", { name: /Darkside/ })).toBeVisible();
  await expect(selected(page)).toContainText("Switch to dark theme");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page).toHaveURL("/regtest/");
});

test.describe("the shortcut", () => {
  test("pressed and Escape while its code downloads opens nothing", async ({ page }) => {
    await page.route(/\/assets\/Palette-[^/]+\.js$/, async (route) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 800);
      });
      await route.continue();
    });
    await page.goto("/regtest/");
    await shortcut(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);
    await expect(palette(page)).toHaveCount(0);
    await shortcut(page);
    await expect(palette(page)).toBeVisible();
  });

  test("held down opens once, and a key an input method composes is left alone", async ({
    page,
  }) => {
    await page.goto("/regtest/");
    const mod = (await onApple(page)) ? "Meta" : "Control";
    // The keydown an input method sends while composing.
    await page.evaluate((m) => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          metaKey: m === "Meta",
          ctrlKey: m === "Control",
          isComposing: true,
          bubbles: true,
        }),
      );
    }, mod);
    await page.waitForTimeout(300);
    await expect(palette(page)).toHaveCount(0);
    await page.keyboard.down(mod);
    await page.keyboard.down("k");
    await expect(palette(page)).toBeVisible();
    // Held: the browser repeats the key.
    await page.keyboard.down("k");
    await page.keyboard.down("k");
    await page.keyboard.up("k");
    await page.keyboard.up(mod);
    await page.waitForTimeout(400);
    await expect(palette(page)).toBeVisible();
  });
});

test("a phone's opener stays while Tab reaches it, and takes what was typed", async ({ page }) => {
  await withPools(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/regtest/");
  const search = page.getByRole("combobox", { name: "Search" });
  await search.click();
  await search.fill("foundry");
  const go = page.getByRole("button", { name: "Go to a page, pool or date" });
  await page.keyboard.press("Tab");
  await expect(go).toBeFocused();
  await expect(go).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(field(page)).toHaveValue("foundry");
});

test("a date before the first block says so and opens block 0", async ({ page }) => {
  await page.goto("/regtest/");
  await shortcut(page);
  await field(page).fill("2008-10-31");
  const row = palette(page).getByRole("group", { name: "Go to a date" }).getByRole("option");
  await expect(row).toContainText("Before the first block");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/regtest/block/0");
});

// Round two of the review: the opener as a state machine (src/palette/opener.ts), the lookups'
// lifecycle, and a way in at every width.

/** Holds every download of the palette's code until `release` is called. */
async function holdCode(page: Page) {
  return hold(page, /\/assets\/Palette-[^/]+\.js$/);
}

test("the selection shown by default stays when a late row lands above it", async ({ page }) => {
  await serve(page, { ...mainnet(), "search?q=dark": { nodes: [], channels: [] } });
  const pools = await hold(page, /\/regtest\/api\/v1\/mining\/pools$/, [
    ...POOLS,
    { name: "Darkside", slug: "darkside", unique_id: 200 },
  ]);
  await page.goto("/regtest/");
  await shortcut(page);
  await field(page).fill("dark");
  // No key moves the selection: the default the reader sees is what Enter opens.
  await expect(selected(page)).toContainText("Switch to dark theme");
  pools.release();
  await expect(options(page).first()).toContainText("Darkside");
  await expect(selected(page)).toContainText("Switch to dark theme");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page).toHaveURL("/regtest/");
});

test("an id lookup survives the server's config arriving while it waits", async ({ page }) => {
  const config = await hold(page, /\/app\/config$/);
  const status = await hold(page, /\/regtest\/api\/tx\/[0-9a-f]{64}\/status$/);
  await page.goto("/regtest/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await shortcut(page);
  await field(page).fill(chain.txs.payment);
  await page.keyboard.press("Enter");
  await expect(selected(page)).toContainText("Looking up");
  config.release();
  await page.waitForTimeout(400);
  status.release();
  await expect(page).toHaveURL(`/regtest/tx/${chain.txs.payment}`);
});

test.describe("a date looked up just before UTC midnight", () => {
  test.use({ consoleErrorsAllowed: [/status of 404/] });
  test("is asked again for the finished day once midnight has passed", async ({ page }) => {
    const asked: string[] = [];
    await page.route(/\/regtest\/api\/v1\/mining\/blocks\/timestamp\/\d+$/, (r) => {
      asked.push(new URL(r.request().url()).pathname.split("/").at(-1) ?? "");
      return r.fulfill({
        json: { height: 106, hash: chain.blocks[106], timestamp: "2026-11-19T23:50:00.000Z" },
      });
    });
    await page.clock.install({ time: new Date("2026-11-19T23:58:55Z") });
    await page.goto("/regtest/");
    await shortcut(page);
    await field(page).fill("2026-11-19");
    await page.clock.runFor(1000);
    await expect.poll(() => asked.length).toBe(1);
    await expect(selected(page)).toContainText("Block 106");
    // Past midnight the day is over: Enter asks for its whole length, not the morning's answer.
    await page.clock.runFor(70_000);
    await page.keyboard.press("Enter");
    await expect.poll(() => asked.length).toBe(2);
    expect(asked[1]).toBe(String(Date.UTC(2026, 10, 19, 23, 59, 59) / 1000));
  });
});

test.describe("while the palette closes", () => {
  test("Enter runs nothing", async ({ page }) => {
    await page.goto("/regtest/mining");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await shortcut(page);
    await field(page).fill("blocks");
    await expect(selected(page)).toContainText("Blocks");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL("/regtest/mining");
  });

  test("the shortcut opens it again once the fade has ended", async ({ page }) => {
    await page.goto("/regtest/mining");
    await shortcut(page);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await shortcut(page);
    await expect(palette(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
    await page.waitForTimeout(600);
    await expect(palette(page)).toBeVisible();
  });
});

test.describe("an open asked for while the code downloads", () => {
  test("is dropped by a navigation, so it never opens on the next page", async ({ page }) => {
    const code = await holdCode(page);
    await page.goto("/regtest/blocks");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blocks");
    await shortcut(page);
    await expect.poll(() => code.seen.count).toBeGreaterThan(0);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Mining" })
      .click();
    await expect(page).toHaveURL("/regtest/mining");
    code.release();
    await page.waitForTimeout(600);
    await expect(palette(page)).toHaveCount(0);
  });

  test("opens after an odd number of presses, and not after an even one", async ({ page }) => {
    const code = await holdCode(page);
    await page.goto("/regtest/blocks");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blocks");
    for (let i = 0; i < 3; i += 1) await shortcut(page);
    code.release();
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
  });
});

test("Tab and Shift+Tab reach every section of the header at 360 px", async ({ page }) => {
  await page.route(/\/app\/config$/, async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...config, lightning: ["regtest"] } });
  });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/regtest/blocks");
  const links = page.getByRole("navigation", { name: "Main" }).getByRole("link");
  await expect(links).toHaveCount(4);
  const names = await links.allInnerTexts();
  const focusedName = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  // Forward from the search: "Go to", then every section, then the theme.
  await page.getByRole("combobox", { name: "Search" }).focus();
  const forward: string[] = [];
  for (let i = 0; i < names.length + 2; i += 1) {
    await page.keyboard.press("Tab");
    forward.push(await focusedName());
  }
  expect(forward.slice(0, names.length + 1)).toStrictEqual([
    "Go to a page, pool or date",
    ...names,
  ]);
  // Back from the theme: every section, then the search ("Go to" shows only while the search or
  // it has focus, so going back it is the search that is reached).
  await page.getByRole("button", { name: /Switch to (light|dark) theme/ }).focus();
  const back: string[] = [];
  for (const _ of names) {
    await page.keyboard.press("Shift+Tab");
    back.push(await focusedName());
  }
  expect(back).toStrictEqual(names.map((_, i) => names[names.length - 1 - i] ?? ""));
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("combobox", { name: "Search" })).toBeFocused();
});

test("every width from 320 to 1,600 px has a way in: the hint, or Go to under the search", async ({
  page,
}) => {
  await page.goto("/regtest/blocks");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blocks");
  const hint = page.getByRole("button", { name: "Go to", exact: true });
  const go = page.getByRole("button", { name: "Go to a page, pool or date" });
  const search = page.getByRole("combobox", { name: "Search" });
  const none: number[] = [];
  for (let width = 320; width <= 1600; width += 20) {
    await page.setViewportSize({ width, height: 800 });
    if (await hint.isVisible()) continue;
    await search.focus();
    if (!(await go.isVisible()) || !(await go.isEnabled())) none.push(width);
    await search.blur();
  }
  expect(none).toStrictEqual([]);
});
