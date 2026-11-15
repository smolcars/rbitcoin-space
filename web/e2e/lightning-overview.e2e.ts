// The Lightning overview for operators (docs/DESIGN.md "Lightning"): every state real data lacks,
// stubbed (a penalty and an `other` close, a burst with `more`, no totals a week back, empty movers,
// a route refusing while the others answer), the live feed played over the page's own socket,
// keyboard use of every control, and the layout at a phone's and a desktop's widths and large text.
// The whole sweep of widths and text sizes runs with E2E_SWEEP=1, as fonts.e2e.ts does.
import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mainnet, pageFaults, recorded, serve } from "./lightning-answers";

const T = 1_794_780_000;
const keyOf = (n: number) => `02${n.toString(16).padStart(64, "0")}`;
/** Names made to break a row: 32 bytes of one wide letter, right to left, emoji, none. */
const NAMES = [
  "﷽﷽﷽﷽﷽﷽﷽﷽﷽﷽",
  "عقدةالبرقالسريعة‮",
  "⚡🐙🦀⚡🐙🦀⚡🐙",
  null,
  "0256ccca46170ff4b1ef0256ccca4617",
];
const node = (n: number) => ({ id: keyOf(n), alias: NAMES[n % NAMES.length] ?? null });
const fees = (fee_rate: number, base: number, inbound: number | null) => ({
  fee_rate,
  base_fee_msat: base,
  inbound_fee: inbound === null ? null : { base_fee_msat: 0, fee_rate: inbound },
});
const base = (n: number, time: number) => ({
  time,
  id: `${975_000 + n}x${1000 + n}x1`,
  scid: String(1_072_000_000_000 + n),
  capacity: n % 3 === 0 ? 1_000_000_000 : 16_777_215,
  node_one: node(n),
  node_two: node(n + 1),
});
const opened = (n: number) => ({ ...base(n, T - n * 60), event: "opened", height: 975_000 + n });
const closed = (n: number, kind: string) => ({ ...opened(n), event: "closed", kind });
const fee = (n: number, before: unknown, after: unknown) => ({
  ...base(n, T - n * 30),
  event: "fee",
  by: n % 2 === 0 ? "node_one" : "node_two",
  before,
  after,
});

/** The snapshot: every kind, the longest figures a policy holds. */
const RECENT = [
  opened(1),
  closed(2, "penalty"),
  closed(3, "other"),
  closed(4, "force"),
  closed(5, "cooperative"),
  fee(6, fees(4_294_967_295, 0, null), fees(0, 0, null)),
  fee(7, fees(100, 0, null), fees(100, 4_294_967_295, null)),
  fee(8, fees(100, 0, -2_147_483_648), fees(100, 0, 2_147_483_647)),
  fee(9, fees(100, 0, 0), fees(100, 0, null)),
];
/** A burst that fills the list: 40 fee changes, and 23 more the server left out. */
const BURST = Array.from({ length: 40 }, (_, i) =>
  fee(100 + i, fees(1_000 + i, 1_000, null), fees(1_200 + i, 1_000, null)),
);

function overview() {
  const o = recorded("overview") as { statistics: Record<string, number> } & Record<
    string,
    unknown
  >;
  const s = o.statistics;
  const then = {
    ...s,
    // A day ago: channels rose, capacity fell, nodes held, the fee rate rose, and the base fee
    // fell by the longest figure a change writes.
    channels: (s["channels"] ?? 0) - 300,
    capacity: (s["capacity"] ?? 0) + 99_000_000_000,
    med_fee_rate: (s["med_fee_rate"] ?? 0) - 12,
    med_base_fee_msat: (s["med_base_fee_msat"] ?? 0) + 1_234_567_890,
  };
  return { ...o, before: { "24h": then, "1w": null, "1m": null } };
}

