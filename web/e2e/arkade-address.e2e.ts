// The Arkade address page (docs/ARK.md), from the real server's answers for signet's address.
import {
  ARKADE_ADDRESS,
  EMPTY_ADDRESS,
  FOREIGN_ADDRESS,
  UNKNOWN_VERSION_ADDRESS,
  withArkadeAddress,
} from "./ark-answers";
import { expect, test } from "./fixtures";

const path = (a: string) => `/regtest/ark/arkade/address/${a}`;

test.describe("an Arkade address", () => {
  test.use({ consoleErrorsAllowed: [/status of 4(00|22)/] });

  test("lists its VTXOs a page at a time, each opening its VTXO", async ({ page }) => {
    await withArkadeAddress(page);
    await page.goto(path(ARKADE_ADDRESS));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Address");
    await expect(page.getByText("on this page", { exact: true })).toBeVisible();
    await expect(page.getByText("Spendable on this page")).toBeVisible();
    const table = page.getByRole("table", { name: /VTXOs, newest first/ });
    await expect(table.getByRole("row")).toHaveCount(26);
    await expect(table.getByText("Swept").first()).toBeVisible();
    const pager = page.getByRole("navigation", { name: "VTXO pages" });
    await expect(pager).toContainText("Page 1 of 11");

    await pager.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(`${path(ARKADE_ADDRESS)}?page=2`);
    await expect(pager).toContainText("Page 2 of 11");

    await page.goto(`${path(ARKADE_ADDRESS)}?page=11`);
    await expect(table.getByRole("row")).toHaveCount(7);
    await expect(pager.getByRole("button", { name: "Next" })).toBeDisabled();

    const first = table.getByRole("row").nth(1).getByRole("link").first();
    const href = await first.getAttribute("href");
    expect(href).toMatch(/^\/regtest\/ark\/arkade\/vtxo\/[0-9a-f]{64}:\d+$/);
  });

  test("says what is unspent, and what is spendable", async ({ page }) => {
    await withArkadeAddress(page, true);
    await page.goto(path(ARKADE_ADDRESS));
    const table = page.getByRole("table", { name: /VTXOs, newest first/ });
    await expect(table.getByText("Unspent")).toHaveCount(3);
    await expect(table.getByText("Not settled yet")).toHaveCount(3);
    // Three of 1 000 sats each.
    await expect(page.locator(".arkade-fig__value").nth(1)).toContainText(/0\.00\s003\s000/);
  });

  test("another server's, an empty one, Bark's, an unknown version, another network's and nonsense", async ({
    page,
  }) => {
    await withArkadeAddress(page);
    await page.goto(path(FOREIGN_ADDRESS));
    await expect(page.getByText("This address belongs to another Arkade server")).toBeVisible();
    await page.goto(path(EMPTY_ADDRESS));
    await expect(page.getByText("No VTXOs", { exact: true })).toBeVisible();
    await page.goto(path(`tark1p${ARKADE_ADDRESS.slice(6)}`));
    await expect(page.getByText("A Bark address")).toBeVisible();
    await page.goto(path(`tark1z${ARKADE_ADDRESS.slice(6)}`));
    await expect(page.getByText("Unknown Ark address version")).toBeVisible();
    await page.goto(path(UNKNOWN_VERSION_ADDRESS));
    await expect(page.getByText("Unknown Ark address version")).toBeVisible();
    await page.goto(path(`ark1${ARKADE_ADDRESS.slice(5)}`));
    await expect(page.getByText("An address for another network")).toBeVisible();
    await page.goto(path("nonsense"));
    await expect(page.getByText("Not an Arkade address")).toBeVisible();
    // Shaped right, refused by the server's checksum.
    await page.goto(path(`${ARKADE_ADDRESS.slice(0, -1)}q`));
    await expect(page.getByText("Not an Arkade address")).toBeVisible();
  });

  test("a network without Arkade", async ({ page, request }) => {
    await page.goto(path(ARKADE_ADDRESS));
    await expect(page.getByText("Arkade is not available on this network")).toBeVisible();
    const off = await request.get(`/regtest/app/ark/arkade/address/${ARKADE_ADDRESS}`);
    expect(off.status()).toBe(404);
    expect(await off.json()).toStrictEqual({ error: "arkade is not available here" });
  });
});
