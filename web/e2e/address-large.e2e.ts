// An address above the node's cap: what the node says about it, and its unconfirmed transactions
// kept current without the live signal the node refuses (docs/API.md, "Very large addresses").
import { chain, expect, test } from "./fixtures";
import { LARGE, stubLarge } from "./large-address";
import { POLL_MS } from "../src/pages/address/poll";

// The stubbed refusal of the totals, and a size the server does not know.
test.use({ consoleErrorsAllowed: [/status of (404|429|502|503)/] });

test("leads with the node's count and cap, then says what is not shown", async ({ page }) => {
  await stubLarge(page);
  await page.goto(`/regtest/address/${LARGE}`);
  const facts = page.getByRole("region", { name: "What is known" });
  await expect(facts.getByText(/^3\s665\s660$/)).toBeVisible();
  await expect(facts.getByText(/^10\s000$/)).toBeVisible();
  // The node counts transactions that paid the address, not outputs.
  await expect(facts.getByText("transactions paid to it, as counted by the node")).toBeVisible();
  await expect(facts.getByText("2 transactions")).toBeVisible();
  await expect(facts).toContainText(/addresses paid by at most 10\s000 transactions/);
  const pool = page.getByRole("table", { name: /^Unconfirmed transactions of this address/ });
  await expect(pool.getByRole("link", { name: /^0def111d/ })).toBeVisible();
  await expect(page.getByText("another explorer")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  // The keyboard reaches the copy button and each transaction.
  await pool.getByRole("link").first().focus();
  await expect(pool.getByRole("link").first()).toBeFocused();
});

test("a new unconfirmed transaction appears without a reload", async ({ page }) => {
  let txids: string[] = [chain.txs.payment];
  let asks = 0;
  page.on("request", (r) => {
    if (r.url().endsWith(`/address/${LARGE}/txs/mempool`)) asks += 1;
  });
  // The page's clock stands still but when the test moves it, a poll at a time, instead of
  // waiting out real polls.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await stubLarge(page, { mempool: () => txids });
  await page.goto(`/regtest/address/${LARGE}`);
  const pool = page.getByRole("table", { name: /^Unconfirmed transactions of this address/ });
  await expect(pool.getByRole("link", { name: /^0def111d/ })).toBeVisible();
  const first = asks;
  txids = [chain.txs.cpfp_child, chain.txs.payment];
  await page.clock.runFor(POLL_MS);
  await expect(pool.getByRole("link", { name: /^ad853f87/ })).toBeVisible();
  await expect(pool.locator("tbody tr").first()).toContainText("ad853f87");
  // It confirmed: it leaves the list, and the page says nothing is waiting.
  txids = [];
  await page.clock.runFor(POLL_MS);
  await expect(page.getByText("Nothing waiting to confirm")).toBeVisible();
  // One ask a poll, no faster.
  expect(asks - first).toBe(2);
});

test("without the node's count, it says what it can and leaves no bar waiting", async ({
  page,
}) => {
  await stubLarge(page, { size: null, mempool: () => [] });
  await page.goto(`/regtest/address/${LARGE}`);
  await expect(page.getByText("Nothing waiting to confirm")).toBeVisible();
  await expect(page.getByText("It has more history than this server's node adds up")).toBeVisible();
  await expect(page.locator(".skeleton")).toHaveCount(0);
});

test("a failed check says so and keeps the list, then recovers by itself", async ({ page }) => {
  let fail = false;
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await stubLarge(page, { mempool: () => [chain.txs.payment] });
  await page.route(new RegExp(`/regtest/api/address/${LARGE}/txs/mempool$`), (route) =>
    fail
      ? route.fulfill({ status: 502, json: { error: "upstream unavailable" } })
      : route.fallback(),
  );
  await page.goto(`/regtest/address/${LARGE}`);
  const pool = page.getByRole("table", { name: /^Unconfirmed transactions of this address/ });
  await expect(pool.getByRole("link", { name: /^0def111d/ })).toBeVisible();
  fail = true;
  await page.clock.runFor(POLL_MS);
  await expect(page.getByText("The last check failed")).toBeVisible();
  await expect(pool.getByRole("link", { name: /^0def111d/ })).toBeVisible();
  fail = false;
  await page.clock.runFor(POLL_MS);
  await expect(page.getByText("The last check failed")).toHaveCount(0);
});
