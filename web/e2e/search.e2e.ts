import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";

// A regtest block hash has no leading zeros, so search asks for a transaction first and gets a 404.
test.use({ consoleErrorsAllowed: [/status of 404/] });

const search = (page: Page) => page.getByRole("search").getByRole("combobox", { name: "Search" });

const cases = [
  { kind: "a height", query: "#106", url: "/regtest/block/106" },
  {
    kind: "a block hash",
    query: chain.blocks[106].toUpperCase(),
    url: `/regtest/block/${chain.blocks[106]}`,
  },
  { kind: "an outpoint", query: `${chain.txs.payment}:0`, url: `/regtest/tx/${chain.txs.payment}` },
  {
    kind: "an address",
    query: ` ${chain.addresses.p2tr} `,
    url: `/regtest/address/${chain.addresses.p2tr}`,
  },
  {
    kind: "a bitcoin: URI",
    query: `bitcoin:${chain.addresses.p2pkh}?amount=1`,
    url: `/regtest/address/${chain.addresses.p2pkh}`,
  },
];

for (const c of cases) {
  test(`${c.kind} lands on its page from the "/" shortcut`, async ({ page }) => {
    await page.goto("/regtest/");
    const field = search(page);
    await page.keyboard.press("/");
    await expect(field).toBeFocused();
    await field.fill(c.query);
    await field.press("Enter");
    await expect(page).toHaveURL(c.url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(field).toHaveValue("");
  });
}

for (const net of ["testnet4", "testnet5"]) {
  test(`a pasted ${net} link to another explorer opens the page here`, async ({ page }) => {
    await page.goto("/regtest/blocks");
    const field = search(page);
    await field.fill(`https://mempool.space/${net}/tx/${chain.txs.consolidation}#vin=0`);
    await expect(page.getByRole("search")).toContainText("Transaction");
    await field.press("Enter");
    await expect(page).toHaveURL(`/regtest/tx/${chain.txs.consolidation}`);
  });
}

test("nothing found says what was searched and what search finds", async ({ page }) => {
  await page.goto("/regtest/");
  const field = search(page);
  const missing = "ab".repeat(32);
  await field.fill(missing);
  await field.press("Enter");
  const box = page.getByRole("search");
  await expect(box.getByText("Nothing matches", { exact: true })).toBeVisible();
  await expect(box.getByTitle(missing)).toBeVisible();
  await expect(box.getByText("the whole address")).toBeVisible();
  await expect(page).toHaveURL("/regtest/");
  await expect(field).toHaveValue(missing);
  await field.press("Escape");
  await expect(box.getByText("Nothing matches", { exact: true })).toBeHidden();
});

// iOS's Done key closed the keyboard and took the focus: the panel then shrank to the resting
// field's width, a word or two a line. It keeps the searching layout while it is shown.
test("a phone's nothing-found panel keeps its width when the field loses focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/regtest/");
  const field = search(page);
  await field.fill("nothing like an id");
  await field.press("Enter");
  const panel = page.locator(".search__panel");
  await expect(panel).toBeVisible();
  const focused = (await panel.boundingBox())?.width ?? 0;
  await field.blur();
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())?.width ?? 0).toBeCloseTo(focused, 0);
  expect(focused).toBeGreaterThan(300);
  // A press outside closes it, and the header returns to rest.
  await page.getByRole("main").click({ position: { x: 5, y: 5 } });
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".brand")).toBeVisible();
});
