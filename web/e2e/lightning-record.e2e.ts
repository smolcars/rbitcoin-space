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
  await serve(page, { ...mainnet(), [`nodes/${ONE}/channels?status=closed`]: CLOSED, ...answers });
  await page.goto(`/regtest/lightning/node/${key}?view=closed`);
  await expect(page.getByRole("heading", { name: "Close record" })).toBeVisible();
  await expect(page.locator(".ln-record .state--loading")).toHaveCount(0);
}

const LOOKS = [
  [1280, "light"],
  [1280, "dark"],
  [360, "light"],
  [360, "dark"],
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
  await expect(record).toContainText("Since 12 Nov 2026");
  await expect(record).toContainText("68%");
  await expect(record).toContainText("all 8.8%");
  await expect(record).toContainText(
    "Its 25 force closes were with 25 different peers, at most 1 with any one.",
  );
  await expect(record).toContainText("not which end or why");
  await expect(record.locator(".ln-record__part").last().locator("tbody tr")).toHaveCount(10);
  await record.getByRole("button", { name: "Show the other 15 peers" }).click();
  await expect(record.locator(".ln-record__part").last().locator("tbody tr")).toHaveCount(25);
  // No tone that reads as a verdict.
  await expect(record.locator(".ln-tag:not(.ln-tag--muted)")).toHaveCount(0);
  // A peer leads to the node's closes with it.
  await expect(record.locator(".ln-record__part").last().getByRole("link").first()).toHaveAttribute(
    "href",
    /view=closed&peer=0200dc/,
  );
  await holds(page);
  if (SHOTS) await record.screenshot({ path: `${SHOTS}/e2e-acinq.png` });
});

test("a record with penalties names them and says the record does not say by which end", async ({
  page,
}) => {
  await open(page, ACINQ, { [`nodes/${ACINQ}/closes`]: withPenalties() });
  const record = page.locator(".ln-record");
  await expect(record).toContainText("the record does not say by which end");
  await expect(record).toContainText(
    "Its 22 force closes and 3 penalties were with 25 different peers",
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
  test("shows its record under the page that says so", async ({ page }) => {
    const gone = `02${"ab".repeat(32)}`;
    await serve(page, { ...mainnet(), [`nodes/${gone}/closes`]: { ...few(), id: gone } });
    await page.route(new RegExp(`/regtest/app/lightning/nodes/${gone}$`), (r) =>
      r.fulfill({ status: 404, json: { error: "node not found" } }),
    );
    await page.goto(`/regtest/lightning/node/${gone}`);
    await expect(page.getByText("This server knows no such node")).toBeVisible();
    await expect(page.locator(".ln-record")).toContainText("3 channels closed");
    await holds(page);
  });
});
