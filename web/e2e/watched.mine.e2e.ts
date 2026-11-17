// Mines on the run's node, so it runs after every other test (the `mines` project). Named to run
// after the other mining files: home.mine.e2e.ts counts on what address.mine.e2e.ts leaves waiting.
import { expect, PROJECTION_LAG_MS, test } from "./fixtures";
import { tablesFit, tapRow } from "./rows";

// A new block's facts are computed on first ask; the page retries a busy answer quietly.
test.use({ consoleErrorsAllowed: [/status of (429|503)/] });

test("a block the server watched arrive shows its audit, and its match rate in the list", async ({
  page,
  mine,
}) => {
  const [hash] = await mine(1);
  await page.goto(`/regtest/block/${hash}`);
  const audit = page.getByRole("region", { name: "Audit" });
  await expect(audit.getByText("Match rate", { exact: true })).toBeVisible();
  await expect(audit.getByText(/^\d+(\.\d\d)?%$/)).toBeVisible();
  await expect(
    audit.getByRole("table", { name: "The block we expected and the block mined" }),
  ).toBeVisible();
  await expect(audit.getByText("Not audited", { exact: false })).toHaveCount(0);
  // The kinds' meanings are in sight on a wide screen: their button is a phone's only. It once
  // showed on desktops too, in the browser's own grey, when the disclosure's styles loaded after.
  await expect(audit.getByRole("button", { name: "What each kind means" })).toBeVisible({
    visible: (page.viewportSize()?.width ?? 0) <= 640,
  });

  await page.goto("/regtest/blocks");
  const table = page.getByRole("table", { name: "Recent blocks, newest first" });
  const first = table.getByRole("row").nth(1);
  await expect(first.getByRole("link").first()).toHaveAttribute("href", `/regtest/block/${hash}`);
  // A phone keeps the miner and the transaction count; the match rate is on wider screens.
  if ((page.viewportSize()?.width ?? 0) > 640) {
    await expect(table.getByRole("columnheader", { name: "Match rate, %" })).toBeVisible();
    await expect(first.getByRole("cell", { name: /^\d+(\.\d\d)? %$/ })).toBeVisible();
  } else {
    await expect(table.getByRole("columnheader", { name: "Miner" })).toBeVisible();
  }
});

const PERIODS = [
  ["24h", "the last 24 hours"],
  ["1w", "the last week"],
  ["all", "all time"],
  ["1m", "the last 30 days"],
  ["1y", "the last year"],
  ["24h", "the last 24 hours"],
  // Last: all of history spans only the audits, so the blocks mined seconds apart here stand
  // apart on the plot rather than in its last pixel.
  ["all", "all time"],
] as const;

// A caption on this page once kept its first period's words after a switch.
test("block health draws the blocks the server watched arrive, follows every period, and a point opens its block", async ({
  page,
  mine,
  rpc,
}) => {
  // One block: only a block that is the tip when the server reads it is audited, so a burst of
  // two would leave the first without one.
  await mine(1);
  const tip = await rpc<number>("getblockcount");
  // Its audit is written as the server reads the new block, a moment after it arrives.
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get("/regtest/api/v1/mining/blocks/predictions/24h")
          ).json()) as number[][]
        ).at(-1)?.[1],
      { timeout: PROJECTION_LAG_MS },
    )
    .toBe(tip);
  await page.goto("/regtest/mining?period=24h");
  const health = page.getByRole("region", { name: "Blocks over time" });
  await health.getByRole("button", { name: "Match rate" }).click();
  const chart = health.getByRole("slider");
  for (const [k, [, words]] of PERIODS.entries()) {
    if (k > 0) {
      await page
        .getByRole("navigation", { name: "Period" })
        .getByRole("link", { name: new RegExp(`: ${words}$`) })
        .click();
    }
    await expect(chart).toHaveAttribute(
      "aria-label",
      `Match rate of each audited block, ${words}`,
      { timeout: 30_000 },
    );
  }
  // The latest point is the newest block, and it opens it.
  await expect(chart).toHaveAttribute("aria-valuetext", new RegExp(`Block ${tip}$`));
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (!box) throw new Error("no plot");
  // Where the latest point is drawn: the readout's dot marks it.
  const dot = await chart.locator("circle").boundingBox();
  if (!dot) throw new Error("no point");
  const end = { x: dot.x + dot.width / 2, y: box.y + box.height / 2 };
  const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  // The block the pointer reads there: blocks stamped in the same second share one place, the
  // first of them under the pointer.
  const read = async () =>
    /Block (\d+)$/.exec((await chart.getAttribute("aria-valuetext")) ?? "")?.[1] ?? "";
  let block: string;
  if (touch) {
    // The first tap reads the point and leaves the plot where it was; the second opens it.
    await page.touchscreen.tap(end.x, end.y);
    await expect(chart).toHaveAttribute("aria-valuenow", /\d+/);
    block = await read();
    expect((await chart.boundingBox())?.y).toBe(box.y);
    await expect(page).toHaveURL(/\/regtest\/mining\?period=all$/);
    // A thumb's target (docs/DESIGN.md "Touch"): a second tap 20 px aside still opens it.
    await page.touchscreen.tap(end.x - 20, end.y);
  } else {
    await page.mouse.move(end.x, end.y);
    block = await read();
    await page.mouse.down();
    await page.mouse.up();
  }
  expect(Number(block)).toBeGreaterThan(tip - 3);
  await expect(page).toHaveURL(`/regtest/block/${block}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(block);
  await page.goBack();
  // The keyboard: Enter opens the point the slider is on. The pointer leaves the plot first, or
  // the scroll that focus brings would move a point under it.
  await page.mouse.move(0, 0);
  await chart.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/regtest/block/${tip}`);
  await page.goBack();
  // The figures are a list: a row opens its block, and the table fits.
  await health.getByText("Show the figures").click();
  const figures = health.getByRole("table", { name: /^Match rate of each audited block/ });
  await tablesFit(page, "block health's figures");
  await tapRow(page, figures, "block health's figures");
});
