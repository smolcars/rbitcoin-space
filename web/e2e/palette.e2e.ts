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

async function withPools(page: Page) {
  await page.route(/\/regtest\/api\/v1\/mining\/pools$/, (r) => r.fulfill({ json: POOLS }));
}

test("Ctrl K opens it from any page, loading its code only then, and Escape closes it", async ({
  page,
}) => {
  const asked: string[] = [];
  page.on("request", (r) => asked.push(new URL(r.url()).pathname));
  await page.goto("/regtest/blocks");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blocks");
  expect(asked.filter((p) => /\/Palette-[^/]+\.(js|css)$/.test(p))).toStrictEqual([]);

  await page.keyboard.press("Control+k");
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
  await page.keyboard.press("Control+k");
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toHaveCount(0);
  await expect(search).toBeFocused();
  // "/" still belongs to the header search.
  await page.getByRole("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
});

test("the header's hint opens it, and a press outside closes it and gives focus back", async ({
  page,
}) => {
  await page.goto("/regtest/");
  const hint = page.getByRole("button", { name: "Go to" });
  await expect(hint).toHaveAttribute("aria-keyshortcuts", "Control+K");
  await expect(hint).toHaveText("CtrlK");
  await hint.click();
  await expect(field(page)).toBeFocused();
  // Nothing typed: the pages, then the actions.
  await expect(palette(page).getByRole("group", { name: "Pages" })).toBeVisible();
  await expect(palette(page).getByRole("group", { name: "Actions" })).toBeVisible();
  await expect(selected(page)).toContainText("Home");
  await page.mouse.click(5, 5);
  await expect(palette(page)).toHaveCount(0);
  await expect(hint).toBeFocused();
});

test("arrow keys, Home and End move the selection; a pointer selects without taking focus", async ({
  page,
}) => {
  await page.goto("/regtest/");
  await page.keyboard.press("Control+k");
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
    await page.keyboard.press("Control+k");
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
  await page.keyboard.press("Control+k");
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
  await page.keyboard.press("Control+k");
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
  await page.keyboard.press("Control+k");
  await field(page).fill("acinq");
  const group = palette(page).getByRole("group", { name: "Lightning nodes" });
  const node = group.getByRole("option").first();
  await expect(node).toContainText("ACINQ");
  // The alias is a claim; the key beside it is the identity.
  await expect(node).toContainText(`${ACINQ.slice(0, 8)}…${ACINQ.slice(-8)}`);
  await expect(group.getByRole("option").last()).toContainText("All Lightning results");
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
    await page.keyboard.press("Control+k");
    await field(page).fill("dark");
    await expect(selected(page)).toContainText("Switch to dark theme");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(palette(page)).toHaveCount(0);

    await page.keyboard.press("Control+k");
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
  // At rest the header has no room for it; while the search has focus, the sections' row does.
  const go = page.getByRole("button", { name: "Go to a page, pool or date" });
  await expect(go).toBeHidden();
  const search = page.getByRole("combobox", { name: "Search" });
  await search.click();
  await search.fill("foundry");
  await expect(go).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
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
