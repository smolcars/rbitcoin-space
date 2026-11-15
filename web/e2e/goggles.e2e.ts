// The goggles on the block page's map: the result line against the server's own flags for the
// block, and the pick kept from one block to the next.
import type { APIRequestContext } from "@playwright/test";
import { chain, expect, test } from "./fixtures";

test.use({ consoleErrorsAllowed: [/status of (429|503)/] });

// Coinbase, script_types (which pays to Taproot) and consolidation (dev/regtest/regtest.py).
const HASH = chain.blocks[106] ?? "";
const TAPROOT = 14;

const share = (part: number, whole: number) => {
  const s = part / whole;
  return s < 0.0995 ? `${(s * 100).toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(s * 100)}%`;
};

/** The result line for Taproot in a block, from the server's flags for it. */
async function expected(request: APIRequestContext, hash: string): Promise<string> {
  const rows = (await (await request.get(`/regtest/api/v1/block/${hash}/summary`)).json()) as {
    vsize: number;
    flags: number;
  }[];
  const lit = rows.filter((r) => Math.floor(r.flags / 2 ** TAPROOT) % 2 === 1);
  const total = rows.reduce((s, r) => s + r.vsize, 0);
  const size = lit.reduce((s, r) => s + r.vsize, 0);
  const n = String(rows.length);
  return lit.length === 0
    ? `None of ${n}`
    : `${String(lit.length)} of ${n} · ${share(size, total)} of the block`;
}

test("picking a kind lights what the server's flags say, and says how much", async ({
  page,
  request,
}) => {
  const want = await expected(request, HASH);
  expect(want).toMatch(/^[12] of 3 · /);

  await page.goto(`/regtest/block/${HASH}`);
  await expect(page.locator(".block-core--grid")).toBeVisible();
  const toggle = page.getByRole("button", { name: "Highlight", exact: true });
  // From the keyboard: it opens on its first kind.
  await toggle.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Highlight transactions by kind" });
  await expect(panel).toBeVisible();
  const taproot = panel.getByRole("button", { name: /^Taproot/ });
  await expect(taproot).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(taproot).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".gg__result")).toHaveText(want);
  await expect(page.getByRole("status").filter({ hasText: want })).toHaveCount(1);
  await expect(page.getByRole("img", { name: /Highlighted: Taproot\./ })).toBeVisible();
  // A kind the block does not hold cannot be picked.
  const none = panel.getByRole("button", { name: /^Inscription/ });
  await expect(none).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();

  // Another block keeps the pick, its own figures beside it.
  const next = chain.blocks[1];
  await page.goto(`/regtest/block/${next}`);
  await expect(page.getByRole("button", { name: "Stop highlighting Taproot" })).toBeVisible();
  await expect(page.locator(".gg__result")).toHaveText(await expected(request, next));
});
