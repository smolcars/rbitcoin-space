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

/** Waits two frames, for a resize to reach the page or a script that just arrived to draw. */
async function twoFrames(page: Page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  });
}

/**
 * The pop-up fits inside the window, scrollbar excluded, once its opening animation has run: the
 * animation scales it, and it was once placed from that smaller box.
 */
async function inWindow(page: Page) {
  const dialog = page.getByRole("dialog");
  const box = await dialog.evaluate(async (d) => {
    await Promise.all(d.getAnimations().map(async (a) => a.finished));
    const r = d.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      clientWidth,
      clientHeight,
    };
  });
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.clientWidth);
  expect(box.bottom).toBeLessThanOrEqual(box.clientHeight);
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

test("at 320 px with motion on, the pop-up opens inside the window and stays there", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 320, height: 650 });
  await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
  await page.getByRole("button", { name: "Show the address as a QR code" }).click();
  await expect(page.getByRole("dialog", { name: "Scan the address" })).toBeVisible();
  await inWindow(page);
  // A shorter window: it moves and shrinks to stay inside, scrolling within itself.
  await page.setViewportSize({ width: 320, height: 350 });
  await twoFrames(page);
  await inWindow(page);
  // The code gets about 4 px a module even here (Qr.css).
  const card = await page.locator(".qr__card").evaluate((c) => c.getBoundingClientRect().width);
  expect(card).toBeGreaterThanOrEqual(296);
});

test("the card paints nothing inside the code's quiet zone", async ({ page }) => {
  await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
  await page.getByRole("button", { name: "Show the address as a QR code" }).click();
  const card = page.getByRole("dialog").locator(".qr__card");
  await expect(card).toBeVisible();
  // The code's quiet zone is drawn inside the card: no inset rule, border or outline crosses it.
  await expect(card).toHaveCSS("box-shadow", "none");
  await expect(card).toHaveCSS("border-top-width", "0px");
  await expect(card).toHaveCSS("outline-style", "none");
  const fills = await card.evaluate((c) => {
    const svg = c.querySelector("svg")?.getBoundingClientRect();
    const box = c.getBoundingClientRect();
    return svg && Math.abs(svg.width - box.width) < 1 && Math.abs(svg.height - box.height) < 1;
  });
  expect(fills).toBe(true);
});

