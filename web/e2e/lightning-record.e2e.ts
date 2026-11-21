// A node's close record (docs/FRONTEND.md "Lightning pages"), from answers: regtest has no
// Lightning history. Mainnet's recorded answer (ACINQ, 79 closes in 8 days), the same with
// penalties (no server has seen one yet), a node with too few closes for a share, one with none,
// and one that left the graph, each at a desktop's and a phone's width in both themes.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { ACINQ, mainnet, ONE, pageFaults, recorded, serve } from "./lightning-answers";
import { frames } from "./layout";

type Answer = Record<string, unknown> & {
  node: Record<string, unknown> & { closed: number };
  peers: { list: Record<string, unknown>[]; forced: number };
};
const acinq = (): Answer => recorded("node-acinq-closes") as Answer;

/** ACINQ's record with three of its force closes found to be breaches, with two peers. */
function withPenalties(): Answer {
  const a = acinq();
  a.node = {
    ...a.node,
    force: 22,
    penalty: 3,
    shares: { cooperative: 68.4, force: 27.8, penalty: 3.8, other: 0 },
  };
  a.peers.list = a.peers.list.map((p, i) =>
    i === 0
      ? { ...p, force: 0, penalty: 2, closed: 2 }
      : i === 1
        ? { ...p, force: 0, penalty: 1 }
        : p,
  );
  return a;
}

/** A small node's record: three closes, under the minimum for a share. */
function few(): Answer {
  const a = acinq();
  const weeks = (a.node["weeks"] as Record<string, number>[]).map((w, i) =>
    Object.assign(w, {
      cooperative: i === 0 ? 1 : 0,
      force: i === 0 ? 0 : 1,
      penalty: 0,
      other: i === 0 ? 0 : 1,
    }),
  );
  a["id"] = ONE;
  a.node = {
    ...a.node,
    closed: 3,
    cooperative: 1,
    force: 1,
    penalty: 0,
    other: 1,
    shares: null,
    fees: {
      cooperative: { sum: 300, known: 1 },
      force: { sum: 1_200, known: 1 },
      penalty: { sum: 0, known: 0 },
      other: { sum: 0, known: 0 },
    },
    weeks,
  };
  a.peers = { ...a.peers, forced: 1, list: a.peers.list.slice(0, 1) };
  return a;
}

function none(): Answer {
  const a = few();
  const zero = { sum: 0, known: 0 };
  a.node = {
    ...a.node,
    closed: 0,
    cooperative: 0,
    force: 0,
    other: 0,
    fees: { cooperative: zero, force: zero, penalty: zero, other: zero },
    weeks: (a.node["weeks"] as Record<string, number>[]).map((w) =>
      Object.assign(w, { cooperative: 0, force: 0, other: 0 }),
    ),
  };
  a.peers = { count: 0, forced: 0, list: [], more: 0 } as unknown as Answer["peers"];
  return a;
}

const CLOSED = {
  status: "closed",
  page: 0,
  per_page: 25,
  total: 0,
  sort: "closed",
  dir: "desc",
  channels: [],
};

async function open(page: Page, key: string, answers: Record<string, unknown>) {
  const recordedClosed = recorded("node-acinq-closed") as { channels: unknown[] };
  // The closed list filtered to the record's first peer, as following its link asks.
  const onePeer = { ...recordedClosed, total: 1, channels: recordedClosed.channels.slice(0, 1) };
  await serve(page, {
    ...mainnet(),
    [`nodes/${ONE}/channels?status=closed`]: CLOSED,
    [`nodes/${ACINQ}/channels?status=closed&peer=0200dc8f9e63a75f803f52866fb6ad0095d2473a1d22164b819eda90f06954dd97`]:
      onePeer,
    ...answers,
  });
  await page.goto(`/regtest/lightning/node/${key}?view=closed`);
  await expect(page.getByRole("heading", { name: "Close record" })).toBeVisible();
  await expect(page.locator(".ln-record .state--loading")).toHaveCount(0);
}

// In the wide stand-in font (fixtures.ts), as fonts.e2e.ts holds every page: these states come
// from routed answers, so they are not in its sweep, and a record that only just fits in this
// machine's font scrolled on CI's.
test.use({ prose: "wide" });

