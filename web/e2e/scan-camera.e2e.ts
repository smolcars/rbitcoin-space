// The QR scanner's camera, in Chromium with a fake camera that films a code: it reads it, opens
// its page, and the camera is off whenever the scanner is closed, however it closes.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { qrY4m } from "./qr-images";

// The video is written before the browser starts, which reads it at launch.
const dir = mkdtempSync(join(tmpdir(), "scan-camera-"));
const video = join(dir, "code.y4m");
const URI = `bitcoin:${chain.addresses.p2wpkh.toUpperCase()}?amount=0.5`;
writeFileSync(video, qrY4m(URI));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skip(({ browserName }) => browserName !== "chromium", "a fake camera is Chromium's");
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${video}`,
    ],
  },
  permissions: ["camera"],
});

/** Records every stream the page is given, so a test can tell whether the camera is still on. */
async function recordStreams(page: Page) {
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    const media = navigator.mediaDevices;
    const ask = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      const stream = await ask(constraints);
      streams.push(stream);
      return stream;
    };
    Object.assign(window, {
      cameraOn: () => streams.some((s) => s.getTracks().some((t) => t.readyState === "live")),
      streamsAsked: () => streams.length,
    });
  });
}
const cameraOn = async (page: Page) =>
  page.evaluate(() => (window as unknown as { cameraOn: () => boolean }).cameraOn());
const streamsAsked = async (page: Page) =>
  page.evaluate(() => (window as unknown as { streamsAsked: () => number }).streamsAsked());

async function openScanner(page: Page) {
  await page.getByRole("button", { name: "Scan a QR code" }).click();
  const dialog = page.getByRole("dialog", { name: "Scan a QR code" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the camera reads a code, opens its page and goes off", async ({ page }) => {
  await recordStreams(page);
  await page.goto("/regtest/");
  await openScanner(page);
  await expect(page).toHaveURL(`/regtest/address/${chain.addresses.p2wpkh}`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await streamsAsked(page)).toBe(1);
  expect(await cameraOn(page)).toBe(false);
});

test.describe("a camera with no code before it", () => {
  // A reader that never finds a code, so the scanner stays open on a live camera.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      function BarcodeDetector() {
        return { detect: () => Promise.resolve([]) };
      }
      BarcodeDetector.getSupportedFormats = () => Promise.resolve(["qr_code"]);
      Object.assign(window, { BarcodeDetector });
    });
    await recordStreams(page);
  });

  test("Escape closes the scanner and turns the camera off", async ({ page }) => {
    await page.goto("/regtest/");
    const dialog = await openScanner(page);
    await expect(dialog.getByRole("status")).toHaveText("Hold the code inside the frame.");
    expect(await cameraOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await cameraOn(page)).toBe(false);
    await expect(page.getByRole("button", { name: "Scan a QR code" })).toBeFocused();
  });

  test("the close button and a press outside close it too, the camera with it", async ({
    page,
  }) => {
    await page.goto("/regtest/");
    let dialog = await openScanner(page);
    await expect(dialog.getByRole("status")).toHaveText("Hold the code inside the frame.");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await cameraOn(page)).toBe(false);
    dialog = await openScanner(page);
    await expect(dialog.getByRole("status")).toHaveText("Hold the code inside the frame.");
    await page.mouse.click(4, 4);
    await expect(dialog).toHaveCount(0);
    expect(await cameraOn(page)).toBe(false);
  });

  test("leaving the page closes the scanner and turns the camera off", async ({ page }) => {
    await page.goto("/regtest/blocks");
    await page.goto("/regtest/");
    const dialog = await openScanner(page);
    await expect(dialog.getByRole("status")).toHaveText("Hold the code inside the frame.");
    await page.goBack();
    await expect(page).toHaveURL("/regtest/blocks");
    await expect(dialog).toHaveCount(0);
    expect(await cameraOn(page)).toBe(false);
  });
});

test("the browser's own reader is handed the camera's frames", async ({ page }) => {
  await page.addInitScript((text) => {
    const given: string[] = [];
    function BarcodeDetector() {
      return {
        detect: (source: unknown) => {
          given.push(Object.prototype.toString.call(source));
          return Promise.resolve(given.length > 2 ? [{ rawValue: text }] : []);
        },
      };
    }
    BarcodeDetector.getSupportedFormats = () => Promise.resolve(["qr_code"]);
    Object.assign(window, { BarcodeDetector, scanGiven: given });
  }, chain.txs.payment);
  const jsqr: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/assets/jsQR-")) jsqr.push(r.url());
  });
  await page.goto("/regtest/");
  await openScanner(page);
  await expect(page).toHaveURL(`/regtest/tx/${chain.txs.payment}`);
  const given = await page.evaluate(() => (window as unknown as { scanGiven: string[] }).scanGiven);
  expect(new Set(given)).toStrictEqual(new Set(["[object HTMLVideoElement]"]));
  expect(jsqr).toStrictEqual([]);
});
