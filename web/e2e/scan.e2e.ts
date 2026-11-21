// The QR scanner in the header search, from a picture: jsQR where the browser has no reader of its
// own (Chromium on Linux, so every run here), and the browser's BarcodeDetector where it has one,
// stood in for. The camera is in scan-camera.e2e.ts.
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { ACINQ, mainnet, serve } from "./lightning-answers";
import { blankPng, qrPng } from "./qr-images";

/** Notes every request for the jsQR chunk. */
function watchJsqr(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (/\/assets\/jsQR-[^/]*\.js$/.test(r.url())) seen.push(r.url());
  });
  return seen;
}

/** Opens the scanner and chooses a picture: of the code for `text`, or the file `picture`. */
async function choosePicture(page: Page, text: string | Buffer) {
  await page.getByRole("button", { name: "Scan a QR code" }).click();
  const dialog = page.getByRole("dialog", { name: "Scan a QR code" });
  await expect(dialog).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a picture" }).click();
  await (
    await chooser
  ).setFiles({
    name: "code.png",
    mimeType: "image/png",
    buffer: typeof text === "string" ? qrPng(text) : text,
  });
  return dialog;
}

test.describe("with jsQR", () => {
  test("loads the scanner and jsQR only when it opens, and says why there is no camera", async ({
    page,
  }) => {
    const jsqr = watchJsqr(page);
    await page.goto("/regtest/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(jsqr).toStrictEqual([]);
    await page.getByRole("button", { name: "Scan a QR code" }).click();
    const dialog = page.getByRole("dialog", { name: "Scan a QR code" });
    // Headless Chromium has no camera: the scanner says so, and offers a picture.
    await expect(dialog.getByRole("status")).toHaveText(
      /No camera found|blocked for this site|cannot use a camera/,
    );
    await expect(dialog.getByRole("button", { name: "Choose a picture" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Scan a QR code" })).toBeFocused();
  });

  test("a picture of a transaction ID opens the transaction", async ({ page }) => {
    const jsqr = watchJsqr(page);
    await page.goto("/regtest/blocks");
    await choosePicture(page, chain.txs.payment);
    await expect(page).toHaveURL(`/regtest/tx/${chain.txs.payment}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Transaction");
    expect(jsqr).toHaveLength(1);
  });

  test("a screenshot of the site's own code, logo, text and all, opens its address", async ({
    page,
  }) => {
    // The address page's pop-up on a light page: its title and the address as text sit beside the
    // code, which jsQR read at one size in two (decode.ts WAYS).
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    await page.getByRole("button", { name: "Show the address as a QR code" }).click();
    const pop = page.getByRole("dialog");
    await expect(pop.locator("svg, canvas").first()).toBeVisible();
    await pop.evaluate(async (d) => {
      await Promise.all(d.getAnimations({ subtree: true }).map(async (a) => a.finished));
    });
    const shot = await pop.screenshot({ animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.goto("/regtest/");
    await choosePicture(page, shot);
    await expect(page).toHaveURL(`/regtest/address/${chain.addresses.p2tr}`);
  });

  test("a payment URI in capitals opens its address", async ({ page }) => {
    await page.goto("/regtest/");
    await choosePicture(page, `BITCOIN:${chain.addresses.p2tr.toUpperCase()}?AMOUNT=0.001`);
    await expect(page).toHaveURL(`/regtest/address/${chain.addresses.p2tr}`);
  });

  test("a node's connect string opens the node", async ({ page }) => {
    await serve(page, mainnet());
    await page.goto("/regtest/");
    await choosePicture(page, `${ACINQ}@3.33.236.230:9735`);
    await expect(page).toHaveURL(`/regtest/lightning/node/${ACINQ}`);
  });

  test("a code the site does not know is shown as text and named so", async ({ page }) => {
    await page.goto("/regtest/");
    const text = 'https://example.com/<img src=x onerror="alert(1)">';
    await choosePicture(page, text);
    const panel = page.locator(".search__panel");
    await expect(panel).toContainText("Code not recognised");
    await expect(panel.locator("q")).toHaveText(text);
    await expect(panel.locator("img")).toHaveCount(0);
    await expect(page).toHaveURL("/regtest/");
    // Focus stays in the search, its answer next in the Tab order.
    await expect(page.getByRole("button", { name: "Scan a QR code" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("link").first()).toBeFocused();
  });

  test("a picture with no code, or no picture at all, says so and keeps the scanner open", async ({
    page,
  }) => {
    await page.goto("/regtest/");
    // An empty file: no picture at all.
    const dialog = await choosePicture(page, Buffer.alloc(0));
    await expect(dialog.getByRole("status")).toHaveText(/not a picture this browser can open/);
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose a picture" }).click();
    await (
      await chooser
    ).setFiles({ name: "blank.png", mimeType: "image/png", buffer: blankPng() });
    await expect(dialog.getByRole("status")).toHaveText(/No QR code found in that picture/);
    await expect(dialog).toBeVisible();
  });
});

test.describe("with the browser's own reader", () => {
  test("uses BarcodeDetector where it reads QR codes, and never fetches jsQR", async ({ page }) => {
    // A stand-in for the reader Chrome has on Android and macOS: it reads whatever it is given as
    // the code the test names, and records what it was given.
    await page.addInitScript((text) => {
      const given: string[] = [];
      function BarcodeDetector(options: { formats: string[] }) {
        return {
          detect: (source: unknown) => {
            given.push(`${Object.prototype.toString.call(source)} ${options.formats.join(",")}`);
            return Promise.resolve([{ rawValue: text }]);
          },
        };
      }
      BarcodeDetector.getSupportedFormats = () => Promise.resolve(["qr_code", "ean_13"]);
      Object.assign(window, { scanGiven: given, BarcodeDetector });
    }, chain.txs.consolidation);
    const jsqr = watchJsqr(page);
    await page.goto("/regtest/");
    await choosePicture(page, "whatever the picture holds, the stand-in reads its own");
    await expect(page).toHaveURL(`/regtest/tx/${chain.txs.consolidation}`);
    const given = await page.evaluate(
      () => (window as unknown as { scanGiven: string[] }).scanGiven,
    );
    expect(given).toContain("[object ImageBitmap] qr_code");
    expect(jsqr).toStrictEqual([]);
  });
});

test.describe("when the scanner's files fail", () => {
  test.use({ consoleErrorsAllowed: [/status of 503/] });
  // WebKit keeps a failed import for the life of the page: there a retry waits for a reload.
  test.skip(({ browserName }) => browserName === "webkit", "WebKit holds a failed import");

  test("Escape while the scanner downloads gives up opening it", async ({ page }) => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/assets\/Scanner-[^/]+\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/regtest/");
    const arrived = page.waitForResponse(/\/assets\/Scanner-[^/]+\.js$/);
    const button = page.getByRole("button", { name: "Scan a QR code" });
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-busy", "false");
    release?.();
    await arrived;
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the page stays, the button says so, and a second press opens it", async ({ page }) => {
    let fail = true;
    await page.route(/\/assets\/Scanner-[^/]+\.js$/, async (route) =>
      fail ? route.fulfill({ status: 503, body: "" }) : route.continue(),
    );
    await page.goto("/regtest/");
    await page.getByRole("button", { name: "Scan a QR code" }).click();
    const failed = page.getByRole("button", { name: /The scanner could not be loaded/ });
    await expect(failed).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    fail = false;
    await failed.click();
    await expect(page.getByRole("dialog", { name: "Scan a QR code" })).toBeVisible();
  });

  test("a code reader that did not download says so, and the next picture tries again", async ({
    page,
  }) => {
    let fail = true;
    await page.route(/\/assets\/jsQR-[^/]+\.js$/, async (route) =>
      fail ? route.fulfill({ status: 503, body: "" }) : route.continue(),
    );
    await page.goto("/regtest/");
    const dialog = await choosePicture(page, chain.txs.payment);
    await expect(dialog.getByRole("status")).toHaveText(/The code reader did not load/);
    fail = false;
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose a picture" }).click();
    await (
      await chooser
    ).setFiles({ name: "code.png", mimeType: "image/png", buffer: qrPng(chain.txs.payment) });
    await expect(page).toHaveURL(`/regtest/tx/${chain.txs.payment}`);
  });
});