const LOOKS = [
  [1280, "light"],
  [1280, "dark"],
  [390, "dark"],
  [360, "light"],
  [360, "dark"],
  [320, "light"],
] as const;

async function holds(page: Page) {
  for (const [width, scheme] of LOOKS) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await frames(page);
    expect(await pageFaults(page, ".ln-record"), `${width} px, ${scheme}`).toStrictEqual([]);
    // Every column the record's tables need, whole, also on a phone: nothing scrolls sideways.
    for (const t of await page.locator(".ln-record .table-scroll, .ln-record .table").all()) {
      const over = await t.evaluate((e) => e.scrollWidth - e.clientWidth);
      expect(over, `${width} px, ${scheme}: a record table scrolls`).toBeLessThanOrEqual(1);
    }
  }
}

const SHOTS = process.env["E2E_SHOTS"];

test("mainnet's record: shares beside every channel's, fees, weeks and peers, at every look", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, ACINQ, {});
  const record = page.locator(".ln-record");
  await expect(record).toContainText("79 channels closed in the 8 days this server has watched");
  // The record's start, and as of when every channel's figures were worked out.
  await expect(record).toContainText(
    "Since 12 Nov 2026; all channels as of 21 Nov 2026, 00:14 UTC",
  );
  await expect(record).toContainText("68%");
  await expect(record).toContainText("all 8.8%");
  await expect(record).toContainText(
    "The 25 force closes were on channels with 25 different peers, at most 1 with any one.",
  );
  await expect(record).toContainText("not which end or why");
  await expect(record.locator(".ln-record__part").last().locator("tbody tr")).toHaveCount(10);
  await record.getByRole("button", { name: "Show the other 15 peers" }).click();
  await expect(record.locator(".ln-record__part").last().locator("tbody tr")).toHaveCount(25);
  // No tone that reads as a verdict.
  await expect(record.locator(".ln-tag:not(.ln-tag--muted)")).toHaveCount(0);
  await holds(page);
  if (SHOTS) await record.screenshot({ path: `${SHOTS}/e2e-acinq.png` });
  // A peer leads to the node's closes with it: followed, the closed list asks for that peer's.
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/channels?")) asked.push(new URL(r.url()).search);
  });
  await record.locator(".ln-record__part").last().getByRole("link").first().click();
  await expect(page).toHaveURL(/view=closed&peer=0200dc/);
  await expect(page.locator("[aria-labelledby=ln-node-closed-title]")).toContainText(
    /1\s+of 34 closes match/,
  );
  expect(asked.some((q) => q.includes("peer=0200dc"))).toBe(true);
});

test("a record with penalties names them and says the record does not say by which end", async ({
  page,
}) => {
  await open(page, ACINQ, { [`nodes/${ACINQ}/closes`]: withPenalties() });
  const record = page.locator(".ln-record");
  await expect(record).toContainText("the record does not say by which end");
  await expect(record).toContainText(
    "The 22 force closes and 3 penalties were on channels with 25 different peers",
  );
  await expect(record.getByRole("columnheader", { name: "Penalty", exact: true })).toHaveCount(2);
  await holds(page);
  if (SHOTS) {
    for (const [width, scheme] of LOOKS) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await frames(page);
      await record.screenshot({ path: `${SHOTS}/e2e-penalties-${width}-${scheme}.png` });
    }
  }
});

test("too few closes for a share: counts, and why", async ({ page }) => {
  await open(page, ONE, { [`nodes/${ONE}/closes`]: few() });
  const record = page.locator(".ln-record");
  await expect(record).toContainText(
    "Shares are given from 20 closes; with 3, the counts say more",
  );
  await expect(record.getByRole("columnheader", { name: /All channels/ }).first()).toBeVisible();
  await expect(record).not.toContainText("this node, then all");
  await holds(page);
});

test("a node with no close says so in one line", async ({ page }) => {
  await open(page, ONE, { [`nodes/${ONE}/closes`]: none() });
  const record = page.locator(".ln-record");
  await expect(record).toContainText(
    "None of its channels closed in the 8 days this server has watched.",
  );
  await expect(record.locator("table")).toHaveCount(0);
  await holds(page);
});

