// The QR codes on the address and node pages: loaded on first use, labelled, closed by Escape, and
// drawn in a node's colour only where that colour scans.
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { ACINQ, mainnet, recorded, serve } from "./lightning-answers";

/** Notes every request for the QR code's own files. */
function watchQrFiles(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/assets/QrPop-")) seen.push(r.url());
  });
  return seen;
}

/** The pop-up fits inside the window. */
async function inWindow(page: Page) {
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  const size = page.viewportSize();
  expect(box && size).toBeTruthy();
  if (!box || !size) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
}

test("an address opens as a QR code, loaded only then, and Escape returns focus", async ({
  page,
}) => {
  const files = watchQrFiles(page);
  const address = chain.addresses.p2tr;
  await page.goto(`/regtest/address/${address}`);
  const button = page.getByRole("button", { name: "Show the address as a QR code" });
  await expect(button).toBeVisible();
  expect(files).toStrictEqual([]);

  await button.click();
  const dialog = page.getByRole("dialog", { name: "Scan the address" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: "QR code of the address below" })).toBeVisible();
  await expect(dialog.locator(".qr-pop__text")).toHaveText(address);
  await expect(dialog.locator(".qr__mark")).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  expect(files.length).toBeGreaterThan(0);
  await inWindow(page);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // The close button closes it too, and gives focus back.
  await button.click();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});

test("a node's connect string is drawn in its colour, darkened when too pale", async ({ page }) => {
  const node = recorded("node-acinq") as { addresses: string[] };
  const connect = `${ACINQ}@${node.addresses[0] ?? ""}`;
  const answers = mainnet();
  const files = watchQrFiles(page);
  const open = async (color: string) => {
    await serve(page, { ...answers, [`nodes/${ACINQ}`]: { ...node, color } });
    await page.goto(`/regtest/lightning/node/${ACINQ}`);
    const button = page.getByRole("button", { name: "Show the connect string as a QR code" });
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Scan the connect string" });
    await expect(dialog.locator(".qr-pop__text")).toHaveText(connect);
    await expect(
      dialog.getByRole("img", { name: "QR code of the connect string below" }),
    ).toBeVisible();
    return dialog;
  };
  const fill = (dialog: ReturnType<Page["getByRole"]>) =>
    dialog.locator(".qr__code").evaluate((svg) => getComputedStyle(svg).fill);

  // A phone's width: the pop-up still fits.
  await page.setViewportSize({ width: 360, height: 740 });
  const dark = await open("#2b1d5c");
  await expect(dark.getByText("Drawn in the node's own colour")).toBeVisible();
  expect(await fill(dark)).toBe("rgb(43, 29, 92)");
  expect(files.length).toBeGreaterThan(0);
  await inWindow(page);

  const pale = await open("#fdfde8");
  await expect(pale.getByText("Drawn in the node's colour, darkened so it scans")).toBeVisible();
  const [r = 255, g = 255, b = 255] = (await fill(pale)).match(/\d+/g)?.map(Number) ?? [];
  // Darkened to 4.5:1 on the white card: its luminance at most (1.05 / 4.5) - 0.05.
  const lin = (c: number) => (c <= 10.31 ? c / 3295 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  expect(0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)).toBeLessThanOrEqual(0.1834);
  // Its hue kept: still more red and green than blue.
  expect(Math.min(r, g)).toBeGreaterThan(b);
});
