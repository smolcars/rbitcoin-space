// The Lightning penalties list (docs/FRONTEND.md "Lightning pages"), from stubbed answers: real
// servers have seen few penalties or none. A full page and the empty one at a desktop's and a
// phone's width, light and dark; keyboard use, from the overview's link to the second page; and
// the layout on a touch screen with hostile names at each text size, a test a size. The whole sweep
// of widths runs with E2E_SWEEP=1.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mainnet, pageFaults, penalties, serve } from "./lightning-answers";
import { frames } from "./layout";

const FULL = { penalties: penalties(25, 30), "penalties?page=1": penalties(5, 30, 1) };
const EMPTY = { penalties: penalties(0) };

async function open(page: Page, answers: Record<string, unknown>) {
  await serve(page, { ...mainnet(), ...answers });
  await page.goto("/regtest/lightning/penalties");
  await expect(page.getByRole("heading", { name: "Revoked states swept" })).toBeVisible();
}

const LOOKS = [
  [1280, "light"],
  [1280, "dark"],
  [390, "dark"],
  [390, "light"],
  [320, "light"],
] as const;

test("a full list draws at a desktop's and a phone's width, light and dark", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, FULL);
  await expect(page.getByRole("table", { name: /Revoked states swept/ })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await expect(page.locator("main")).toContainText("30 seen on chain");
  await expect(page.locator(".pagination")).toContainText("Page 1 of 2");
  // The longest a sweep is watched, and a name of 32 bytes of one wide letter, whole in its title.
  await expect(page.locator("tbody tr").first()).toContainText("2 016");
  await expect(page.locator("bdi[title^='﷽']").first()).toBeVisible();
  for (const [width, scheme] of LOOKS) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await frames(page);
    if (width < 640) await expect(page.locator(".ln-node-card")).toHaveCount(25);
    expect(await pageFaults(page), `${width} px, ${scheme}`).toStrictEqual([]);
  }
});

test("with none, one line says so and since when", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, EMPTY);
  const section = page.locator("[aria-labelledby=ln-pen-title]");
  await expect(section).toContainText(
    "None seen since 21 Sep 2026, when this server began watching.",
  );
  await expect(section.locator("table, ol, .pagination, .section__meta")).toHaveCount(0);
  for (const [width, scheme] of LOOKS) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await frames(page);
    expect(await pageFaults(page), `${width} px, ${scheme}`).toStrictEqual([]);
  }
});

test("from the overview's link to the second page, all from the keyboard", async ({ page }) => {
  await serve(page, { ...mainnet(), ...FULL });
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/app/lightning/penalties")) asked.push(new URL(r.url()).search);
  });
  await page.goto("/regtest/lightning");
  const link = page.getByRole("link", { name: "Penalties", exact: true });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/regtest\/lightning\/penalties$/);
  await expect(page.locator("tbody tr")).toHaveCount(25);
  const next = page.getByRole("button", { name: "Next" });
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/penalties\?page=2$/);
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(page.locator(".pagination")).toContainText("Page 2 of 2");
  // Back steps to the first page, already answered once.
  await page.goBack();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  expect(asked.slice(0, 2)).toStrictEqual(["", "?page=1"]);
  // A row's own link is the keyboard stop that opens its channel.
  await page.locator("tbody a.ln-id").first().focus();
  await expect(page.locator("tbody a.ln-id").first()).toBeFocused();
});

const SWEEP = process.env["E2E_SWEEP"] === "1";
const WIDTHS = SWEEP ? [320, 390, 768, 1024, 1280, 1440] : [320, 390, 1024];

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const text of [16, 20, 24, 32]) {
    test(`hostile names and long figures hold at ${text} px text`, async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "only Chromium lets a test set the text size");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.setFontSizes", {
        fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
      });
      await page.setViewportSize({ width: 320, height: 800 });
      await open(page, FULL);
      await expect(page.locator(".ln-node-card")).toHaveCount(25);
      const faults: string[] = [];
      // One visitor resizing, as a reader turns a phone or drags a window.
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await frames(page);
        for (const f of await pageFaults(page)) faults.push(`${width} px: ${f}`);
      }
      expect(faults).toStrictEqual([]);
    });
  }
});
