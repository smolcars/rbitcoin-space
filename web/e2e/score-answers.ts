// The fee track record from recorded answers (src/pages/fees/testdata.ts): regtest has too few
// blocks for any share, so a page with shares is drawn from mainnet's.
import type { Page } from "@playwright/test";
import { MAINNET_1W } from "../src/pages/fees/testdata";

/** Serves `/regtest/app/fees/score` from `json`, whatever the window asked. */
export async function serveScore(page: Page, json: unknown = MAINNET_1W): Promise<void> {
  await page.route(/\/regtest\/app\/fees\/score(\?|$)/, (r) => r.fulfill({ json }));
}
