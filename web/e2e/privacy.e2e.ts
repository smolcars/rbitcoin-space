// The privacy check (docs/FRONTEND.md "Privacy check") on the scenario's chain: findings and a
// partly checked transaction on the transaction page, and on Broadcast and the decoder a
// transaction built here and never sent. A clean transaction (every scenario transaction pays its
// change back to the miner's address), a CoinJoin and real partial data from the check route's
// lookup limit need the chain changed: privacy.mine.e2e.ts.
import type { Page, Request } from "@playwright/test";
import { axe } from "./axe";
import { chain, expect, test } from "./fixtures";
import { MINER_SCRIPT, spending, spendingMany } from "./regtest";

/** The scenario's P2WPKH address as a script. */
const P2WPKH = "00147503ccb2c772094595aa0491a48c29de61c04e61";

/** The page is never wider than its window. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Records, from before the page's own scripts run, whether the privacy section was already there
 * when the first card appeared. */
async function watchArrival(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { arrival?: boolean };
    const seen = new MutationObserver(() => {
      if (!document.querySelector(".tx-flow__item:not(.tx-flow__item--ghost)")) return;
      w.arrival = document.querySelector(".pv-under") !== null;
      seen.disconnect();
    });
    seen.observe(document, { childList: true, subtree: true });
  });
}

const arrival = (page: Page) =>
  page.evaluate(() => (window as unknown as { arrival?: boolean }).arrival);

/** The flow's panel and each output card, measured now. */
const heights = (page: Page) =>
  page.evaluate(() => ({
    flow: document.querySelector(".tx-main__flow")?.getBoundingClientRect().height ?? 0,
    outputs: [...document.querySelectorAll('ul[aria-label="Outputs"] > li')].map(
      (li) => li.getBoundingClientRect().height,
    ),
  }));

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
    `Inputs 0 and 1 spend from ${miner}, and output 1 pays the same address, so the same locking script. An observer may read one address as one owner, which ties that output to those inputs.`,
  );
  await expect(
    section.getByText("Output 1 reads as change, output 0 as the payment", { exact: true }),
  ).toBeVisible();
  await expect(section.getByRole("listitem")).toHaveText([
    /^Address reused/,
    /^Output 1 reads as change/,
    "It pays the same address inputs 0 and 1 spend from, which an observer may read as going back to the sender.",
    "Output 0 is a round 90 BTC and this one is not, which suggests output 0 is the payment.",
    "Every input that funds it is P2WSH, and of the two outputs checked only this one is, which suggests it is the change.",
  ]);

  // The cards say the same, in words.
  const inputs = page.getByRole("list", { name: "Inputs" });
  const outputs = page.getByRole("list", { name: "Outputs" });
  await expect(inputs.getByText("Reused address")).toHaveCount(2);
  await expect(outputs.getByRole("listitem").nth(0)).toContainText("Reads as payment");
  await expect(outputs.getByRole("listitem").nth(1)).toContainText("Reused address");
  await expect(outputs.getByRole("listitem").nth(1)).toContainText("Reads as change");

  // It came with the first card: it never appears later.
  expect(await arrival(page)).toBe(true);

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

/** Each output card's meta line now: its children's text and line top, to say what wrapped. */
const metaLines = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('ul[aria-label="Outputs"] > li .tx-flow__meta')].map((m) =>
      [...m.children].map(
        (c) =>
          `${(c.textContent ?? "").trim()}@${Math.round(c.getBoundingClientRect().top - m.getBoundingClientRect().top)}`,
      ),
    ),
  );