test.describe("a node that left the graph", () => {
  // Its node answer is a 404, which the browser logs.
  test.use({ consoleErrorsAllowed: [/status of 404/] });
  test("shows its record under the page that says so, its peers leading to their own pages", async ({
    page,
  }) => {
    const gone = `02${"ab".repeat(32)}`;
    const left = `03${"cd".repeat(32)}`;
    const record = few();
    // Two other ends: one the graph holds, which has a page; one that has left too.
    record.peers = {
      ...record.peers,
      forced: 2,
      list: [
        { ...record.peers.list[0], id: ONE, alias: "FUNK-BTCPay", held: true },
        { ...record.peers.list[0], id: left, alias: "gone too", held: false },
      ],
    };
    await serve(page, { ...mainnet(), [`nodes/${gone}/closes`]: { ...record, id: gone } });
    await page.route(new RegExp(`/regtest/app/lightning/nodes/${gone}$`), (r) =>
      r.fulfill({ status: 404, json: { error: "node not found" } }),
    );
    await page.goto(`/regtest/lightning/node/${gone}`);
    await expect(page.getByText("This server knows no such node")).toBeVisible();
    await expect(page.locator(".ln-record")).toContainText("3 channels closed");
    await holds(page);
    const peers = page.locator(".ln-record .ln-record__part").last();
    await expect(peers.getByRole("link")).toHaveCount(1);
    await expect(peers).toContainText("gone too");
    await expect(page.locator(".ln-record")).not.toContainText("Filter its closed channels");
    await peers.getByRole("link", { name: "FUNK-BTCPay" }).click();
    await expect(page).toHaveURL(new RegExp(`/regtest/lightning/node/${ONE}$`));
    await expect(page.getByRole("heading", { name: "At a glance" })).toBeVisible();
  });
});

/** Every channel's penalty share under 0.1%: one penalty in 1,802 closes, as mainnet could see. */
function tinyShare(): Answer {
  const a = withPenalties();
  const network = a["network"] as Record<string, unknown> & { shares: Record<string, number> };
  a["network"] = {
    ...network,
    penalty: 1,
    closed: 1_803,
    shares: { ...network.shares, penalty: 0 },
  };
  return a;
}

test("a share under 0.1% parts between its words and fits a 320 px phone", async ({ page }) => {
  await open(page, ACINQ, { [`nodes/${ACINQ}/closes`]: tinyShare() });
  await expect(page.locator(".ln-record")).toContainText("all under 0.1%");
  // Only the figure is a figure: the words round it are outside `.num`.
  await expect(page.locator(".ln-record .num", { hasText: "under" })).toHaveCount(0);
  await holds(page);
});

test("a column left out and the note that says so are never out of step, at any width or text size", async ({
  page,
}) => {
  await open(page, ACINQ, { [`nodes/${ACINQ}/closes`]: withPenalties() });
  const parts = page.locator(".ln-record .ln-record__part");
  const pairs = [
    { part: parts.nth(1), header: "All channels" },
    { part: parts.nth(2), header: "Open now" },
  ];
  const faults: string[] = [];
  const seen = new Set<string>();
  // The breakpoint is in em: the standard text size stays at 16 px, so it stays at 640 px.
  for (const size of [14, 20, 28]) {
    // A minimum font size, as a reader sets one: small text grows, the layout's widths do not.
    // No test can set the browser's own, so the page's small sizes are raised to it instead.
    await page.evaluate((px) => {
      document.documentElement.style.setProperty("--text-xs", `${px}px`);
      document.documentElement.style.setProperty("--text-sm", `${px}px`);
    }, size);
    // Phone widths too, where the breakpoint hides the column: the note must show there as well.
    for (const width of [320, 360, 660, 720, 800, 900, 1040]) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page);
      for (const { part, header } of pairs) {
        // The table fits in the frame after a resize notice; wait until it has.
        await part.locator(".table-scroll").evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const shown = await part.getByRole("columnheader", { name: header }).isVisible();
        const note = await part.locator(".ln-record__phone").isVisible();
        seen.add(shown ? "shown" : "left out");
        if (shown === note)
          faults.push(`${size} px text, ${width} px: ${header} shown ${shown}, note ${note}`);
      }
    }
  }
  expect(faults).toStrictEqual([]);
  // Both cases happened, or the test proved nothing.
  expect(seen.has("left out") && seen.has("shown"), [...seen].join(", ")).toBe(true);
});
