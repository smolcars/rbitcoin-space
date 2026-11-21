// The address page as of a block while the chain moves on (docs/FRONTEND.md "An address as of a
// block"). Mines on the run's node, so it runs after every other test (the `mines` project).
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { block, freshAddress, pay } from "./regtest";

// The read that meets a block no longer on the best chain is answered 404, on purpose.
test.use({ consoleErrorsAllowed: [/status of 404/] });

const balance = (page: Page) =>
  page
    .locator(".address-stat", { has: page.getByText("Balance", { exact: true }) })
    .locator("dd .amount")
    .first();
const rows = (page: Page) => page.getByRole("table").locator("tbody tr");

test("the balance at block N and N + 1 differ by the payment between them, and a block mined while pinned changes nothing", async ({
  page,
  rpc,
  mine,
}) => {
  const address = freshAddress();
  const miner = freshAddress();
  await mine(0);
  const n = (await rpc<number>("getblockcount")) + 1;
  await block(rpc, miner, [await pay(rpc, address, 30_000_000n)]);
  await mine(0);
  await block(rpc, miner, [await pay(rpc, address, 12_345_678n)]);
  await mine(0);

  await page.goto(`/regtest/address/${address}?at=${n}`);
  await expect(balance(page)).toHaveText("0.30 000 000 BTC");
  await expect(rows(page)).toHaveCount(1);
  await page.goto(`/regtest/address/${address}?at=${n + 1}`);
  await expect(balance(page)).toHaveText("0.42 345 678 BTC");
  await expect(balance(page)).toHaveAttribute("title", /^42\s345\s678 sats$/);
  await expect(rows(page)).toHaveCount(2);
  await page.goto(`/regtest/address/${address}?at=${n - 1}`);
  await expect(page.getByText(`Not used yet at block ${n - 1}`)).toBeVisible();

  // Pinned at N + 1: a payment waits, then a block takes it, and the page does not move.
  await page.goto(`/regtest/address/${address}?at=${n + 1}`);
  await expect(balance(page)).toHaveText("0.42 345 678 BTC");
  // Its one look at the address now, for the line under the balance, is in.
  await expect(page.getByText("The same now: no transaction since")).toBeVisible();
  const asked: string[] = [];
  page.on("request", (r) => asked.push(r.url()));
  const waiting = await pay(rpc, address, 5_000_000n);
  await mine(0);
  await block(rpc, miner, [waiting]);
  await mine(0);
  await page.waitForTimeout(3000);
  await expect(balance(page)).toHaveText("0.42 345 678 BTC");
  await expect(rows(page)).toHaveCount(2);
  // Every read it made meanwhile (the chart's, as it came into view) was pinned to the block.
  const unpinned = asked.filter((u) => u.includes(`/address/${address}`) && !u.includes("asof="));
  expect(unpinned).toStrictEqual([]);
  // Now, the page counts the third payment.
  await page.getByRole("button", { name: "Back to now" }).click();
  await expect(balance(page)).toHaveText("0.47 345 678 BTC");
});

test("a pinned block that a reorganization replaces is said, and the height is looked up again", async ({
  page,
  rpc,
  mine,
}) => {
  const address = freshAddress();
  const miner = freshAddress();
  await mine(0);
  const payment = await pay(rpc, address, 20_000_000n);
  await block(rpc, miner, [payment]);
  await mine(0);
  const height = await rpc<number>("getblockcount");
  const old = await rpc<string>("getblockhash", [height]);
  await page.goto(`/regtest/address/${address}?at=${height}`);
  await expect(balance(page)).toHaveText("0.20 000 000 BTC");
  // Every read the page makes by itself is in (the chart's last), so the tab below is the one
  // pinned read after the reorganization.
  await expect(
    page.getByRole("slider", { name: "Confirmed balance after each block" }),
  ).toBeVisible();

  // The block is replaced by one that does not hold the payment, and the chain grows past it.
  // `invalidateblock` answers null, which the helper takes for a failure: the tip says.
  await rpc("invalidateblock", [old]).catch(() => undefined);
  try {
    expect(await rpc<number>("getblockcount")).toBe(height - 1);
    await block(rpc, miner);
    await block(rpc, miner);
    await mine(0);
    // The next pinned read meets the hash the page holds, no longer on the best chain.
    await page.getByRole("tab", { name: "Unspent outputs" }).click();
    await expect(page.getByText(`Block ${height} is no longer on the best chain`)).toBeVisible();
    await page.getByRole("button", { name: `Show block ${height} as it is now` }).click();
    const now = await rpc<string>("getblockhash", [height]);
    expect(now).not.toBe(old);
    await expect(page.getByRole("link", { name: String(height) }).first()).toHaveAttribute(
      "href",
      `/regtest/block/${now}`,
    );
    // The payment went back to the mempool: at the new block the address had not been used.
    await expect(page.getByText(`Not used yet at block ${height}`)).toBeVisible();
  } finally {
    // The old branch is shorter, so it stays aside; the payment it held is mined again, leaving
    // the mempool as the tests after this one expect it.
    await rpc("reconsiderblock", [old]).catch(() => undefined);
    if ((await rpc<number>("getblockcount")) < height + 2) {
      await block(rpc, miner);
      await block(rpc, miner);
    }
    const waiting = await rpc<string[]>("getrawmempool");
    if (waiting.includes(payment)) await block(rpc, miner, [payment]);
    await mine(0);
  }
});
