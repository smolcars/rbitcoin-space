// A very large address the server adds up once and then keeps (docs/API.md, "Very large
// addresses"): the honest wait on a first visit, the kept totals, transactions and chart after,
// a seed the node refused, and an address dropped from the ledger and asked for again.
import { expect, test } from "./fixtures";
import { KEPT, LARGE, stubLarge } from "./large-address";
import { FAILED_POLL_MS, LEDGER_POLL_MS } from "../src/pages/address/ledger";

test.use({ consoleErrorsAllowed: [/status of (404|429|502|503)/] });

test("a first visit says it is being added up, with real progress, then shows it", async ({
  page,
}) => {
  let state: unknown = { state: "queued", position: 3 };
  // The page's clock stands still but when the test moves it, so every timer the page starts
  // starts at one instant: its asks and its count are exact, and nothing waits.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await stubLarge(page, { ledger: () => state });
  await page.goto(`/regtest/address/${LARGE}`);
  const adding = page.getByRole("region", { name: "Adding up this address for the first time" });
  await expect(adding).toBeVisible();
  await expect(adding).toContainText("2 addresses ahead of it");
  // What the node says of it is still shown meanwhile.
  await expect(page.getByRole("region", { name: "What is known" })).toContainText(/3\s665\s660/);
  // The server's own count, read at the next ask; between asks the page counts on by itself, so
  // it moves every second: no spinner that cannot end.
  state = { state: "seeding", seconds: 12 };
  await page.clock.runFor(LEDGER_POLL_MS);
  await expect(adding).toContainText(/started 1\d s ago/);
  const heard = Number(/started (\d+) s ago/.exec((await adding.textContent()) ?? "")?.[1]);
  // Two seconds, and no ask between: the next is a poll away.
  await page.clock.runFor(2000);
  await expect(adding).toContainText(`started ${heard + 2} s ago`);
  state = KEPT;
  await page.clock.runFor(LEDGER_POLL_MS);
  await expect(page.getByRole("table", { name: /^Newest confirmed transactions/ })).toBeVisible();
  await expect(adding).toHaveCount(0);
});

