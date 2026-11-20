// The head the server writes into the shell for a link preview (docs/FRONTEND.md "Link previews")
// must name each page as the page names itself once loaded: this keeps the server's wording
// (crates/server/src/pages.rs) and the pages' `usePageTitle` calls from drifting apart.
import type { APIRequestContext } from "@playwright/test";
import { chain, expect, test } from "./fixtures";

// Block pages ask for fee facts that other tests may be using the client's allowance for.
test.use({ consoleErrorsAllowed: [/status of (429|503)/] });

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** The `<title>` the server sends for `path`, as a fetcher that runs no script reads it. */
async function served(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.get(path);
  expect(res.status()).toBe(200);
  const title = /<title>([^<]*)<\/title>/.exec(await res.text())?.[1] ?? "";
  return title.replaceAll(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e);
}

// Every page whose title the frontend sets in every state on regtest. Lightning node pages are
// left out: Lightning is off on regtest, and a page behind the switched-off notice sets no title.
const PAGES = [
  "/regtest/",
  "/regtest/block/106",
  `/regtest/block/${chain.blocks[1]}`,
  "/regtest/block/next",
  "/regtest/block/next/3",
  "/regtest/block/next/8",
  "/regtest/blocks",
  "/regtest/blocks/50",
  `/regtest/tx/${chain.txs.payment}`,
  `/regtest/address/${chain.addresses.p2wpkh}`,
  `/regtest/address/${chain.addresses.p2pkh}`,
  "/regtest/mining",
  "/regtest/mempool",
  "/regtest/rbf",
  "/regtest/fees/score",
  "/regtest/lightning",
  "/regtest/lightning/channel/1x2x3",
  "/regtest/lightning/search",
  "/regtest/lightning/rankings?by=age",
  "/regtest/lightning/rankings?%62y=%61ge",
  "/regtest/lightning/rankings?by&by=age",
  "/regtest/ark",
  `/regtest/ark/vtxo/${"ab".repeat(32)}:0`,
  `/regtest/ark/bark/vtxo/${"ab".repeat(32)}:0`,
  "/regtest/ark/bark/hex",
  `/regtest/ark/arkade/vtxo/${"ab".repeat(32)}:0`,
];

for (const path of PAGES) {
  test(`the server's title for ${path} is the one the page sets`, async ({ page, request }) => {
    // A block by hash is named by its height once the block table has it; the run's backfill
    // fills the table within seconds of the server starting.
    const want = await (async () => {
      if (!path.includes(chain.blocks[1])) return served(request, path);
      await expect.poll(() => served(request, path)).toBe("Regtest: Block 1 | rbitcoin.space");
      return served(request, path);
    })();
    expect(want).toMatch(/^Regtest: .+ \| rbitcoin\.space$/);
    // Blank the served title as it is parsed, so only the page itself can bring it back. (A
    // route that rewrote the document would cost it its WebSocket: Chromium blocks a socket to a
    // local address from a document Playwright fulfilled.)
    await page.addInitScript(() => {
      const seen = new MutationObserver(() => {
        const title = document.querySelector("title");
        if (!title) return;
        title.textContent = "unset";
        seen.disconnect();
      });
      seen.observe(document, { childList: true, subtree: true });
    });
    await page.goto(path);
    await expect(page).toHaveTitle(want);
  });
}

test("a title already in the head is replaced as the reader moves between pages", async ({
  page,
}) => {
  await page.goto("/regtest/block/106");
  await expect(page).toHaveTitle("Regtest: Block 106 | rbitcoin.space");
  await page.getByRole("link", { name: /^Next: 107/ }).click();
  await expect(page).toHaveTitle("Regtest: Block 107 | rbitcoin.space");
  await page.getByRole("navigation").getByRole("link", { name: "Mining" }).click();
  await expect(page).toHaveTitle("Regtest: Mining | rbitcoin.space");
  await page.goBack();
  await expect(page).toHaveTitle("Regtest: Block 107 | rbitcoin.space");
});
