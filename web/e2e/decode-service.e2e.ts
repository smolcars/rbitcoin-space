// The decoder asking the service a pasted LNURL or Lightning address names (docs/FRONTEND.md
// "Decoder"): from the browser, never through our server, stubbed here with `page.route`. Each
// answer, each failure, and the policy that lets the call through but no script from elsewhere.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { ANSWERS, serveDecode } from "./decode-answers";
import { pageFaults } from "./lightning-answers";

const SERVICE = "https://pay.example.com/lnurlp/coffee";
const CORS = { "access-control-allow-origin": "*" };

const PAY = {
  tag: "payRequest",
  callback: "https://pay.example.com/cb",
  minSendable: 1000,
  maxSendable: 21_000_000_000,
  metadata: JSON.stringify([
    ["text/plain", "A cup of coffee"],
    ["text/identifier", "coffee@pay.example.com"],
  ]),
  commentAllowed: 140,
};

/** The decoder answers an LNURL pointing at `SERVICE`; the service is `service`. */
async function stub(
  page: Page,
  service: (route: Parameters<Parameters<Page["route"]>[1]>[0]) => Promise<void> | void,
) {
  await serveDecode(page, () => ({
    ...ANSWERS["lnurl"],
    url: SERVICE,
    host: "pay.example.com",
    tag: null,
  }));
  await page.route(SERVICE, service);
}

const open = async (page: Page) => {
  await page.goto("/decode#LNURL1EXAMPLE");
  await expect(page.getByRole("heading", { level: 3, name: "From the service" })).toBeVisible();
};

test("a pay answer: what it takes, its words as text, and only the one GET", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1")) asked.push(`${r.method()} ${r.url()}`);
  });
  await stub(page, (route) => route.fulfill({ json: PAY, headers: CORS }));
  await open(page);
  await expect(page.getByText("A cup of coffee")).toBeVisible();
  await expect(page.locator("main")).toContainText("Takes1 – 21\u202F000\u202F000 sats");
  await expect(page.locator("main")).toContainText("up to 140 characters");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await pageFaults(page), `${width} px`).toStrictEqual([]);
  }
  // Never the callback: one GET of the service, nothing else outside this site.
  expect(asked).toStrictEqual([`GET ${SERVICE}`]);
});

test("a withdraw answer, and a callback on another host", async ({ page }) => {
  await stub(page, (route) =>
    route.fulfill({
      json: {
        tag: "withdrawRequest",
        callback: "https://elsewhere.example/w",
        k1: "ab",
        minWithdrawable: 0,
        maxWithdrawable: 5_000_000,
        defaultDescription: "Prize",
      },
      headers: CORS,
    }),
  );
  await open(page);
  await expect(page.locator("main")).toContainText("KindWithdraw");
  await expect(page.locator("main")).toContainText("Gives0 – 5 000 sats");
  await expect(page.getByText("Other host")).toBeVisible();
});

test("the service's refusal is its reason, as text", async ({ page }) => {
  await stub(page, (route) =>
    route.fulfill({ json: { status: "ERROR", reason: "<b>No such user</b>" }, headers: CORS }),
  );
  await open(page);
  await expect(page.getByText("Refused: <b>No such user</b>")).toBeVisible();
  await expect(page.locator("main b")).toHaveCount(0);
});

test.describe("failing", () => {
  // The browser logs a refused cross-origin answer and a cancelled one: the test causes both.
  test.use({ consoleErrorsAllowed: [/pay\.example\.com|CORS|Failed to fetch|ERR_/i] });

  test("a service that does not answer in time", async ({ page }) => {
    await stub(page, () => undefined);
    await open(page);
    await expect(page.getByText("No answer from pay.example.com in time")).toBeVisible({
      timeout: 12_000,
    });
  });

  test("a redirect is not followed: one request, never the callback", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith("http://127.0.0.1")) asked.push(r.url());
    });
    await stub(page, (route) =>
      route.fulfill({
        status: 302,
        headers: { ...CORS, location: "https://pay.example.com/cb?amount=1000" },
      }),
    );
    await open(page);
    await expect(page.getByText("Could not ask pay.example.com")).toBeVisible();
    expect(asked).toStrictEqual([SERVICE]);
  });

  test("a service the browser does not let the page ask", async ({ page }) => {
    // A stand-in's answer skips the browser's cross-origin check, so the refusal is simulated.
    await stub(page, (route) => route.abort("blockedbyresponse"));
    await open(page);
    await expect(page.getByText("Could not ask pay.example.com")).toBeVisible();
    await expect(page.getByText("Why")).toBeVisible();
  });
});

test("the policy lets the page ask HTTPS services, and nothing else past this site", async ({
  page,
}) => {
  const res = await page.goto("/decode");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self';");
  expect(csp).toContain("connect-src 'self' https:;");
  expect(csp).not.toMatch(/(script|style|font|img|frame)-src/);
});

// A script from another origin is still refused: the violation fails the test, as it should.
test.fail("a script from another origin is refused on the decoder's page", async ({ page }) => {
  await page.goto("/decode");
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.src = "https://pay.example.com/x.js";
    document.head.append(s);
  });
  await page.waitForTimeout(500);
});
