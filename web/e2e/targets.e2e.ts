// Every control a finger can use is a thumb's target (docs/DESIGN.md "Touch"): on every page type,
// at a phone's widths on a touch screen, each offers at least 44 by 44 px that a tap there reaches,
// measured by what the browser finds under the finger, so a neighbour drawn over it takes its share
// away. Pop-ups are opened and their controls measured too.
import { expect, test } from "./fixtures";
import { PAGES } from "./pages";
import { smallTargets } from "./targets";

// A touch screen: `(pointer: coarse)` gives the controls their targets. Firefox has no mobile
// emulation, only touch.
test.use({
  hasTouch: true,
  ...(process.env["E2E_ENGINE"] === "firefox" ? {} : { isMobile: true }),
  // Each width is a resize of one loaded page (as in fonts.e2e.ts).
  consoleErrorsAllowed: [/status of (429|503)|due to access control checks/],
});

for (const { path, stub } of PAGES) {
  test(`${path}: every control is a thumb's target at a phone's widths`, async ({ page }) => {
    await stub?.(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("main [aria-busy='true'], main .skel")).toHaveCount(0, {
      timeout: 15_000,
    });
    const faults: string[] = [];
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const f of await smallTargets(page, "body")) faults.push(`${width} px: ${f}`);
    }
    // An exact amount's pop-up, where the page has one.
    const exact = page.locator("main button[data-exact]").first();
    if ((await exact.count()) > 0) {
      await exact.scrollIntoViewIfNeeded();
      await exact.tap();
      await expect(page.locator(".exact:not([hidden])")).toBeVisible();
      for (const f of await smallTargets(page, ".exact:not([hidden])", false)) {
        faults.push(`its exact amount: ${f}`);
      }
    }
    expect(faults).toStrictEqual([]);
  });
}