test("a kept address shows its totals, newest transactions and balance at once", async ({
  page,
}) => {
  await stubLarge(page, { ledger: () => KEPT });
  await page.goto(`/regtest/address/${LARGE}`);
  const totals = page.getByRole("region", { name: "Totals" });
  await expect(totals).toContainText(/3\s800\s001/);
  await expect(page.getByText(/added this address up at block 105/)).toBeVisible();
  await expect(page.getByText(/exact at block 110/)).toBeVisible();
  const txs = page.getByRole("table", { name: /^Newest confirmed transactions/ });
  await expect(txs.locator("tbody tr")).toHaveCount(3);
  await expect(txs.locator("tbody tr").first()).toContainText("0def111d");
  await expect(txs.locator("tbody tr").nth(1)).toContainText(/[−-]12\.34567890/);
  await expect(
    page.getByText(/Until then it shows its newest 200 confirmed transactions/),
  ).toBeVisible();
  await expect(page.getByText(/are added once its node has listed them/)).toHaveCount(0);
  // A block opens on this network; a phone drops the block column.
  if ((page.viewportSize()?.width ?? 0) > 640) {
    await expect(txs.getByRole("link", { name: "110" })).toHaveAttribute(
      "href",
      "/regtest/block/110",
    );
  }
  // Three rows: no "more".
  await expect(page.getByRole("button", { name: /^Show \d+ more$/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Balance over time" })).toBeVisible();
  await expect(
    page.getByRole("slider", { name: /since this server began keeping it/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: /^Unconfirmed transactions of this address/ }),
  ).toBeVisible();
  // Nothing asks the node for its history: the server would refuse it.
  const asked: string[] = [];
  page.on("request", (r) => {
    if (/\/txs(\/summary|\/chain)?(\?|$)/.test(r.url())) asked.push(r.url());
  });
  await page.waitForTimeout(500);
  expect(asked).toStrictEqual([]);
});

test("a seed the node refused leaves the page as before the ledger", async ({ page }) => {
  await stubLarge(page, { ledger: () => ({ state: "refused", creates: 3_665_660, cap: 10_000 }) });
  await page.goto(`/regtest/address/${LARGE}`);
  const facts = page.getByRole("region", { name: "What is known" });
  await expect(facts).toContainText(/addresses paid by at most 10\s000 transactions/);
  await expect(
    page.getByRole("region", { name: "Adding up this address for the first time" }),
  ).toHaveCount(0);
});

test("an address dropped from the ledger is added up again when asked for", async ({ page }) => {
  let state: unknown = KEPT;
  await stubLarge(page, { ledger: () => state });
  await page.goto(`/regtest/address/${LARGE}`);
  await expect(page.getByRole("table", { name: /^Newest confirmed transactions/ })).toBeVisible();
  // The ledger made room for others; asked for again, the server queues it.
  state = { state: "queued", position: 1 };
  await page.reload();
  const adding = page.getByRole("region", { name: "Adding up this address for the first time" });
  await expect(adding).toContainText("Next in line.");
  state = KEPT;
  await expect(page.getByRole("table", { name: /^Newest confirmed transactions/ })).toBeVisible({
    timeout: LEDGER_POLL_MS + 3000,
  });
});

test("a long list shows a page at a time, and says when older ones are still to come", async ({
  page,
}) => {
  const txs = Array.from({ length: 30 }, (_, i) => ({
    ...KEPT.txs[0],
    position: 100 - i,
  }));
  await stubLarge(page, { ledger: () => ({ ...KEPT, txs, filling: true }) });
  await page.goto(`/regtest/address/${LARGE}`);
  const table = page.getByRole("table", { name: /^Newest confirmed transactions/ });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await expect(
    page.getByText(/Those from before block 105, .* are added once its node has listed them/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show 5 more" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(30);
  await expect(page.getByRole("button", { name: /^Show \d+ more$/ })).toHaveCount(0);
});

test("the unspent view of a kept address asks for nothing the server refuses", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (/\/(utxo|txs)(\?|$)/.test(r.url())) asked.push(r.url());
  });
  await stubLarge(page, { ledger: () => KEPT });
  await page.goto(`/regtest/address/${LARGE}?view=unspent`);
  await expect(page.getByRole("table", { name: /^Newest confirmed transactions/ })).toBeVisible();
  await page.waitForTimeout(500);
  expect(asked).toStrictEqual([]);
});

test("totals that settle slowly ask the ledger again", async ({ page }) => {
  // The totals take two seconds; only then has the server learned the address is large.
  let settled = false;
  await stubLarge(page, {
    ledger: () => (settled ? { state: "queued", position: 1 } : { state: "none" }),
  });
  await page.route(new RegExp(`/regtest/api/address/${LARGE}$`), async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
    settled = true;
    await route.fulfill({
      status: 503,
      json: { error: "address history too large for this server" },
    });
  });
  await page.goto(`/regtest/address/${LARGE}`);
  await expect(
    page.getByRole("region", { name: "Adding up this address for the first time" }),
  ).toBeVisible({ timeout: 6000 });
});

test("a failed seed is asked about again, so the server can try it again", async ({ page }) => {
  await page.clock.install();
  let state: unknown = { state: "failed" };
  let asks = 0;
  await stubLarge(page, {
    ledger: () => {
      asks += 1;
      return state;
    },
  });
  await page.goto(`/regtest/address/${LARGE}`);
  await expect(page.getByText("Adding this address up failed this time")).toBeVisible();
  const before = asks;
  state = { state: "queued", position: 1 };
  await page.clock.fastForward(FAILED_POLL_MS + LEDGER_POLL_MS);
  await expect(
    page.getByRole("region", { name: "Adding up this address for the first time" }),
  ).toBeVisible();
  expect(asks).toBeGreaterThan(before);
});
