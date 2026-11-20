import type { Page } from "@playwright/test";
import { MAINNET_1W, MAINNET_24H } from "../src/pages/fees/testdata";
import { expect, test } from "./fixtures";
import { serveScore } from "./score-answers";

const levels = (page: Page) => page.getByRole("heading", { level: 3 });

test("the home page's fee panel links to the track record, which keeps its window in the address", async ({
  page,
}) => {
  await page.goto("/regtest/");
  await page
    .getByRole("region", { name: "Fee to pay now" })
    .getByRole("link", { name: "Track record" })
    .click();
  await expect(page).toHaveURL(/\/regtest\/fees\/score$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fee track record");
  // Regtest's own answer: a young server has too few blocks for any share, or nothing at all.
  await expect(
    page.getByText("Too few blocks yet").first().or(page.getByText("Nothing recorded")),
  ).toBeVisible();
  const periods = page.getByRole("navigation", { name: "Period" });
  await expect(periods.getByRole("link", { name: /the last week/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const asked = page.waitForRequest(/\/regtest\/app\/fees\/score\?window=24h$/);
  await periods.getByRole("link", { name: /the last 24 hours/ }).click();
  await asked;
  await expect(page).toHaveURL(/\/regtest\/fees\/score\?window=24h$/);
  await expect(periods.getByRole("link", { name: /the last 24 hours/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("a level under its target says so plainly, beside those that meet theirs", async ({
  page,
}) => {
  await serveScore(page, MAINNET_1W);
  await page.goto("/regtest/fees/score");
  await expect(levels(page)).toHaveText(["No rush", "Low", "Medium", "High"]);
  const noRush = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "No rush" }) });
  await expect(noRush.getByText("Below target")).toBeVisible();
  await expect(noRush.getByText("67.4%")).toBeVisible();
  const high = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "High" }) });
  await expect(high.getByText("Meets target")).toBeVisible();
  await expect(page.getByRole("table", { name: /What each level paid/ })).toBeVisible();
  await expect(page.getByRole("table", { name: /The answers and blocks behind/ })).toBeVisible();
  await expect(page.getByText(/^In 539 samples from this period/)).toBeVisible();
});

test("switching the window replaces every figure with that window's", async ({ page }) => {
  const answers: Record<string, unknown> = { "1w": MAINNET_1W, "24h": MAINNET_24H };
  await page.route(/\/regtest\/app\/fees\/score\?window=(\w+)$/, (r) =>
    r.fulfill({ json: answers[new URL(r.request().url()).searchParams.get("window") ?? ""] }),
  );
  await page.goto("/regtest/fees/score?window=1w");
  const met = (name: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name }) })
      .locator(".fee-level__met");
  const evidence = page.getByRole("table", { name: /The answers and blocks behind/ });
  const highJudged = evidence.getByRole("row", { name: /^High/ }).getByRole("cell").nth(1);
  await expect(met("No rush")).toHaveText("67.4%");
  await expect(met("High")).toHaveText("88.5%");
  await expect(highJudged).toHaveText("19\u202F521");
  await page
    .getByRole("navigation", { name: "Period" })
    .getByRole("link", { name: /the last 24 hours/ })
    .click();
  await expect(page).toHaveURL(/window=24h$/);
  await expect(met("No rush")).toHaveText("–");
  await expect(met("High")).toHaveText("86.3%");
  await expect(highJudged).toHaveText("2\u202F846");
});

test("a level with too few blocks shows no share", async ({ page }) => {
  await serveScore(page, MAINNET_24H);
  await page.goto("/regtest/fees/score?window=24h");
  const noRush = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "No rush" }) });
  await expect(noRush.getByText("Too few blocks yet")).toBeVisible();
  await expect(
    noRush.getByText(/A share is given from 30 blocks; 6 blocks have decided/),
  ).toBeVisible();
  await expect(noRush.locator(".fee-level__met")).toHaveText("–");
});

test.describe("a server without the mempool engine", () => {
  test.use({ consoleErrorsAllowed: [/status of 503/] });
  test("says it keeps no track record", async ({ page }) => {
    await page.route(/\/regtest\/app\/fees\/score(\?|$)/, (r) =>
      r.fulfill({
        status: 503,
        headers: { "Retry-After": "1" },
        json: { error: "the mempool engine is off on this server" },
      }),
    );
    await page.goto("/regtest/fees/score");
    await expect(page.getByText("This server keeps no fee track record")).toBeVisible();
  });
});

test("the palette opens the track record by name", async ({ page }) => {
  await page.goto("/regtest/");
  await page
    .getByRole("list", { name: "Mined blocks, newest first" })
    .getByRole("link")
    .first()
    .waitFor();
  const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent));
  await page.keyboard.press(apple ? "Meta+k" : "Control+k");
  const palette = page.getByRole("dialog", { name: "Go to" });
  await palette.getByRole("combobox").fill("fee track");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(
    "Fee track record",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/regtest\/fees\/score$/);
});