test.describe("when the QR code's files fail", () => {
  test.use({ consoleErrorsAllowed: [/status of 503/] });

  test("the page stays, the button says so, and a second press loads it", async ({ page }) => {
    await page.route(/\/assets\/QrPop-[^/]+\.js$/, (route) =>
      route.fulfill({ status: 503, body: "" }),
    );
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    const button = page.getByRole("button", { name: "Show the address as a QR code" });
    await button.click();
    const failed = page.getByRole("button", { name: /The QR code could not be loaded/ });
    await expect(failed).toBeVisible();
    await expect(page.getByText("Not loaded")).toBeVisible();
    // Nothing else on the page went: no "Loading this page", the copy button still there.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Address");
    await expect(page.getByRole("button", { name: "Copy address" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.unrouteAll();
    await failed.click();
    await expect(page.getByRole("dialog", { name: "Scan the address" })).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("when the QR code's files are slow", () => {
  test.use({ consoleErrorsAllowed: [/status of 503/] });

  /**
   * Holds the pop-up's script (or stylesheet) back until the returned function lets it through,
   * or, given a status, answers it with that.
   */
  async function hold(page: Page, kind: "js" | "css" = "js"): Promise<(status?: number) => void> {
    let release: ((status?: number) => void) | undefined;
    const gate = new Promise<number | undefined>((resolve) => {
      release = resolve;
    });
    await page.route(new RegExp(`/assets/QrPop-[^/]+\\.${kind}$`), async (route) => {
      const status = await gate;
      await (status === undefined ? route.continue() : route.fulfill({ status, body: "" }));
    });
    return (status) => release?.(status);
  }

  test("Escape gives up waiting, and the late file opens nothing", async ({ page }) => {
    const release = await hold(page);
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    const button = page.getByRole("button", { name: "Show the address as a QR code" });
    const arrived = page.waitForResponse(/\/assets\/QrPop-[^/]+\.js$/);
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-busy", "false");
    release();
    await arrived;
    // Two frames for anything the arrival would have drawn.
    await twoFrames(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(button).toBeFocused();
    // It is there for the next press.
    await button.click();
    await expect(page.getByRole("dialog", { name: "Scan the address" })).toBeVisible();
  });

  test("a reader who tabs away keeps their place when the file arrives", async ({ page }) => {
    const release = await hold(page);
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    const button = page.getByRole("button", { name: "Show the address as a QR code" });
    const arrived = page.waitForResponse(/\/assets\/QrPop-[^/]+\.js$/);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Tab");
    const moved = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
    release();
    await arrived;
    await twoFrames(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))).toBe(moved);
    await expect(button).toHaveAttribute("aria-busy", "false");
  });

  test("a click away while it loads gives up, even where focus falls to the page", async ({
    page,
  }) => {
    const release = await hold(page);
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    const button = page.getByRole("button", { name: "Show the address as a QR code" });
    const arrived = page.waitForResponse(/\/assets\/QrPop-[^/]+\.js$/);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-busy", "true");
    // Blank space above the page's main part: nothing there takes focus, so it falls to the page.
    await page.getByText("Regtest is a test network").click();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await expect(button).toHaveAttribute("aria-busy", "false");
    release();
    await arrived;
    await twoFrames(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  test("a press cancelled while its stylesheet failed asks for it again", async ({ page }) => {
    const release = await hold(page, "css");
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    const button = page.getByRole("button", { name: "Show the address as a QR code" });
    const asked: string[] = [];
    page.on("request", (r) => {
      if (/\/assets\/QrPop-[^/]+\.css$/.test(r.url())) asked.push(r.url());
    });
    const failed = page.waitForResponse(/\/assets\/QrPop-[^/]+\.css$/);
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-busy", "false");
    release(503);
    await failed;
    await twoFrames(page);
    await page.unrouteAll();
    const before = asked.length;
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Scan the address" });
    await expect(dialog).toBeVisible();
    // Styled: fixed over the page, its stylesheet asked for again.
    await expect(dialog).toHaveCSS("position", "fixed");
    expect(asked.length).toBeGreaterThan(before);
  });

  test("cancelled waits leave no listeners behind", async ({ page, browserName }) => {
    // Chromium alone lists a node's listeners (its DevTools protocol).
    test.skip(browserName !== "chromium", "needs the DevTools protocol");
    await hold(page);
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    const cdp = await page.context().newCDPSession(page);
    // Only the shell group's, where the button lives (vite.config.ts): Playwright's clicks and the
    // page's chart add listeners of their own, on their own schedule.
    const urls = new Map<string, string>();
    cdp.on("Debugger.scriptParsed", (e) => urls.set(e.scriptId, e.url));
    await cdp.send("Debugger.enable");
    const listeners = async () => {
      const { result } = await cdp.send("Runtime.evaluate", { expression: "document" });
      const { listeners: all } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId ?? "",
      });
      return all.filter(
        (l) =>
          ["keydown", "pointerdown", "focusin"].includes(l.type) &&
          (urls.get(l.scriptId) ?? "").includes("/assets/app-"),
      ).length;
    };
    const button = page.getByRole("button", { name: "Show the address as a QR code" });
    const cycle = async () => {
      await button.click();
      await expect(button).toHaveAttribute("aria-busy", "true");
      await page.keyboard.press("Escape");
      await expect(button).toHaveAttribute("aria-busy", "false");
    };
    const baseline = await listeners();
    for (let i = 0; i < 3; i++) await cycle();
    expect(await listeners()).toBe(baseline);
    // Leaving the page while one waits removes its listeners too.
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await page.getByRole("link", { name: "Blocks" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blocks");
    expect(await listeners()).toBe(baseline);
  });
});
