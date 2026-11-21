// The privacy check (docs/FRONTEND.md "Privacy check") on the scenario's chain: findings and a
// partly checked transaction on the transaction page, and on Broadcast and the decoder a
// transaction built here and never sent. A clean transaction (every scenario transaction pays its
// change back to the miner's address), a CoinJoin and real partial data from the check route's
// lookup limit need the chain changed: privacy.mine.e2e.ts.
import type { Page, Request } from "@playwright/test";
import { axe } from "./axe";
import { chain, expect, test } from "./fixtures";
import { MINER_SCRIPT, spending } from "./regtest";

/** The scenario's P2WPKH address as a script. */
const P2WPKH = "00147503ccb2c772094595aa0491a48c29de61c04e61";

/** The page is never wider than its window. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Records, from before the page's own scripts run, where the flow and the details panel stood
 * when the first card appeared, and whether the privacy section was already there. */
async function watchArrival(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { arrival?: unknown };
    const seen = new MutationObserver(() => {
      if (
        w.arrival !== undefined ||
        !document.querySelector(".tx-flow__item:not(.tx-flow__item--ghost)")
      )
        return;
      const top = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? null;
      const flow = top(".tx-main__flow");
      const pv = top(".pv-under");
      w.arrival = { privacy: pv !== null, within: pv === null || flow === null ? null : pv - flow };
      seen.disconnect();
    });
    seen.observe(document, { childList: true, subtree: true });
  });
}

const arrival = (page: Page) =>
  page.evaluate(() => (window as unknown as { arrival?: unknown }).arrival);
/** Where the privacy section sits within the flow's panel now. */
const within = (page: Page) =>
  page.evaluate(() => {
    const top = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? 0;
    return top(".pv-under") - top(".tx-main__flow");
  });

test("a transaction with findings: marks on its cards and what an observer can read", async ({
  page,
}) => {
  await watchArrival(page);
  await page.goto(`/regtest/tx/${chain.txs.consolidation}`);
  const section = page.getByRole("region", { name: "What an observer can read" });
  await expect(section).toBeVisible();
  // Coinbases 2 and 3, both at the miner's address, to 90 BTC and change back to that address.
  await expect(section.getByText("Address reused", { exact: true })).toBeVisible();
  // The address shortened as the site shortens one: its first and last eight characters.
  const miner = `${chain.addresses.miner.slice(0, 8)}…${chain.addresses.miner.slice(-8)}`;
  await expect(section).toContainText(
    `Inputs 0 and 1 spend from ${miner}, and output 1 pays the same address.`,
  );
  await expect(
    section.getByText("Output 1 reads as change, output 0 as the payment", { exact: true }),
  ).toBeVisible();
  await expect(section.getByRole("listitem")).toHaveText([
    /^Address reused/,
    /^Output 1 reads as change/,
    "It pays back to the address inputs 0 and 1 spend from, so it goes to whoever controls those inputs.",
    "Output 0 is a round 90 BTC and this one is not, which suggests output 0 is the payment.",
    "It is the only output of the inputs' type, P2WSH, which suggests it goes back to the same wallet.",
  ]);

  // The cards say the same, in words.
  const inputs = page.getByRole("list", { name: "Inputs" });
  const outputs = page.getByRole("list", { name: "Outputs" });
  await expect(inputs.getByText("Reused address")).toHaveCount(2);
  await expect(outputs.getByRole("listitem").nth(0)).toContainText("Reads as payment");
  await expect(outputs.getByRole("listitem").nth(1)).toContainText("Reused address");
  await expect(outputs.getByRole("listitem").nth(1)).toContainText("Reads as change");

  // It came with the first card, in the place it keeps: it never appears later to move anything.
  const first = (await arrival(page)) as { privacy: boolean; within: number };
  expect(first.privacy).toBe(true);
  await page.waitForTimeout(500);
  expect(await within(page)).toBe(first.within);

  // What it checks, from the keyboard.
  const checks = section.getByText("What this checks");
  await checks.focus();
  await page.keyboard.press("Enter");
  await expect(
    section.getByText(
      "It does not look at earlier transactions, so an address used before this one is not noticed.",
    ),
  ).toBeVisible();
  expect(await axe(page)).toStrictEqual([]);

  await page.setViewportSize({ width: 360, height: 780 });
  await expect(section).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(await axe(page)).toStrictEqual([]);
});

