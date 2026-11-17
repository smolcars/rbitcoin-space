// The decoder (docs/API.md "Decoding"): every kind from the server's recorded answers, its typed
// failures, search on two networks landing on the one page, the keyboard, and the layout at every
// width and text size with hostile text. The server is stubbed for `POST /app/decode` only: a raw
// transaction is checked by the run's regtest node.
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { MINER_SCRIPT, spending } from "./regtest";
import { allAnswers, ANSWERS, serveDecode } from "./decode-answers";
import { frames } from "./layout";
import { pageFaults } from "./lightning-answers";

const HEADINGS: Record<string, string> = {
  bolt11: "Lightning invoice",
  bolt11_plain: "Lightning invoice",
  offer: "Lightning offer",
  offer_currency: "Lightning offer",
  lnurl: "LNURL",
  lnurl_withdraw: "LNURL withdraw",
  lightning_address: "Lightning address",
  arkade: "Arkade address",
  bark: "Bark address",
  "a long invoice": "Lightning invoice",
  "a long offer": "Lightning offer",
  "a long LNURL": "LNURL login",
  "a long address": "Lightning address",
};

/** Decodes `text` from the box, as a reader would, and waits for the result. */
async function decode(page: Page, text: string, heading: string) {
  const box = page.getByRole("textbox", { name: "Transaction, invoice, offer, LNURL or address" });
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
}

// A test a view, as the other pages' are: one test of both ran past its 30 s on CI's runners.
for (const view of [
  { width: 1280, colorScheme: "light" },
  { width: 390, colorScheme: "dark" },
] as const) {
  test(`the decoder draws every kind at ${view.width} px, ${view.colorScheme}`, async ({
    page,
  }) => {
    let current: Record<string, unknown> = {};
    await serveDecode(page, () => current);
    await page.setViewportSize({ width: view.width, height: 900 });
    await page.emulateMedia({ colorScheme: view.colorScheme });
    await page.goto("/decode");
    await expect(page.getByRole("heading", { level: 1, name: "Decode" })).toBeVisible();
    const faults: string[] = [];
    for (const [name, answer] of Object.entries(allAnswers())) {
      current = answer;
      await decode(page, `case ${name}`, HEADINGS[name] ?? "");
      faults.push(...(await pageFaults(page)).map((f) => `${name}: ${f}`));
    }
    expect(faults).toStrictEqual([]);
    // The pasted string is in the fragment only, never in the path or query.
    const url = new URL(page.url());
    expect(url.pathname).toBe("/decode");
    expect(url.search).toBe("");
    expect(decodeURIComponent(url.hash)).toBe("#case a long address");
  });
}

test("an invoice links what the graph knows on its own network, and a URL is never a link", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/app/decode")) requests.push(`${r.method()} ${r.postData() ?? ""}`);
  });
  await serveDecode(page, () => ANSWERS["bolt11"] ?? {});
  await page.goto(`/decode#${encodeURIComponent("lightning:LNBC20M1EXAMPLE")}`);
  await expect(page.locator(".dec-figure")).toHaveText(/^2.000.000\s*sats$/);
  expect(requests).toStrictEqual(["POST lightning:LNBC20M1EXAMPLE"]);
  await expect(page.getByRole("link", { name: "66051x263430x1800" })).toHaveAttribute(
    "href",
    "/lightning/channel/66051x263430x1800",
  );
  await expect(page.getByRole("link", { name: /Hint <b>one<\/b>/ })).toBeVisible();
  // An unknown hop: text with a copy button.
  await expect(page.getByRole("link", { name: "197637x395016x2314" })).toHaveCount(0);

  await page.unrouteAll();
  await serveDecode(page, () => ANSWERS["lnurl"] ?? {});
  await page.goto(`/decode#LNURL1EXAMPLE`);
  await expect(page.locator(".dec-url__host")).toHaveText("service.com");
  await expect(page.locator("main a[href^='http']")).toHaveCount(0);
});

test.describe("refused", () => {
  // The refusals are the server's answers here, which the browser logs as failed loads.
  test.use({ consoleErrorsAllowed: [/status of (400|413) .*\/app\/decode$/] });
  test("each typed failure is one line", async ({ page }) => {
    let answer: { status: number; error: string } = { status: 400, error: "bad checksum" };
    await serveDecode(page, () => answer);
    await page.goto("/decode");
    const box = page.getByRole("textbox", {
      name: "Transaction, invoice, offer, LNURL or address",
    });
    for (const [status, error, said] of [
      [400, "bad checksum", "The checksum fails: a character is wrong or missing"],
      [400, "bad signature", "The signature does not verify"],
      [400, "not recognised", "Not an invoice, offer, LNURL or address this page reads"],
      [413, "too long", "Too long to be a payment string"],
    ] as const) {
      answer = { status, error };
      await box.fill(`try ${error}`);
      await box.press("Enter");
      await expect(page.getByText(said)).toBeVisible();
    }
  });
});

