// The Ark pages (docs/ARK.md), on regtest without an Ark server and with one from recorded answers.
import { ARKADE_ID, HEX, ID, withArkade, withBark, withBarkHex, withBoth } from "./ark-answers";
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

test.describe("a Bark VTXO from its hex", () => {
  // The anchor is on no regtest chain (404); the refusals below are the server's (400, 422).
  test.use({ consoleErrorsAllowed: [/status of 4(00|04|22)/] });

  test("is checked by the server with no Bark server, and the hex stays out of every URL", async ({
    page,
    context,
    browserName,
  }) => {
    const urls: string[] = [];
    const bodies: (string | null)[] = [];
    page.on("request", (r) => {
      urls.push(r.url());
      if (r.method() === "POST") bodies.push(r.postData());
    });
    await page.goto(`/regtest/ark/bark/hex#${HEX}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("VTXO");
    // Regtest's node does not hold ark-lib's anchor, so nothing is called checked.
    const state = page.getByRole("list", { name: "State" });
    await expect(state.getByText("Not verified")).toBeVisible();
    await expect(state.getByText("Signatures OK")).toHaveCount(0);
    await expect(page.getByText("3 tree, 2 transfers")).toBeVisible();
    expect(bodies).toStrictEqual([HEX]);
    expect(urls.filter((u) => u.includes(HEX.slice(0, 64)))).toStrictEqual([]);

    // A reload keeps the fragment, and so the VTXO.
    await page.reload();
    await expect(page.getByText("3 tree, 2 transfers")).toBeVisible();

    // The copy control copies the VTXO's id, not its hex.
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.getByRole("button", { name: "Copy the VTXO ID" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ID);
    }
  });

  test("checked whole where the node holds the anchor", async ({ page }) => {
    await withBarkHex(page);
    await page.goto(`/regtest/ark/bark/hex#${HEX}`);
    await expect(
      page.getByRole("list", { name: "State" }).getByText("Signatures OK"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Play exit" })).toBeVisible();
  });

  test("no hex, not hex, not a VTXO, and a VTXO that does not check out", async ({ page }) => {
    await page.goto("/regtest/ark/bark/hex");
    await expect(page.getByText("No VTXO hex")).toBeVisible();
    await page.goto("/regtest/ark/bark/hex#zz");
    await expect(page.getByText("Not VTXO hex")).toBeVisible();
    await page.goto(`/regtest/ark/bark/hex#${"00".repeat(40)}`);
    await expect(page.getByText("This hex is not a Bark VTXO")).toBeVisible();
    // The point's vout changed: the exit chain no longer leads to it.
    const last = (Number.parseInt(HEX.slice(-2), 16) ^ 1).toString(16).padStart(2, "0");
    await page.goto(`/regtest/ark/bark/hex#${HEX.slice(0, -2)}${last}`);
    await expect(page.getByText("This VTXO did not check out")).toBeVisible();
  });
});

test.describe("with Arkade", () => {
  // Reduced motion: Play exit shows its end at once rather than over ten steps.
  test.use({ consoleErrorsAllowed: [/status of 404/], reducedMotion: "reduce" });

  test("the entry page offers Bark and Arkade side by side, and opens an Arkade VTXO", async ({
    page,
  }) => {
    await withBoth(page);
    await page.goto("/regtest/ark");
    const tabs = page.getByRole("group", { name: "Implementation" });
    await expect(tabs.getByRole("button")).toHaveText(["Bark", "Arkade"]);
    await tabs.getByRole("button", { name: "Arkade" }).click();
    await expect(tabs.getByRole("button", { name: "Arkade" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByLabel("Arkade VTXO ID").fill(` ${ARKADE_ID.toUpperCase()} `);
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page).toHaveURL(`/regtest/ark/arkade/vtxo/${ARKADE_ID}`);
    await expect(page.getByRole("button", { name: "Play exit" })).toBeVisible();
    const ark = page.getByRole("navigation").getByRole("link", { name: "Ark" });
    await expect(ark).toHaveAttribute("aria-current", "true");

    await page.getByRole("link", { name: "Another VTXO" }).click();
    await expect(page).toHaveURL(/\/regtest\/ark$/);
  });

  test("a VTXO: arkd's words, its tree, Play exit and a transaction picked", async ({ page }) => {
    await withArkade(page, true);
    await page.goto(`/regtest/ark/arkade/vtxo/${ARKADE_ID}`);
    await expect(page.locator(".arkade-badge")).toHaveText(["Unspent", "Not settled yet"]);
    await expect(page.getByText("1 000 sats", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("10 transactions")).toBeVisible();
    const table = page.getByRole("table", { name: /exit's transactions/ });
    await expect(table.getByRole("row")).toHaveCount(12);

    await page.getByRole("button", { name: "Play exit" }).click();
    await expect(page.getByText(/then wait ~2 days/)).toBeVisible();

    const checkpoint = page.getByRole("button", { name: "9. Checkpoint" });
    await checkpoint.focus();
    await page.keyboard.press("Enter");
    await expect(checkpoint).toHaveAttribute("aria-pressed", "true");
    const picked = page.getByRole("region", { name: "Selected transaction" });
    await expect(picked).toContainText("#9 Checkpoint");
    await picked.getByRole("button", { name: "Close" }).click();
    await expect(picked).toHaveCount(0);
  });

  test("swept, as signet's VTXO is", async ({ page }) => {
    await withArkade(page);
    await page.goto(`/regtest/ark/arkade/vtxo/${ARKADE_ID}`);
    await expect(page.locator(".arkade-badge").first()).toHaveText("Swept");
  });

  test("an outpoint Arkade does not know, one that is not an outpoint, and a network without it", async ({
    page,
    request,
  }) => {
    await withArkade(page);
    await page.goto(`/regtest/ark/arkade/vtxo/${UNKNOWN}`);
    await expect(page.getByText("Arkade knows no such VTXO")).toBeVisible();
    await page.goto("/regtest/ark/arkade/vtxo/nonsense");
    await expect(page.getByText("Not a VTXO", { exact: true })).toBeVisible();

    await page.unrouteAll();
    await page.goto(`/regtest/ark/arkade/vtxo/${ARKADE_ID}`);
    await expect(page.getByText("Arkade is not available on this network")).toBeVisible();
    const off = await request.get(`/regtest/app/ark/arkade/vtxo/${ARKADE_ID.replace(":", "/")}`);
    expect(off.status()).toBe(404);
    expect(await off.json()).toStrictEqual({ error: "arkade is not available here" });
  });
});
