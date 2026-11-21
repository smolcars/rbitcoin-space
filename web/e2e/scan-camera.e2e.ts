// The QR scanner's camera, in Chromium with a fake camera that films a code: it reads it, opens
// its page, and the camera is off whenever the scanner is closed, however it closes.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { qrPng, qrY4m } from "./qr-images";

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

  test("Escape, the close button, a press outside and leaving the page each turn the camera off", async ({
    page,
  }) => {
    // One document throughout, so Back is the router's and every recorded stream is this page's.
    await page.goto("/regtest/blocks");
    await page.getByRole("banner").getByRole("link").first().click();
    await expect(page).toHaveURL(/\/regtest\/?$/);
    const closes: [string, () => Promise<unknown>][] = [
      ["Escape", async () => page.keyboard.press("Escape")],
      ["its close button", async () => page.getByRole("button", { name: "Close" }).click()],
      ["a press outside", async () => page.mouse.click(4, 4)],
      ["Back", async () => page.goBack()],
    ];
    for (const [i, [how, close]] of closes.entries()) {
      const dialog = await openScanner(page);
      await expect(dialog.getByRole("status")).toHaveText("Hold the code inside the frame.");
      expect(await cameraOn(page), `the camera on before ${how}`).toBe(true);
      await close();
      await expect(dialog).toHaveCount(0);
      expect(await cameraOn(page), `the camera off after ${how}`).toBe(false);
      expect(await streamsAsked(page)).toBe(i + 1);
      if (how === "Escape") {
        await expect(page.getByRole("button", { name: "Scan a QR code" })).toBeFocused();
      }
    }
    await expect(page).toHaveURL("/regtest/blocks");
  });
});

test("the browser's own reader is handed what the preview shows of each frame", async ({
  page,
}) => {
  await page.addInitScript((text) => {
    const given: string[] = [];
    function BarcodeDetector() {
      return {
        detect: (source: HTMLCanvasElement) => {
          given.push(`${Object.prototype.toString.call(source)} ${source.width}x${source.height}`);
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
  // The fake camera films 640 × 480; the square preview shows its middle 480 × 480, and only that
  // is read, so no code the reader cannot see is followed.
  expect(new Set(given)).toStrictEqual(new Set(["[object HTMLCanvasElement] 480x480"]));
  expect(jsqr).toStrictEqual([]);
});

test("a picture chosen while the camera runs has the say over the camera", async ({ page }) => {
  // The camera's frames read as one transaction once the picture is being read; the picture,
  // held until the test lets it go, as another.
  await page.addInitScript(
    ({ fromCamera, fromPicture }) => {
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = { picking: false, frames: 0, release: () => release?.() };
      function BarcodeDetector() {
        return {
          detect: async (source: unknown) => {
            if (source instanceof ImageBitmap) {
              state.picking = true;
              await held;
              return [{ rawValue: fromPicture }];
            }
            if (state.picking) state.frames += 1;
            return state.picking ? [{ rawValue: fromCamera }] : [];
          },
        };
      }
      BarcodeDetector.getSupportedFormats = () => Promise.resolve(["qr_code"]);
      Object.assign(window, { BarcodeDetector, scanState: state });
    },
    { fromCamera: chain.txs.payment, fromPicture: chain.txs.consolidation },
  );
  await page.goto("/regtest/");
  const dialog = await openScanner(page);
  await expect(dialog.getByRole("status")).toHaveText("Hold the code inside the frame.");
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a picture" }).click();
  await (await chooser).setFiles({ name: "code.png", mimeType: "image/png", buffer: qrPng("any") });
  // Frames that find the camera's code while the picture is read open nothing.
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as unknown as { scanState: { frames: number } }).scanState.frames,
      ),
    )
    .toBeGreaterThan(3);
  await expect(page).toHaveURL("/regtest/");
  await page.evaluate(() => {
    (window as unknown as { scanState: { release: () => void } }).scanState.release();
  });
  await expect(page).toHaveURL(`/regtest/tx/${chain.txs.consolidation}`);
});

test("an open picker holds the camera off, and closing it with nothing chosen hands back", async ({
  page,
}) => {
  // The camera's frames find a transaction once the picker is open.
  await page.addInitScript((text) => {
    const state = { pickerOpen: false, frames: 0 };
    function BarcodeDetector() {
      return {
        detect: () => {
          if (state.pickerOpen) state.frames += 1;
          return Promise.resolve(state.pickerOpen ? [{ rawValue: text }] : []);
        },
      };
    }
    BarcodeDetector.getSupportedFormats = () => Promise.resolve(["qr_code"]);
    Object.assign(window, { BarcodeDetector, scanState: state });
  }, chain.txs.payment);
  await page.goto("/regtest/");
  const dialog = await openScanner(page);
  await expect(dialog.getByRole("status")).toHaveText("Hold the code inside the frame.");
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a picture" }).click();
  await chooser;
  await page.evaluate(() => {
    (window as unknown as { scanState: { pickerOpen: boolean } }).scanState.pickerOpen = true;
  });
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as unknown as { scanState: { frames: number } }).scanState.frames,
      ),
    )
    .toBeGreaterThan(3);
  await expect(page).toHaveURL("/regtest/");
  // The picker closed with nothing chosen, as the browser says with `cancel`.
  await dialog.locator('input[type="file"]').dispatchEvent("cancel");
  await expect(page).toHaveURL(`/regtest/tx/${chain.txs.payment}`);
});