test("a transaction whose input the node does not have is only partly checked", async ({
  page,
  request,
}) => {
  // The node gives every confirmed input's coin, so the answer is the node's own with one taken
  // away, as a pruned parent would leave it.
  const real = (await (await request.get(`/regtest/api/tx/${chain.txs.payment}`)).json()) as {
    vin: { prevout: unknown }[];
  };
  for (const i of real.vin) i.prevout = null;
  await page.route(new RegExp(`/regtest/api/tx/${chain.txs.payment}$`), (r) =>
    r.fulfill({ json: real }),
  );
  await page.goto(`/regtest/tx/${chain.txs.payment}`);
  const region = page.locator(".pv-under");
  await expect(
    region.getByText(
      "What input 0 spends is not known here, so only part of this transaction could be checked.",
    ),
  ).toBeVisible();
  await expect(region).not.toContainText("stands out");
  await expect(region).toContainText(
    "Not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the smallest coin spent.",
  );
  await expect(region).toContainText(
    "What it shows about address reuse and which output is change may be incomplete.",
  );
  expect(await axe(page)).toStrictEqual([]);
});

/** Coinbase 12, never spent before the tests that mine: 1 BTC to the P2WPKH address, change back
 * to the miner's address. Built here, never sent. */
async function unsent(request: { get: (u: string) => Promise<{ text: () => Promise<string> }> }) {
  const hash = (await (await request.get("/regtest/api/block-height/12")).text()).trim();
  const coinbase = (await (await request.get(`/regtest/api/block/${hash}/txid/0`)).text()).trim();
  return spending(coinbase, [
    [P2WPKH, 100_000_000n],
    [MINER_SCRIPT, 5_000_000_000n - 100_000_000n - 2_000n],
  ]);
}

/** The findings before sending, as Broadcast and the decoder show them. */
async function unsentFindings(page: Page) {
  const notice = page.getByRole("region", {
    name: "Once it is sent, anyone can read this from it",
  });
  await expect(notice).toBeVisible();
  await expect(notice.getByText("Address reused", { exact: true })).toBeVisible();
  await expect(
    notice.getByText("Output 1 reads as change, output 0 as the payment", { exact: true }),
  ).toBeVisible();
  await expect(
    notice.getByText(
      "It is not sent yet: a wallet can still change which coins it spends and where the change goes.",
    ),
  ).toBeVisible();
  const outputs = page.getByRole("list", { name: "Outputs" });
  await expect(outputs.getByRole("listitem").nth(1)).toContainText("Reads as change");
  await expect(outputs.getByRole("listitem").nth(0)).toContainText("Reads as payment");
}

test.describe("before sending", () => {
  // The next block's rate may be refused while the server's fee level settles on regtest.
  test.use({ consoleErrorsAllowed: [/status of 503/] });

  test("Broadcast says what sending would show, and its button is unchanged", async ({
    page,
    request,
  }) => {
    const hex = await unsent(request);
    const posts: string[] = [];
    page.on("request", (r: Request) => {
      if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
    });
    await page.goto("/regtest/tx/push");
    await page.getByRole("textbox", { name: "Signed transaction in hex" }).fill(hex);
    await unsentFindings(page);
    await expect(page.getByRole("button", { name: "Broadcast" })).toHaveClass(/btn--accent/);
    // Read, never sent.
    expect(posts).toStrictEqual(["/regtest/app/tx/check"]);
    expect(await axe(page)).toStrictEqual([]);
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test("the decoder says the same for pasted hex", async ({ page, request }) => {
    const hex = await unsent(request);
    await page.goto(`/decode#${hex}`);
    await unsentFindings(page);
    expect(await axe(page)).toStrictEqual([]);
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});
