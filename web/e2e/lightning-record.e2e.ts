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
  // The peers' closes add up to the node's: 23 force closes and 3 penalties, all with a peer.
  a.node = {
    ...a.node,
    cooperative: 53,
    force: 23,
    penalty: 3,
    shares: { cooperative: 67.1, force: 29.1, penalty: 3.8, other: 0 },
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
    // Settled: nothing is added and no column comes or goes over the next frames.
    const shape = () =>
      page.evaluate(() => ({
        nodes: document.querySelectorAll("*").length,
        columns: [...document.querySelectorAll(".ln-record th")].filter((h) => h.checkVisibility())
          .length,
      }));
    const settled = await shape();
    await frames(page);
    await frames(page);
    expect(await shape(), `${width} px, ${scheme}: the record keeps changing`).toStrictEqual(
      settled,
    );
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
  // Said once, under the first force figure.
  await expect(record.getByText("in both nodes' records")).toHaveCount(1);
  // The count leads past the record to the list, and the keyboard carries on from its heading.
  // An in-page link: the router leaves it alone, so it is not announced as the current page.
  await expect(record.getByRole("link", { name: "79 channels" })).not.toHaveAttribute(
    "aria-current",
  );
  await record.getByRole("link", { name: "79 channels" }).click();
  await expect(page.locator("#ln-node-closed-title")).toBeFocused();
  // Every peer has one force close: rows that each say 1 wait behind a press.
  await expect(record.locator(".ln-record__part").last().locator("tbody tr")).toHaveCount(0);
  const top = (selector: string) =>
    record.locator(selector).evaluate((e) => Math.round(e.getBoundingClientRect().top + scrollY));
  const before = [await top(".ln-record__part--fees"), await top(".ln-record__weeks")];
  await record.getByRole("button", { name: "Show the 25 peers" }).click();
  await expect(record.locator(".ln-record__part").last().locator("tbody tr")).toHaveCount(25);
  // Shown on a wide screen, the peers take the panel's width, three across, and nothing above
  // them moves: no column of the record left blank beside a long list.
  const panel = await record.boundingBox();
  const peers = await record.locator(".ln-record__peers").boundingBox();
  expect((peers?.width ?? 0) / (panel?.width ?? 1)).toBeGreaterThan(0.9);
  const tops = await record
    .locator(".ln-record__peers tbody tr")
    .evaluateAll(
      (rows) =>
        new Set(rows.slice(0, 3).map((r) => Math.round(r.getBoundingClientRect().top))).size,
    );
  expect(tops).toBe(1);
  expect([await top(".ln-record__part--fees"), await top(".ln-record__weeks")]).toStrictEqual(
    before,
  );
  // As many across as the record's own width holds, at a tablet's width too, down to the
  // single column; with larger text, fewer. Opening them moves nothing above, and settles.
  const across = () =>
    record.locator(".ln-record__peers tbody tr").evaluateAll((rows) => {
      const first = rows[0]?.getBoundingClientRect().top ?? 0;
      return rows.filter((r) => Math.round(r.getBoundingClientRect().top) === Math.round(first))
        .length;
    });
  for (const [width, size, least, most] of [
    [768, 16, 2, 2],
    [1024, 16, 3, 3],
    [1280, 16, 4, 4],
    [768, 24, 1, 1],
    [1280, 24, 2, 2],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((px) => {
      document.documentElement.style.fontSize = `${px}px`;
    }, size);
    await frames(page);
    const n = await across();
    expect(n, `${width} px, ${size} px text`).toBeGreaterThanOrEqual(least);
    expect(n, `${width} px, ${size} px text`).toBeLessThanOrEqual(most);
    const scrolls = await record
      .locator(".table-scroll")
      .evaluateAll((ts) => ts.filter((t) => t.scrollWidth > t.clientWidth + 1).length);
    expect(scrolls, `${width} px, ${size} px text`).toBe(0);
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await frames(page);
  // Folded back none would show, so the button says it hides them all.
  await expect(record.getByRole("button", { name: "Hide the 25 peers" })).toBeVisible();
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
    "The 23 force closes and 3 penalties were on channels with 25 different peers",
  );
  await expect(record.getByRole("columnheader", { name: "Penalty", exact: true })).toHaveCount(2);
  // The peer with two is listed; the 24 with one each are a press away.
  await expect(record.locator(".ln-record__part").last().locator("tbody tr")).toHaveCount(1);
  await expect(
    record.getByRole("button", { name: "Show the 24 peers with one each" }),
  ).toBeVisible();
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
  // The record in a line beside every channel's shares, the tables a press away.
  await expect(record.locator(".ln-record__kinds li")).toHaveCount(3);
  await expect(record).toContainText("All channels: 91% cooperative, 8.8% force, 0.3% other.");
  await expect(record.locator("table").first()).toBeHidden();
  // Opened by the check of every look (pageFaults opens every disclosure in the record).
  await holds(page);
  await expect(record.getByRole("columnheader", { name: /All channels/ }).first()).toBeVisible();
  await expect(record).not.toContainText("this node, then all");
  // Beside a node's counts, every channel's share is a figure with no bar to read as the node's.
  await expect(record.locator(".ln-record__bar")).toHaveCount(0);
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
  test("shows its record and its closed channels under its key, its peers filtering them", async ({
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
    // Its closed list answers from the store, as for any node: three closes, one with FUNK-BTCPay.
    const closed = recorded("node-acinq-closed") as { channels: unknown[] };
    await serve(page, {
      ...mainnet(),
      [`nodes/${gone}/closes`]: { ...record, id: gone },
      [`nodes/${gone}/channels?status=closed`]: {
        ...closed,
        total: 3,
        channels: closed.channels.slice(0, 3),
      },
      [`nodes/${gone}/channels?status=closed&peer=${ONE}`]: {
        ...closed,
        total: 1,
        channels: closed.channels.slice(0, 1),
      },
    });
    await page.route(new RegExp(`/regtest/app/lightning/nodes/${gone}$`), (r) =>
      r.fulfill({ status: 404, json: { error: "node not found" } }),
    );
    await page.goto(`/regtest/lightning/node/${gone}`);
    // Headed by its key, not "no such node" over the record that shows the server knows it.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("02ababab…ababab");
    await expect(page.getByText("It has no open channel now")).toBeVisible();
    await expect(page.getByText("This server knows no such node")).toHaveCount(0);
    await expect(page.locator(".ln-record")).toContainText("3 channels closed");
    // The closes the heading promises, listed under the record.
    const list = page.locator("[aria-labelledby=ln-node-closed-title]");
    await expect(list).toContainText("3 closes");
    // The check of every look opens the breakdown.
    await holds(page);
    await page.getByRole("button", { name: "Show the 2 peers" }).click();
    const peers = page.locator(".ln-record .ln-record__part").last();
    // Both peers filter its list, whether or not the graph still holds them.
    await expect(peers.getByRole("link")).toHaveCount(2);
    await peers.getByRole("link", { name: "FUNK-BTCPay" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/regtest/lightning/node/${gone}\\?view=closed&peer=${ONE}$`),
    );
    await expect(list).toContainText(/1\s+of 3 closes match/);
  });
});

test("on a phone the weeks and the peers open folded to their sentences, and unfold", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, ACINQ, {});
  const folds = page.locator(".ln-record details.ln-record__fold");
  await expect(folds).toHaveCount(2);
  for (const fold of await folds.all()) await expect(fold).not.toHaveAttribute("open");
  await expect(folds.nth(0)).toContainText("2 weeks from 9 Nov 2026, at most");
  await expect(folds.nth(1)).toContainText("The 25 force closes were on channels with 25");
  await expect(page.getByRole("button", { name: "Show the 25 peers" })).toBeHidden();
  await folds.nth(1).locator("summary").click();
  await expect(page.getByRole("button", { name: "Show the 25 peers" })).toBeVisible();
  await holds(page);
});

test("at 320 and 360 px with 16, 24 and 32 px text no record table scrolls and no word breaks", async ({
  page,
}) => {
  await open(page, ACINQ, { [`nodes/${ACINQ}/closes`]: withPenalties() });
  const faults: string[] = [];
  for (const width of [320, 360]) {
    for (const size of [16, 24, 32]) {
      await page.setViewportSize({ width, height: 800 });
      // The root size, as a reader's larger text sets it: every rem and em on the page grows.
      await page.evaluate((px) => {
        document.documentElement.style.fontSize = `${px}px`;
        for (const d of document.querySelectorAll(".ln-record details")) d.setAttribute("open", "");
      }, size);
      const more = page.locator(".ln-record").getByRole("button", { name: /^Show the/ });
      if (await more.isVisible()) await more.click();
      await frames(page);
      const found = await page.evaluate(() => {
        const record = document.querySelector(".ln-record") as HTMLElement;
        const out: string[] = [];
        for (const t of record.querySelectorAll(".table-scroll")) {
          if (t.scrollWidth > t.clientWidth + 1)
            out.push(`a table scrolls ${t.scrollWidth - t.clientWidth} px`);
        }
        // A word drawn on two lines: names and keys may break, a word or a figure never does.
        const walk = document.createTreeWalker(record, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const el = n.parentElement;
          if (el === null || el.closest(".visually-hidden, .ln-key, .ln-alias")) continue;
          for (const m of (n.textContent ?? "").matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            const tops = new Set(
              [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
            );
            if (tops.size > 1) out.push(`"${m[0]}" breaks`);
          }
        }
        return out;
      });
      faults.push(...found.map((f) => `${width} px, ${size} px text: ${f}`));
      // Where the fees are cards, every channel's figure carries its unit and denominator in
      // words that show only there: "All channels: 546 sats a close".
      const unit = await page.locator(".ln-record__part--fees").evaluate((part) => {
        const cards =
          getComputedStyle(part.querySelector("thead") as Element).position === "absolute";
        const words = [...part.querySelectorAll(".ln-record__card")];
        // Said once: not the heading's label before the words that already name it.
        const label = [...part.querySelectorAll("tbody td:nth-child(3)")].some(
          (td) => getComputedStyle(td, "::before").content !== "none",
        );
        return (
          !cards ||
          (!label && words.length > 0 && words.every((w) => getComputedStyle(w).display !== "none"))
        );
      });
      if (!unit) faults.push(`${width} px, ${size} px text: a fee card without its unit`);
    }
  }
  expect(faults).toStrictEqual([]);
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

test("a figure a column leaves out is its row's second line, never both and never neither, at any width or text size", async ({
  page,
}) => {
  await open(page, ACINQ, { [`nodes/${ACINQ}/closes`]: withPenalties() });
  const parts = page.locator(".ln-record .ln-record__part");
  const triples = [
    { part: parts.nth(1), name: "fees", header: "All channels" },
    { part: parts.nth(2), name: "weeks", header: "All channels" },
    { part: parts.nth(3), name: "peers", header: "Open now" },
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
    // Phone widths too, where the breakpoint hides the column: the figure must show there as well.
    for (const width of [320, 360, 660, 720, 800, 900, 1040, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page);
      for (const { part, name, header } of triples) {
        // The table fits in the frame after a resize notice; wait until it has.
        await part.locator(".table-scroll").evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const shown = await part.getByRole("columnheader", { name: header }).isVisible();
        const second = await part.locator(".ln-record__second").first().isVisible();
        seen.add(shown ? "shown" : "left out");
        if (shown === second)
          faults.push(
            `${size} px text, ${width} px, ${name}: ${header} shown ${shown}, second line ${second}`,
          );
      }
    }
  }
  expect(faults).toStrictEqual([]);
  // Both cases happened, or the test proved nothing.
  expect(seen.has("left out") && seen.has("shown"), [...seen].join(", ")).toBe(true);
});