test.describe("when jsQR does not download at first", () => {
  test.use({ consoleErrorsAllowed: [/status of 503/] });

  test("the camera stops reading and says so, and a picture whose reader loads restarts it", async ({
    page,
  }) => {
    let fail = true;
    await page.route(/\/assets\/jsQR-[^/]+\.js$/, async (route) =>
      fail ? route.fulfill({ status: 503, body: "" }) : route.continue(),
    );
    await page.goto("/regtest/");
    const dialog = await openScanner(page);
    await expect(dialog.getByRole("status")).toHaveText(/The code reader did not load/);
    await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
    fail = false;
    // A file that is no picture: the reader loads for it, and the camera reads its code again.
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose a picture" }).click();
    await (
      await chooser
    ).setFiles({ name: "not.png", mimeType: "image/png", buffer: Buffer.alloc(0) });
    await expect(page).toHaveURL(`/regtest/address/${chain.addresses.p2wpkh}`);
  });
});

test.describe("a second picker while a picture is read", () => {
  // The camera's frames find one transaction once a picture is chosen; the picture's read is held
  // until the test lets it go, and then finds `picture` (nothing when null).
  async function standIn(page: Page, picture: string | null) {
    await page.addInitScript(
      ({ fromCamera, fromPicture }) => {
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const state = { picked: false, frames: 0, release: () => release?.() };
        function BarcodeDetector() {
          return {
            detect: async (source: unknown) => {
              if (source instanceof ImageBitmap) {
                state.picked = true;
                await held;
                return fromPicture === null ? [] : [{ rawValue: fromPicture }];
              }
              if (state.picked) state.frames += 1;
              return state.picked ? [{ rawValue: fromCamera }] : [];
            },
          };
        }
        BarcodeDetector.getSupportedFormats = () => Promise.resolve(["qr_code"]);
        Object.assign(window, { BarcodeDetector, scanState: state });
      },
      { fromCamera: chain.txs.payment, fromPicture: picture },
    );
  }
  const frames = async (page: Page) =>
    page.evaluate(() => (window as unknown as { scanState: { frames: number } }).scanState.frames);
  const release = async (page: Page) =>
    page.evaluate(() => {
      (window as unknown as { scanState: { release: () => void } }).scanState.release();
    });
  async function pickTwice(page: Page) {
    await page.goto("/regtest/");
    const dialog = await openScanner(page);
    await expect(dialog.getByRole("status")).toHaveText("Hold the code inside the frame.");
    let chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose a picture" }).click();
    await (
      await chooser
    ).setFiles({ name: "code.png", mimeType: "image/png", buffer: qrPng("any") });
    await expect(dialog.getByRole("status")).toHaveText("Reading the picture…");
    chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose a picture" }).click();
    await chooser;
    return dialog;
  }

  test("the first finding nothing leaves the camera waiting on the open picker", async ({
    page,
  }) => {
    await standIn(page, null);
    const dialog = await pickTwice(page);
    await release(page);
    await expect(dialog.getByRole("status")).toHaveText(/No QR code found/);
    const before = await frames(page);
    await expect.poll(async () => frames(page)).toBeGreaterThan(before + 3);
    await expect(page).toHaveURL("/regtest/");
    await dialog.locator('input[type="file"]').dispatchEvent("cancel");
    await expect(page).toHaveURL(`/regtest/tx/${chain.txs.payment}`);
  });

  test("cancelling the second leaves the camera waiting on the first", async ({ page }) => {
    await standIn(page, chain.txs.consolidation);
    const dialog = await pickTwice(page);
    await dialog.locator('input[type="file"]').dispatchEvent("cancel");
    const before = await frames(page);
    await expect.poll(async () => frames(page)).toBeGreaterThan(before + 3);
    await expect(page).toHaveURL("/regtest/");
    await release(page);
    await expect(page).toHaveURL(`/regtest/tx/${chain.txs.consolidation}`);
  });
});