test("pasting into search on two networks lands on the one decoder", async ({ page }) => {
  await serveDecode(page, () => ANSWERS["lightning_address"] ?? {});
  for (const from of ["/regtest/blocks", "/decode"]) {
    await page.goto(from);
    const search = page.getByRole("combobox", { name: "Search" });
    await search.fill("satoshi@bitcoin.org");
    await expect(page.getByText("Lightning address").first()).toBeVisible();
    await search.press("Enter");
    await expect(page).toHaveURL(/\/decode#satoshi%40bitcoin\.org$/);
    await expect(page.getByRole("heading", { level: 2, name: "Lightning address" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /invoice, offer/ })).toHaveValue(
      "satoshi@bitcoin.org",
    );
  }
});

test("the keyboard reaches the box, decodes with Enter and reaches each copy button", async ({
  page,
}) => {
  await serveDecode(page, () => ANSWERS["arkade"] ?? {});
  await page.goto("/decode");
  const box = page.getByRole("textbox", { name: "Transaction, invoice, offer, LNURL or address" });
  await box.focus();
  await page.keyboard.type("tark1example");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Arkade address" })).toBeVisible();
  await expect(box).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Decode" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Copy the server key" })).toBeFocused();

  // Skipping the header keeps the string in the fragment, and on the page.
  const url = page.url();
  await page.locator("a.skip").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(page.url()).toBe(url);
  await expect(page.getByRole("heading", { level: 2, name: "Arkade address" })).toBeVisible();
});

// Nothing scrolls sideways and no figure parts from its unit, at every width and text size, on a
// touch screen, with the hostile strings: a test a size, each page loaded once and resized.
const SWEEP = process.env["E2E_SWEEP"] === "1";
const WIDTHS = SWEEP ? [320, 390, 768, 1024, 1280, 1440] : [320, 390, 1024];
test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });
  for (const text of [16, 20, 24, 32]) {
    test(`at ${text} px text, every kind holds at every width`, async ({ page, browserName }) => {
      test.skip(
        browserName !== "chromium",
        "only Chromium lets a test set the browser's text size",
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.setFontSizes", {
        fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
      });
      let current: Record<string, unknown> = {};
      await serveDecode(page, () => current);
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto("/decode");
      const faults: string[] = [];
      for (const [name, answer] of Object.entries(allAnswers())) {
        current = answer;
        await page.setViewportSize({ width: 320, height: 800 });
        await decode(page, `case ${name}`, HEADINGS[name] ?? "");
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 800 });
          await frames(page);
          faults.push(...(await pageFaults(page)).map((f) => `${width} px, ${name}: ${f}`));
        }
      }
      expect(faults).toStrictEqual([]);
    });
  }

  // The footer's link to the decoder, from a test network's page: whole, a thumb's target, in the
  // window, at the narrowest width and the largest text.
  test("the footer's decoder link holds at 320 px with 32 px text", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "only Chromium lets a test set the browser's text size");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 26 } });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/regtest/blocks");
    const link = page.locator(".site-footer").getByRole("link", { name: "Decoder" });
    await expect(link).toHaveAttribute("href", "/decode");
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 320).toBe(true);
    // A thumb's target (`.tap`): a tap anywhere 44 px across round its middle reaches it.
    const reached = await link.evaluate((a) => {
      const r = a.getBoundingClientRect();
      const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
      return [
        [0, -21],
        [0, 21],
        [-21, 0],
        [21, 0],
      ].every(([dx = 0, dy = 0]) => document.elementFromPoint(x + dx, y + dy)?.closest("a") === a);
    });
    expect(reached).toBe(true);
    // The footer itself (the blocks page's own content is not this test's): nothing of it past
    // the window, and it does not scroll inside itself.
    const footer = await page.locator(".site-footer").evaluate((f) => ({
      past: [...f.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > 320.5)
        .length,
      scrolls: f.scrollWidth > f.clientWidth,
    }));
    expect(footer).toStrictEqual({ past: 0, scrolls: false });
    await link.click();
    await expect(page).toHaveURL(/\/decode$/);
    await expect(page.getByRole("heading", { level: 1, name: "Decode" })).toBeVisible();
  });
});

test.describe("a raw transaction", () => {
  // The next block's rate may be refused while the server's fee level settles on regtest.
  test.use({ consoleErrorsAllowed: [/status of 503/] });

  test("raw transaction hex is checked on the server's network and handed to the broadcast page", async ({
    page,
    request,
  }) => {
    await page.goto("/decode");
    const result = page.locator(".dec-result");
    // A confirmed one: the node has it, so there is nothing to hand over.
    const raw = await (await request.get(`/regtest/api/tx/${chain.txs.script_types}/hex`)).text();
    await decode(page, raw, "Transaction");
    await expect(result.getByText("Regtest", { exact: true })).toBeVisible();
    await expect(result.getByText("Already confirmed")).toBeVisible();
    await expect(result.getByRole("link", { name: "Broadcast", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Broadcast/ })).toHaveCount(0);

    // One the node has never seen, spending a coin it does not have. Never sent.
    const unsent = spending("ab".repeat(32), [[MINER_SCRIPT, 1000n]]);
    await decode(page, unsent, "Transaction");
    await expect(result.getByText(/coins the Regtest node does not have/)).toBeVisible();
    await expect(result.getByRole("heading", { name: "Inputs and outputs" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/decode#${unsent}$`));
    await result.getByRole("link", { name: "Broadcast", exact: true }).click();
    await expect(page).toHaveURL(/\/regtest\/tx\/push$/);
    await expect(page.getByRole("textbox", { name: "Signed transaction in hex" })).toHaveValue(
      unsent,
    );
    await expect(page.getByRole("button", { name: /^Broadcast/ })).toBeVisible();
  });
});
