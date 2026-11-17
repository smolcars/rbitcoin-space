// Mines on the run's node, so it runs after every other test (the `mines` project).
// The two orderings that left the address page stale (docs/FRONTEND.md "Following live data"),
// built on purpose for every other page that follows a live event with a request:
//   1. the event lands between the page's first answer and its subscription taking effect;
//   2. the request the event prompts is answered from the browser's cache, from before the event.
// Each test makes its own transactions and confirms them in blocks that hold nothing else: later
// tests count on the scenario's mempool.
import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import { chain, expect, PROJECTION_LAG_MS, test } from "./fixtures";
import { block, coinbase, freshAddress, gate, keep, MINER_SCRIPT, pay, spending } from "./regtest";

const MINER = chain.addresses.miner;

test.beforeEach(async ({ mine }) => {
  // The fixture waits for the server to sit on the node's tip.
  await mine(0);
});

/** Holds the page's socket until the gate opens: the page loads over HTTP with nothing live. */
async function holdSocket(page: Page) {
  const g = gate();
  await page.routeWebSocket(/\/app\/ws$/, async (ws) => {
    await g.shut;
    ws.connectToServer();
  });
  return g;
}

/** Waits until the server's blocks topic and tip routes are on `hash`. */
async function serverOn(request: APIRequestContext, hash: string) {
  await expect
    .poll(async () => (await request.get("/regtest/api/blocks/tip/hash")).text(), {
      timeout: PROJECTION_LAG_MS,
    })
    .toBe(hash);
}

/** Waits until the server's mempool engine no longer holds `txid`. */
async function leftMempool(request: APIRequestContext, txid: string) {
  await expect
    .poll(async () => (await request.get(`/regtest/app/tx/${txid}/relatives`)).status(), {
      timeout: PROJECTION_LAG_MS,
    })
    .toBe(404);
}

/** Waits until the server's mempool engine holds `txid`, so a replacement is seen replacing it. */
async function seen(request: APIRequestContext, txid: string) {
  await expect
    .poll(
      async () =>
        (
          (await (
            await request.get(`/regtest/api/v1/transaction-times?txId[]=${txid}`)
          ).json()) as number[]
        )[0] ?? 0,
      { timeout: PROJECTION_LAG_MS },
    )
    .toBeGreaterThan(0);
}

const badge = (page: Page) => page.locator(".tx-head .tx-status");

test.describe("transaction page", () => {
  test("a transaction confirmed before the page follows it shows confirmed", async ({
    page,
    rpc,
    request,
  }) => {
    const txid = await pay(rpc, freshAddress(), 50_000n);
    const g = await holdSocket(page);
    await page.goto(`/regtest/tx/${txid}`);
    await expect(badge(page)).toHaveText("Unconfirmed");
    await block(rpc, MINER, [txid]);
    // Left before anyone followed it: the topic's first word is `unknown`.
    await leftMempool(request, txid);
    g.open();
    await expect(badge(page)).toHaveText("Confirmed");
  });

  test("a confirmation shows when the browser holds a status from before it", async ({
    page,
    rpc,
  }) => {
    const txid = await pay(rpc, freshAddress(), 50_000n);
    await page.goto(`/regtest/tx/${txid}`);
    await expect(page.getByRole("link", { name: "Next block", exact: true }).first()).toBeVisible({
      timeout: PROJECTION_LAG_MS,
    });
    await keep(page, `/regtest/api/tx/${txid}/status`);
    await block(rpc, MINER, [txid]);
    await expect(badge(page)).toHaveText("Confirmed");
  });

  test("a replacement made before the page follows it shows", async ({ page, rpc, request }) => {
    const coin = await coinbase(rpc);
    const send = (fee: bigint) =>
      rpc<string>("sendrawtransaction", [spending(coin.txid, [[MINER_SCRIPT, coin.sats - fee]])]);
    const first = await send(1_000n);
    await seen(request, first);
    const g = await holdSocket(page);
    await page.goto(`/regtest/tx/${first}`);
    await expect(badge(page)).toHaveText("Unconfirmed");
    const second = await send(5_000n);
    await leftMempool(request, first);
    g.open();
    await expect(badge(page)).toHaveText("Replaced");
    await block(rpc, MINER, [second]);
  });
});

