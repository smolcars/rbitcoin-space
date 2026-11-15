// The Ark pages (docs/ARK.md), on regtest without a Bark server and with one from a fixture.
import { ID, withBark } from "./ark-answers";
import { expect, test } from "./fixtures";

const UNKNOWN = `${"ab".repeat(32)}:1`;

test("a network without an Ark server shows no Ark, and its route says why", async ({
  page,
  request,
}) => {
  await page.goto("/regtest/");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Ark" })).toHaveCount(0);
  await page.goto("/regtest/ark");
  await expect(page.getByText("No Ark server is set up on this network")).toBeVisible();

  const off = await request.get(`/regtest/app/ark/bark/vtxo/${ID}`);
  expect(off.status()).toBe(404);
  expect(await off.json()).toStrictEqual({ error: "bark is not set up on this network" });
  const bad = await request.get("/regtest/app/ark/bark/vtxo/not-an-id");
  expect(bad.status()).toBe(400);
});

test.describe("with Bark", () => {
  test.use({ consoleErrorsAllowed: [/status of 404/] });

  test("the entry page opens a VTXO by its id", async ({ page }) => {
    await withBark(page);
    await page.goto("/regtest/");
    await page.getByRole("navigation").getByRole("link", { name: "Ark" }).click();
    await expect(page).toHaveURL(/\/regtest\/ark$/);
    const field = page.getByLabel("Bark VTXO ID");
    await field.fill("not a vtxo");
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByText("Not a VTXO ID")).toBeVisible();
    await field.fill(` ${ID.toUpperCase()} `);
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page).toHaveURL(`/regtest/ark/bark/vtxo/${ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("VTXO");
  });

  test("a VTXO: figures, badges, the exit path and its transactions", async ({ page }) => {
    await withBark(page);
    await page.goto(`/regtest/ark/bark/vtxo/${ID}`);
    const state = page.getByRole("list", { name: "State" });
    await expect(state.getByText("Signatures OK")).toBeVisible();
    await expect(state.getByText("Not settled yet")).toBeVisible();
    await expect(page.getByText(/^0\.0001\s?0000/).first()).toBeVisible();
    await expect(page.getByText("3 tree, 2 transfers")).toBeVisible();

    const table = page.getByRole("table", { name: /exit transactions/ });
    await expect(table.getByRole("row")).toHaveCount(7);
    await expect(table.getByText("Not broadcast").first()).toBeVisible();

    await page.getByRole("button", { name: "Play exit" }).click();
    await expect(page.getByText(/then wait 2\s016 blocks/)).toBeVisible();
    const node = page.getByRole("button", { name: "Transaction 4, transfer" });
    await node.focus();
    await page.keyboard.press("Enter");
    await expect(node).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Transaction 4")).toBeVisible();

    await page.getByText("Details").click();
    await expect(page.getByText("Wait after exit")).toBeVisible();
  });

  test("an id Bark does not know, and one that is not an id", async ({ page }) => {
    await withBark(page);
    await page.goto(`/regtest/ark/bark/vtxo/${UNKNOWN}`);
    await expect(page.getByText("Bark does not know this VTXO")).toBeVisible();
    await page.goto("/regtest/ark/bark/vtxo/nonsense");
    await expect(page.getByText("Not a VTXO ID")).toBeVisible();
  });
});