// CI's prose font is wider than a Mac's: a status that fits beside a card's type there may wrap
// onto a line of its own in it (docs/FRONTEND.md "Other systems' fonts").
test.describe("the spends arriving after the cards, in a wide prose font", () => {
  test.use({ prose: "wide" });
  // `script_types`: its P2SH and pay-to-anchor outputs are spent. Served two ways, each a hard line
  // to hold: the P2SH one with no address and the miner's script, so a spent card with no type
  // label before its link and a mark; and the anchor one paying the miner's address as the only
  // pay-back (the change goes elsewhere), so a spent card with an address and two marks.
  for (const variant of ["no address, a mark", "an address, two marks"] as const) {
    for (const width of [320, 360]) {
      test(`at ${width} px, a spent output with ${variant} moves nothing`, async ({
        page,
        request,
      }) => {
        const real = (await (
          await request.get(`/regtest/api/tx/${chain.txs.script_types}`)
        ).json()) as { vout: Record<string, unknown>[] };
        const at = (type: string) => real.vout.findIndex((o) => o["scriptpubkey_type"] === type);
        const p2sh = at("p2sh");
        const anchor = real.vout.findIndex((o) => o["scriptpubkey"] === "51024e73");
        const change = real.vout.length - 1;
        const spent = variant === "no address, a mark" ? p2sh : anchor;
        const o = real.vout[spent];
        const last = real.vout[change];
        if (o && last) {
          o["scriptpubkey"] = MINER_SCRIPT;
          o["scriptpubkey_type"] = "v0_p2wsh";
          if (variant === "no address, a mark") delete o["scriptpubkey_address"];
          else {
            o["scriptpubkey_address"] = chain.addresses.miner;
            last["scriptpubkey"] = P2WPKH;
            last["scriptpubkey_type"] = "v0_p2wpkh";
            last["scriptpubkey_address"] = chain.addresses.p2wpkh;
          }
        }
        await page.route(new RegExp(`/regtest/api/tx/${chain.txs.script_types}$`), (r) =>
          r.fulfill({ json: real }),
        );
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route(
          new RegExp(`/regtest/api/tx/${chain.txs.script_types}/outspends`),
          async (r) => {
            await held;
            await r.continue();
          },
        );
        await page.setViewportSize({ width, height: 780 });
        await page.goto(`/regtest/tx/${chain.txs.script_types}`);
        await expect(page.locator(".pv-under")).toBeVisible();
        const card = page.getByRole("list", { name: "Outputs" }).getByRole("listitem").nth(spent);
        if (variant === "no address, a mark") {
          await expect(card.getByRole("link")).toHaveCount(0);
          await expect(card.locator(".pv-tag")).toHaveText(["Reused address"]);
        } else {
          await expect(card.locator(".pv-tag")).toHaveText(["Reused address", "Reads as change"]);
        }
        await expect(page.locator(".tx-flow__spent")).toHaveCount(0);
        // The stand-in font loads on its own time: a swap between the two reads would look like a
        // wrap the spends caused.
        await page.evaluate(() => document.fonts.ready);
        const before = await heights(page);
        const linesBefore = await metaLines(page);
        release();
        await expect(page.locator(".tx-flow__spent")).toHaveCount(2);
        await expect(card.locator(".tx-flow__spent")).toHaveCount(1);
        const after = await heights(page);
        expect(
          after,
          `meta lines before ${JSON.stringify(linesBefore)}, after ${JSON.stringify(await metaLines(page))}`,
        ).toStrictEqual(before);
      });
    }
  }
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
  await expect(region.locator(".pv-partial p")).toHaveText([
    "Only part of this transaction could be checked.",
    "What input 0 spends is not known here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one address.",
    "What it shows about address reuse and which output is change may be incomplete.",
  ]);
  await expect(region).not.toContainText("stands out");
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

test.describe("a broadcast that does not go through", () => {
  // Only the browser's own report of the broadcast failing, and the next block's rate, which may be
  // refused while the server's fee level settles on regtest. One pattern: Playwright reads a
  // two-item array here as a value and its options.
  test.use({
    consoleErrorsAllowed: [
      /^Failed to load resource: .+ http:\/\/[^/]+\/regtest\/api\/(tx|v1\/fees\/recommended)$/,
    ],
  });
  const NOT_SENT =
    "It is not sent yet: a wallet can still change which coins it spends and where the change goes.";
  /** The server's own words for the node's refusals (crates/server/src/esplora.rs). */
  const refused = (error: string) => ({ status: 400, json: { error } });

  test("from the first press on it never says not sent: a lost reply, then the node's duplicate", async ({
    page,
    request,
  }) => {
    // Coinbases 12 and 13, both at the miner's address: two inputs, so coins spent together, an
    // unsent-only finding, is there to go.
    const coinbase = async (h: number) => {
      const hash = (await (await request.get(`/regtest/api/block-height/${h}`)).text()).trim();
      return (await (await request.get(`/regtest/api/block/${hash}/txid/0`)).text()).trim();
    };
    const hex = spendingMany(
      [await coinbase(12), await coinbase(13)],
      [
        [P2WPKH, 100_000_000n],
        [MINER_SCRIPT, 10_000_000_000n - 100_000_000n - 3_000n],
      ],
    );
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    await page.route(/\/regtest\/api\/tx$/, async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      posts += 1;
      if (posts === 1) {
        await held;
        return r.abort("connectionfailed");
      }
      // The server's words for the node's duplicate refusal, written out: not the page's own constant.
      return r.fulfill(refused("transaction already in the mempool or chain"));
    });
    await page.goto("/regtest/tx/push");
    await page.getByRole("textbox", { name: "Signed transaction in hex" }).fill(hex);
    const together = page.getByText("Coins spent together", { exact: true });
    await expect(page.getByText(NOT_SENT)).toBeVisible();
    await expect(together).toBeVisible();

    // From here on, the line must never be drawn again.
    await page.evaluate((text) => {
      const w = window as unknown as { sawNotSent?: boolean };
      w.sawNotSent = false;
      new MutationObserver(() => {
        if (document.body.textContent.includes(text)) w.sawNotSent = true;
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, NOT_SENT);
    await page.getByRole("button", { name: "Broadcast" }).click();
    await expect(page.getByText(NOT_SENT)).toHaveCount(0);
    await expect(together).toHaveCount(0);

    release();
    await expect(
      page.getByText("The server cannot be reached. Check your connection."),
    ).toBeVisible();
    // The button's line says what came back; the notice claims nothing either way.
    await expect(page.getByRole("region", { name: "What an observer can read" })).toBeVisible();
    await expect(together).toHaveCount(0);

    // The retry's duplicate refusal, said by the button's line alone.
    await page.getByRole("button", { name: /^Broadcast/ }).click();
    await expect(
      page.getByText("The node refused it: transaction already in the mempool or chain."),
    ).toBeVisible();
    await expect(together).toHaveCount(0);
    expect(posts).toBe(2);
    expect(
      await page.evaluate(() => (window as unknown as { sawNotSent?: boolean }).sawNotSent),
    ).toBe(false);
  });

  test("remade by an edit after a press, it still never says not sent", async ({
    page,
    request,
  }) => {
    const hex = await unsent(request);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/regtest\/api\/tx$/, async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      await held;
      // The view the press came from may be gone, its request aborted with it.
      return r.fulfill(refused("min relay fee")).catch(() => undefined);
    });
    await page.goto("/regtest/tx/push");
    const box = page.getByRole("textbox", { name: "Signed transaction in hex" });
    await box.fill(hex);
    await expect(page.getByText(NOT_SENT)).toBeVisible();
    await page.getByRole("button", { name: "Broadcast" }).click();

    // One character taken away and put back: the result is drawn again, from a new check.
    const edit = async () => {
      await box.fill(hex.slice(0, -1));
      await expect(page.getByRole("heading", { name: "Inputs and outputs" })).toHaveCount(0);
      await box.fill(hex);
      await expect(page.getByRole("heading", { name: "Inputs and outputs" })).toBeVisible();
    };
    await edit();
    await expect(page.getByRole("region", { name: "What an observer can read" })).toBeVisible();
    await expect(page.getByText(NOT_SENT)).toHaveCount(0);

    // The same after a refusal.
    release();
    await edit();
    await page.getByRole("button", { name: "Broadcast" }).click();
    await expect(page.getByText("The node refused it: min relay fee.")).toBeVisible();
    await edit();
    await expect(page.getByRole("region", { name: "What an observer can read" })).toBeVisible();
    await expect(page.getByText(NOT_SENT)).toHaveCount(0);
  });
});