const mover = (n: number, capacity: number, channels: number) => ({
  ...node(n),
  capacity_change: capacity,
  channels_change: channels,
  capacity: 2_100_000_000_000_000,
  channels: 99_999,
});
const MOVERS = {
  period: "1w",
  from: T - 7 * 86_400,
  time: T,
  capacity_up: Array.from({ length: 10 }, (_, i) => mover(i, 2_000_000_000_000 - i, 9_999)),
  capacity_down: Array.from({ length: 10 }, (_, i) => mover(i + 1, -2_000_000_000_000 + i, -9_999)),
  channels_up: Array.from({ length: 10 }, (_, i) => mover(i + 2, 1, 9_999 - i)),
  channels_down: Array.from({ length: 10 }, (_, i) => mover(i + 3, -1, -9_999 + i)),
  new: Array.from({ length: 10 }, (_, i) => ({ ...mover(i, 1, 1), time: T - i * 7200 })),
  left: Array.from({ length: 10 }, (_, i) => ({
    ...mover(i + 4, -1, -99),
    alias: null,
    time: T - i * 9000,
  })),
};
const EMPTY = {
  ...MOVERS,
  period: "24h",
  capacity_up: [],
  capacity_down: [],
  channels_up: [],
  channels_down: [],
  new: [],
  left: [],
};

function closes() {
  const c = recorded("closes-30") as { days: Record<string, number>[] } & Record<string, unknown>;
  const days = c.days.map((d, i) => ({ ...d, penalty: i === 28 ? 2 : 0, other: i === 29 ? 1 : 0 }));
  return { ...c, days };
}

const answers = (more: Record<string, unknown> = {}) => ({
  ...mainnet(),
  overview: overview(),
  "statistics/24h": { ...(recorded("statistics-1w") as object), interval: "24h" },
  "movers?period=1w": MOVERS,
  "movers?period=24h": { ...MOVERS, period: "24h" },
  "closes?days=30": closes(),
  ...more,
});

/**
 * Plays the server's part of the `lightning-feed` topic on the page's own socket, the rest of it
 * passed through: the snapshot on subscribe, and what `send` pushes later.
 */
async function liveFeed(page: Page): Promise<(m: unknown) => void> {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/app\/ws$/, (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      server.send(m);
      if (typeof m === "string" && m.includes('"lightning-feed"') && m.includes('"subscribe"'))
        ws.send(JSON.stringify({ topic: "lightning-feed", type: "recent", events: RECENT }));
    });
  });
  return (m) => socket?.send(JSON.stringify({ topic: "lightning-feed", ...(m as object) }));
}