test.describe("block page", () => {
  const next = (page: Page) => page.getByRole("link", { name: /^Next:/ });

  test("the newest block learns of the next one found before it follows", async ({
    page,
    rpc,
    request,
  }) => {
    const tip = await rpc<string>("getbestblockhash");
    const g = await holdSocket(page);
    await page.goto(`/regtest/block/${tip}`);
    await expect(page.getByText("The newest block")).toBeVisible();
    await serverOn(request, await block(rpc, MINER));
    g.open();
    await expect(next(page)).toBeVisible();
  });

  test("the newest block learns of the next one when the browser holds its status from before", async ({
    page,
    rpc,
  }) => {
    const tip = await rpc<string>("getbestblockhash");
    await page.goto(`/regtest/block/${tip}`);
    await expect(page.getByText("The newest block")).toBeVisible();
    await keep(page, `/regtest/api/block/${tip}/status`);
    await block(rpc, MINER);
    await expect(next(page)).toBeVisible();
  });
});

test.describe("home page's block strip", () => {
  const newest = (page: Page) =>
    page.locator(".home-strip__lane > li[data-id]:not(.home-tile--leaving)").first();

  test("a block found before the page follows shows", async ({ page, rpc, request }) => {
    const tip = await rpc<string>("getbestblockhash");
    const g = await holdSocket(page);
    await page.goto("/regtest/");
    await expect(newest(page)).toHaveAttribute("data-id", tip);
    const found = await block(rpc, MINER);
    await serverOn(request, found);
    g.open();
    await expect(newest(page)).toHaveAttribute("data-id", found);
  });

  // While the socket is down the fee panel asks over HTTP, before the server has an answer.
  test.use({ consoleErrorsAllowed: [/status of 503/] });

  test("a block found while the socket reconnects shows when the browser holds the list from before", async ({
    page,
    rpc,
    request,
  }) => {
    const g = gate();
    let first: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/app\/ws$/, async (ws) => {
      if (first === undefined) first = ws;
      else await g.shut;
      ws.connectToServer();
    });
    const tip = await rpc<string>("getbestblockhash");
    await page.goto("/regtest/");
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(newest(page)).toHaveAttribute("data-id", tip);
    await first?.close({ code: 1012 });
    await keep(page, "/regtest/api/blocks");
    const found = await block(rpc, MINER);
    await serverOn(request, found);
    g.open();
    await expect(newest(page)).toHaveAttribute("data-id", found);
  });
});

test.describe("replacements", () => {
  /** Two versions of one payment: the second replaces the first once the server has seen it. */
  async function versions(rpc: Parameters<typeof pay>[0], request: APIRequestContext) {
    const coin = await coinbase(rpc);
    const send = (fee: bigint) =>
      rpc<string>("sendrawtransaction", [spending(coin.txid, [[MINER_SCRIPT, coin.sats - fee]])]);
    await seen(request, await send(1_000n));
    return () => send(5_000n);
  }
  const story = (page: Page, txid: string) => page.locator(`[data-story="${txid}"]`);
  /** The list as the page last asked for it: its stories, or none yet. */
  const asked = (page: Page) =>
    page.locator("[data-story]").or(page.getByText("No replacements yet")).first();

  test("a replacement made before the page follows shows", async ({ page, rpc, request }) => {
    const replace = await versions(rpc, request);
    const g = await holdSocket(page);
    await page.goto("/regtest/rbf");
    // With no word from the topic the page asks anyway, after a few seconds.
    await expect(asked(page)).toBeVisible({ timeout: PROJECTION_LAG_MS });
    const b = await replace();
    await expect
      .poll(async () => (await request.get("/regtest/api/v1/replacements")).text(), {
        timeout: PROJECTION_LAG_MS,
      })
      .toContain(b);
    g.open();
    await expect(story(page, b)).toBeVisible();
    await block(rpc, MINER, [b]);
  });

  test("a replacement shows when the browser holds the list from before it", async ({
    page,
    rpc,
    request,
  }) => {
    const replace = await versions(rpc, request);
    await page.goto("/regtest/rbf");
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(asked(page)).toBeVisible();
    await keep(page, "/regtest/api/v1/replacements");
    const b = await replace();
    await expect(story(page, b)).toBeVisible({ timeout: PROJECTION_LAG_MS });
    await block(rpc, MINER, [b]);
  });
});