/** Two frames, so what a resize redraws (the chart, the tables' dropped columns) has redrawn. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );

async function open(page: Page, path = "/regtest/lightning") {
  await page.goto(path);
  await expect(page.locator(".ln-feed li")).toHaveCount(RECENT.length);
  await expect(page.getByRole("table", { name: /^Nodes by capacity/ })).toBeVisible();
  await expect(page.getByRole("slider", { name: /Lightning channels/ })).toBeVisible();
}

test("the overview draws every state at a desktop's and a phone's width, light and dark", async ({
  page,
}) => {
  await serve(page, answers({ "movers?period=24h": EMPTY }));
  const send = await liveFeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  // No totals a week back: the figures, no change.
  const now = page.locator("[aria-labelledby=ln-now-title]");
  await expect(now).not.toContainText("↑");
  // A burst lands at once, the list held to 30 rows with a line for what it left out.
  send({ type: "events", events: BURST, more: 23 });
  await expect(page.locator(".ln-feed li")).toHaveCount(30);
  await expect(page.locator(".ln-feed")).toContainText("and 34 more in this batch, not listed");
  await page.getByRole("button", { name: "Closes" }).click();
  await expect(page.locator(".ln-feed li")).toHaveCount(4);
  await expect(page.locator(".ln-feed")).toContainText("Penalty");
  await expect(page.locator(".ln-feed")).toContainText("Other close");
  await page.getByRole("button", { name: "All" }).click();
  for (const [width, scheme] of [
    [1280, "light"],
    [1280, "dark"],
    [390, "dark"],
    [390, "light"],
    [320, "light"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    expect(await pageFaults(page), `${width} px, ${scheme}`).toStrictEqual([]);
  }
  // A day's period: its change, and movers that moved nothing.
  await page.getByRole("link", { name: /^24 h/ }).click();
  await expect(now).toContainText("↓ Down 990.00 BTC");
  await expect(page.locator("[aria-labelledby=ln-movers-title]")).toContainText(
    "No change in this period",
  );
  expect(await pageFaults(page), "24 h at 320 px").toStrictEqual([]);
});

test.describe("a route that refuses", () => {
  test.use({ consoleErrorsAllowed: [/status of 503/] });
  test("shows the section that could not load as such, and the rest of the page", async ({
    page,
  }) => {
    await serve(page, answers());
    await page.route(/\/app\/lightning\/movers/, (route) =>
      route.fulfill({ status: 503, json: { error: "still syncing" } }),
    );
    await liveFeed(page);
    // The page asks again for about a minute before it says so: the clock runs that minute.
    await page.clock.install();
    await page.goto("/regtest/lightning");
    await expect(page.locator(".ln-feed li")).toHaveCount(RECENT.length);
    await page.clock.runFor(90_000);
    await expect(page.locator("[aria-labelledby=ln-movers-title]")).toContainText(
      "The server is busy for a moment",
    );
    await expect(page.getByRole("heading", { name: "Closes by kind" })).toBeVisible();
    await expect(page.getByRole("slider", { name: /Lightning channels/ })).toBeVisible();
  });
});

test("every control works from the keyboard, and a focused one survives a batch", async ({
  page,
}) => {
  await serve(page, answers());
  const send = await liveFeed(page);
  const movers: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/movers")) movers.push(r.url());
  });
  await open(page);
  const press = async (name: string | RegExp) => {
    const b = page.getByRole("button", { name, exact: true });
    await b.focus();
    await page.keyboard.press("Enter");
    await expect(b).toHaveAttribute("aria-pressed", "true");
  };
  await press("Channels");
  await press("Lost");
  await press("Either way");
  await expect(page.getByRole("table", { name: /^Nodes by channels moved/ })).toBeVisible();
  expect(movers).toHaveLength(1);
  await press("Fee changes");
  await press("All");
  await page.getByRole("button", { name: "Pause", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeFocused();
  await expect(page.locator(".ln-live")).toHaveText("Paused");
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  // Focus in the list holds what arrives; the focused link stays where it is.
  const link = page.locator(".ln-feed a").first();
  await link.focus();
  send({ type: "events", events: BURST.slice(0, 2), more: 0 });
  await expect(page.locator(".ln-live")).toHaveText("Paused, 2 waiting");
  await page.waitForTimeout(1100);
  await expect(link).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".ln-live")).toHaveText("Live");
  await expect(page.locator(".ln-feed li")).toHaveCount(RECENT.length + 2);
  // The period is a link: Enter follows it, and the chart asks for that period.
  await page.getByRole("link", { name: /^24 h/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/interval=24h/);
});

const SWEEP = process.env["E2E_SWEEP"] === "1";
const WIDTHS = SWEEP ? [320, 390, 768, 1024, 1280, 1440] : [320, 390, 1024];
const TEXT = SWEEP ? [16, 20, 24, 32] : [20, 32];

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const text of TEXT) {
    test(`nothing scrolls sideways or parts from its unit with ${text} px text`, async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "only Chromium lets a test set the text size");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.setFontSizes", {
        fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
      });
      await serve(page, answers());
      const send = await liveFeed(page);
      await page.setViewportSize({ width: 390, height: 844 });
      // A day: every total with its change, and the movers' newest nodes and those that left.
      await open(page, "/regtest/lightning?interval=24h");
      const now = page.locator("[aria-labelledby=ln-now-title]");
      for (const change of ["↑ Up 300", "No change", "↓ Down 990.00 BTC", "↑ Up 12 ppm"])
        await expect(now).toContainText(change);
      await expect(now).toContainText(/↓ Down 1\u202F234\u202F567\u202F890 msat/);
      await expect(page.getByRole("table", { name: "Newest nodes" })).toBeVisible();
      send({ type: "events", events: BURST, more: 23 });
      await expect(page.locator(".ln-feed li")).toHaveCount(30);
      const faults: string[] = [];
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 844 });
        await settle(page);
        for (const f of await pageFaults(page)) faults.push(`${width} px: ${f}`);
      }
      expect(faults).toStrictEqual([]);
    });
  }
});
