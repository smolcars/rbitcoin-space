// The node page for its operator (docs/DESIGN.md "Lightning"), from mainnet's recorded answers:
// its lists sorted, filtered and paged by the server, at a desktop's and a phone's width, light
// and dark, and at 320 px with 200% text. Its own file so CI's sharding puts it on the lightest
// shard (docs/CI.md "Browser test shards").
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  ACINQ,
  I32_MAX,
  I32_MIN,
  mainnet,
  ONE,
  pageFaults,
  recorded,
  serve,
  tablesScrolling,
} from "./lightning-answers";
import { frames } from "./layout";
import { tablesFit } from "./rows";

type Row = Record<string, unknown> & { peer: Record<string, unknown> };
type Answer = Record<string, unknown> & { channels: Row[]; total: number };
type NodeAnswer = Record<string, unknown> & {
  open_channels: Answer;
  channels: Record<string, number>;
};

const node = () => recorded("node-acinq") as NodeAnswer;
const closed = () => recorded("node-acinq-closed") as Answer;

/**
 * Serves mainnet's answers, and every page of ACINQ's channels from `list`, which sees the
 * request's parameters. Returns the parameters asked, in order.
 */
async function serveLists(
  page: Page,
  list: (q: URLSearchParams) => Answer,
  answers: Record<string, unknown> = {},
): Promise<string[]> {
  await serve(page, { ...mainnet(), ...answers });
  const asked: string[] = [];
  // Registered after `serve`, so it answers first.
  await page.route(new RegExp(`/regtest/app/lightning/nodes/${ACINQ}/channels\\?`), (r: Route) => {
    const q = new URL(r.request().url()).searchParams;
    asked.push(q.toString());
    return r.fulfill({ json: list(q) });
  });
  return asked;
}

/** The node's first page, its rows in another order or kept by `keep`, its total `total`. */
const pageOf = (q: URLSearchParams, keep: (r: Row) => boolean = () => true): Answer => {
  const first = node().open_channels;
  // An inbound discount on every other row's own fee, a surcharge on every third row's peer fee.
  const inbound = (p: unknown, fee_rate: number) =>
    p === null ? null : { ...(p as object), inbound_fee: { base_fee_msat: -1000, fee_rate } };
  const rows = first.channels
    .map((r, i) => ({
      ...r,
      own_policy: i % 2 === 0 ? inbound(r["own_policy"], -200) : r["own_policy"],
      peer_policy: i % 3 === 0 ? inbound(r["peer_policy"], 150) : r["peer_policy"],
    }))
    .filter((r) => keep(r));
  return {
    ...first,
    sort: q.get("sort") ?? "capacity",
    dir: q.get("dir") ?? "desc",
    channels: q.get("sort") === null ? rows : rows.map((r, i) => rows.at(-1 - i) ?? r),
    total: rows.length === first.channels.length ? first.total : rows.length,
  };
};

/** Each phone card's lines: text in one line box, whatever its font, counts once. */
const cardLines = (page: Page, n: number) =>
  page.locator(".ln-node-card").evaluateAll(
    (cards, count) =>
      cards.slice(0, count).map((card) => {
        const tops: number[] = [];
        const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(t);
          for (const r of range.getClientRects()) if (r.width > 0) tops.push(r.top);
        }
        tops.sort((a, b) => a - b);
        return tops.filter((t, i) => i === 0 || t - (tops[i - 1] ?? 0) > 8).length;
      }),
    n,
  );

test("its channels sort by a header on a desktop and by the picker on a phone, in three-line cards", async ({
  page,
}) => {
  const asked = await serveLists(page, (q) => pageOf(q));
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/regtest/lightning/node/${ACINQ}`);
    const table = page.getByRole("table", { name: /Its open channels/ });
    await expect(table.locator("th[aria-sort]")).toHaveAttribute("aria-sort", "descending");
    await expect(table.locator("th[aria-sort]")).toContainText("Capacity");
    await table.getByRole("button", { name: /^Fee out/ }).click();
    await expect(page).toHaveURL(/\?sort=out$/);
    await expect(table.locator("th[aria-sort]")).toContainText("Fee out");
    await expect(table.locator("th[aria-sort]")).toHaveAttribute("aria-sort", "ascending");
    await expect(table).toHaveAccessibleName(/sorted by fee out, this node, lowest first$/);
    expect(await pageFaults(page), `1440 px, ${colorScheme}`).toStrictEqual([]);
    // The back button steps back through the sort.
    await page.goBack();
    await expect(table.locator("th[aria-sort]")).toContainText("Capacity");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".ln-node-card").first()).toBeVisible();
    // Each choice worded for what it sorts, its own way first.
    const picker = page.getByRole("combobox", { name: "Sort" });
    await expect(picker.locator("option")).toHaveText([
      "Capacity, largest first",
      "Capacity, smallest first",
      "Age, oldest first",
      "Age, youngest first",
      "Fee out, this node, lowest first",
      "Fee out, this node, highest first",
      "Fee in, the peer, lowest first",
      "Fee in, the peer, highest first",
      "CLTV delta, this node, lowest first",
      "CLTV delta, this node, highest first",
      "Max HTLC, this node, largest first",
      "Max HTLC, this node, smallest first",
      "Last policy update, newest first",
      "Last policy update, oldest first",
      "Peer's total capacity, largest first",
      "Peer's total capacity, smallest first",
    ]);
    await picker.selectOption({ label: "Age, oldest first" });
    await expect(page).toHaveURL(/\?sort=age$/);
    expect(await pageFaults(page), `390 px, ${colorScheme}`).toStrictEqual([]);
    // Three lines a card: the peer and channel, the fee each way, then size, state and age.
    expect(await cardLines(page, 25), `390 px, ${colorScheme}`).toStrictEqual(
      Array.from({ length: 25 }, () => 3),
    );
    await page.setViewportSize({ width: 320, height: 844 });
    const narrow = await cardLines(page, 25);
    expect(Math.max(...narrow), `320 px: ${narrow.join(" ")}`).toBeLessThanOrEqual(4);
  }
  expect(asked).toStrictEqual(["sort=out", "sort=age", "sort=out", "sort=age"]);
});

test("every filter, the back button through views, and a filter that matches nothing", async ({
  page,
}) => {
  const asked = await serveLists(page, (q) =>
    pageOf(q, (r) => {
      if (q.get("q") === "zzz") return false;
      if (q.has("peer")) return r.peer["id"] === q.get("peer");
      return true;
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/regtest/lightning/node/${ACINQ}`);
  const total = page.locator(".ln-node-total");
  await expect(total).toHaveText("1 803 open channels");
  // The node's answer holds its first page and when its policies changed: no list is asked,
  // `?sort=update` included.
  await expect(page.getByText(/^Policies updated/)).toBeVisible();
  expect(asked).toStrictEqual([]);

  await page.getByRole("link", { name: /^Off here/ }).click();
  await expect(page).toHaveURL(/\?state=here$/);
  await expect(page.getByRole("link", { name: /^Off here/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(total).toContainText("of 1 803 open channels match");

  // A peer from its row: the bar says who, and that it can be dropped.
  const peer = page.getByRole("link", { name: "bfx-lnd0" }).first();
  await peer.click();
  await expect(page).toHaveURL(/peer=033d8656/);
  await expect(page.locator(".ln-node-peerbar")).toContainText("bfx-lnd0");

  // Text waits for a pause, then asks once.
  await page.getByRole("searchbox").fill("zzz");
  await expect(page.getByText("No channel matches these filters")).toBeVisible();
  expect(asked.filter((a) => a.includes("q="))).toHaveLength(1);

  // From the fee rates, a bar opens the channels it counts.
  await page.getByRole("link", { name: "Fees", exact: true }).click();
  await page.getByRole("link", { name: /where it charges 200–499 ppm/ }).click();
  await expect(page).toHaveURL(/\?fee=out:200$/);
  await expect(total.getByText("It charges 200–499 ppm")).toBeVisible();
  expect(asked.at(-1)).toBe("fee=out%3A200-400");

  // Back through the views and forward again.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "In figures" })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("No channel matches these filters")).toBeVisible();
  await page.goForward();
  await page.goForward();
  await expect(total.getByText("It charges 200–499 ppm")).toBeVisible();
  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(new RegExp(`/node/${ACINQ}$`));
});

/** Every bitcoin there is, in sats: the largest capacity or fee a figure can show. */
const ALL_SATS = 2_100_000_000_000_000;
/** The largest a policy's 32-bit fields can hold: its rate (ppm) and base fee (msat). */
const U32 = 4_294_967_295;

/**
 * The node at the edges: peers with names made to break a layout (32 bytes unspaced, right to
 * left, emoji), and every figure a row can hold at its longest: all bitcoin as capacity, the
 * largest rate, base fee, delay and limit a policy can advertise, a close that paid all bitcoin.
 */
function extremes(): Record<string, unknown> {
  const names = ["0256ccca46170ff4b1ef0256ccca4617", "عقدةالبرقالسريعة", "⚡🐙🦀⚡🐙🦀⚡🐙"];
  const n = node();
  const c = closed();
  const policy = (p: unknown, i = 0) => ({
    ...(p as object),
    fee_rate: U32,
    base_fee_msat: U32,
    cltv_delta: 65_535,
    max_htlc_msat: ALL_SATS * 1000,
    // The longest inbound fees: the most negative, and the largest surcharge.
    inbound_fee:
      i % 2 === 0
        ? { base_fee_msat: I32_MIN, fee_rate: I32_MIN }
        : { base_fee_msat: I32_MAX, fee_rate: I32_MAX },
  });
  const open = n.open_channels.channels.map((r, i) => ({
    ...r,
    capacity: ALL_SATS - i,
    funded: 1_231_006_505,
    peer: { ...r.peer, alias: names[i % 3], capacity: ALL_SATS, channels: 99_999 },
    own_policy: policy(r["own_policy"], i),
    peer_policy: policy(r["peer_policy"], i + 1),
  }));
  const shut = c.channels.map((r, i) => ({
    ...r,
    capacity: ALL_SATS - i,
    funded: 1_231_006_505,
    peer: { ...r.peer, alias: names[i % 3] },
    closed: { ...(r["closed"] as object), fee: ALL_SATS },
  }));
  const figures = n["figures"] as Record<string, unknown>;
  const rates = { median: U32, weighted: U32, lowest: U32, highest: U32, policies: 99_999 };
  const history = recorded("node-acinq-history") as { from: number; points: object[] };
  return {
    [`nodes/${ACINQ}`]: {
      ...n,
      alias: names[0],
      capacity: ALL_SATS,
      figures: {
        ...figures,
        capacity: { median: ALL_SATS, smallest: ALL_SATS, largest: ALL_SATS },
        fee_rates: { outgoing: rates, incoming: rates },
      },
      fees: {
        outgoing: [{ bucket: 4_294_967_000, count: 99_999, capacity: ALL_SATS }],
        incoming: [{ bucket: 0, count: 99_999, capacity: ALL_SATS }],
      },
      open_channels: { ...n.open_channels, total: 99_999, channels: open },
    },
    [`nodes/${ACINQ}/channels?sort=htlc`]: { ...n.open_channels, sort: "htlc", channels: open },
    [`nodes/${ACINQ}/channels?status=closed`]: { ...c, channels: shut },
    // Ten changes with hostile names: the largest rates, and a base fee and an inbound fee moving
    // at their longest while the rate holds.
    [`nodes/${ACINQ}/fees`]: {
      changes: Array.from({ length: 10 }, (_, i) => {
        const fees = (fee_rate: number, base_fee_msat: number, inbound: number | null) => ({
          fee_rate,
          base_fee_msat,
          inbound_fee: inbound === null ? null : { base_fee_msat: inbound, fee_rate: inbound },
        });
        const kind = i % 3;
        return {
          id: "4294967295x4294967295x65535".slice(0, 27 - (i % 4)),
          scid: "18446744073709551615",
          peer: { id: n.open_channels.channels[i]?.peer["id"], alias: names[i % 3] },
          whose: i % 2 === 0 ? "own" : "peer",
          time: 1_231_006_505 + i,
          before: kind === 0 ? fees(U32, 0, null) : fees(1, kind === 1 ? U32 : 0, null),
          after: kind === 0 ? fees(0, 0, null) : fees(1, 0, kind === 2 ? I32_MIN : null),
        };
      }),
    },
    [`nodes/${ACINQ}/history`]: {
      ...history,
      // A fresh copy of the recording each call: its points are this answer's own.
      points: history.points.map((p) => Object.assign(p, { channels: 99_999, capacity: ALL_SATS })),
    },
  };
}

/** Every view, and the list sorted by a figure its cards add (the limit). */
const VIEWS = ["channels", "channels&sort=htlc", "closed", "fees", "history"];
const SWEEP = process.env["E2E_SWEEP"] === "1";
/** `E2E_SPARE=0.05`: every letter that many em wider, to prove the room the layout leaves. */
const SPARE = Number(process.env["E2E_SPARE"] ?? "0");
/** Phone widths; with `E2E_SWEEP=1`, every 40 px from 320 to 1440 as well. */
const WIDTHS = SWEEP ? Array.from({ length: 29 }, (_, i) => 320 + i * 40) : [320, 390];

/** The filter's hint, as wide as the page sets it, against the room its field gives it. */
const hintCut = (page: Page) =>
  page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>("input.ln-node-input");
    if (!field || field.getClientRects().length === 0) return null;
    const hint = getComputedStyle(field, "::placeholder");
    const own = getComputedStyle(field);
    const ruler = document.createElement("span");
    ruler.textContent = field.placeholder;
    ruler.style.setProperty("position", "absolute");
    ruler.style.setProperty("white-space", "pre");
    ruler.style.setProperty("font", hint.font);
    ruler.style.setProperty("font-family", own.fontFamily);
    document.body.append(ruler);
    const need = ruler.getBoundingClientRect().width;
    ruler.remove();
    const room =
      field.clientWidth - Number.parseFloat(own.paddingLeft) - Number.parseFloat(own.paddingRight);
    return need > room ? `the filter's hint needs ${Math.ceil(need)} px of ${room}` : null;
  });

// A figure never parts from its unit and nothing runs past its box at any text size, in the
// reader's fonts (`E2E_PROSE`): a test a size, each a visitor of its own. On a touch screen, as a
// phone is: there a field's text keeps the page's size (global.css).
test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });
  for (const text of [16, 20, 24, 32]) {
    test(`at ${text} px text, the longest figures and hostile names hold on every view`, async ({
      page,
      browserName,
    }) => {
      test.skip(
        browserName !== "chromium",
        "only Chromium lets a test set the browser's text size",
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.setFontSizes", {
        fontSizes: { standard: text, fixed: Math.round((text * 13) / 16) },
      });
      await serve(page, { ...mainnet(), ...extremes() });
      const faults: string[] = [];
      // Each view loaded once and resized through the widths, as a reader turns a phone or drags a
      // window: a load a width would be one visitor asking more than the server serves one.
      for (const view of VIEWS) {
        await page.setViewportSize({ width: WIDTHS[0] ?? 320, height: 800 });
        await page.goto(`/regtest/lightning/node/${ACINQ}?view=${view}`);
        await expect(page.getByRole("heading", { name: "At a glance" })).toBeVisible();
        await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
        if (view === "history") await expect(page.getByRole("slider")).toBeVisible();
        if (SPARE > 0)
          // The page's own text: the shell round it is not this page's to hold.
          await page.evaluate((em) => {
            document.querySelector("main")?.style.setProperty("letter-spacing", `${em}em`);
          }, SPARE);
        const toggle = page.locator(".ln-node-card__toggle").first();
        if (await toggle.isVisible()) await toggle.click();
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 800 });
          await frames(page);
          const found = [
            ...(await pageFaults(page)),
            ...(await tablesScrolling(page, ".ln-recent")),
          ];
          faults.push(...found.map((f) => `${width} px, ${view}: ${f}`));
          const cut = await hintCut(page);
          if (cut !== null) faults.push(`${width} px, ${view}: ${cut}`);
        }
      }
      expect(faults).toStrictEqual([]);
    });
  }
});

/** The recorded close record, as one close of each kind. */
function everyKind(): Record<string, unknown> {
  const r = recorded("node-acinq-closes") as Record<string, unknown> & {
    node: Record<string, unknown>;
  };
  return {
    ...r,
    node: { ...r.node, closed: 4, cooperative: 1, force: 1, penalty: 1, other: 1, shares: null },
  };
}

test("a node with one channel, one with no policy, and closes of every kind", async ({ page }) => {
  const n = node();
  const none = (r: Row): Row => ({ ...r, own_policy: null, peer_policy: null, fee_rate: null });
  const figures = n["figures"] as Record<string, unknown>;
  const row = closed().channels[0] as Row;
  const close = (kind: string, id: string, continued: string | null): Row => ({
    ...row,
    id,
    closed: { ...(row["closed"] as object), kind },
    continued_as: continued,
  });
  await serve(page, {
    ...mainnet(),
    [`nodes/${ACINQ}`]: {
      ...n,
      channels: { ...n.channels, closed: 4, cooperative: 1, force: 1, penalty: 1, other: 1 },
      // The server's answer for a way with no policy.
      figures: {
        ...figures,
        fee_rates: Object.fromEntries(
          ["outgoing", "incoming"].map((w) => [
            w,
            { median: null, weighted: null, lowest: null, highest: null, policies: 0 },
          ]),
        ),
      },
      fees: { outgoing: [{ bucket: null, count: 1803, capacity: 1 }], incoming: [] },
      open_channels: { ...n.open_channels, channels: n.open_channels.channels.map(none) },
    },
    // Its close record agrees with its answer, as the server's do: the list takes its counts by
    // kind from the record where it holds every close.
    [`nodes/${ACINQ}/closes`]: everyKind(),
    [`nodes/${ACINQ}/channels?status=closed`]: {
      ...closed(),
      total: 4,
      channels: [
        close("cooperative", "900000x1x0", null),
        close("force", "900000x2x0", null),
        close("penalty", "900000x3x0", null),
        close("other", "900000x4x0", "975402x1310x1"),
      ],
    },
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/regtest/lightning/node/${ONE}`);
  await expect(page.locator(".ln-node-total")).toHaveText("1 open channel");
  await expect(
    page.getByRole("table", { name: /Its open channels/ }).locator("tbody tr"),
  ).toHaveCount(1);

  await page.goto(`/regtest/lightning/node/${ACINQ}`);
  await expect(page.getByRole("table").locator("tbody tr").first()).toContainText("No policy");
  await page.getByRole("link", { name: "Fees", exact: true }).click();
  await expect(page.getByRole("table", { name: /Its fee rates/ })).toContainText("Median––");
  await expect(page.getByText(/its peers, by median/)).toHaveCount(0);

  await page.getByRole("link", { name: /^Closed/ }).click();
  for (const kind of ["Cooperative", "Force", "Penalty", "Other"])
    await expect(page.getByRole("link", { name: `${kind} 1` })).toBeVisible();
  await expect(page.getByText("Continued as 975402x1310x1")).toBeVisible();
  await expect(page.getByRole("link", { name: "975402x1310x1" })).toHaveAttribute(
    "href",
    "/regtest/lightning/channel/975402x1310x1",
  );
});

/** The node page's section headed `name`. */
const panel = (page: Page, name: string) =>
  page.locator("section", { has: page.getByRole("heading", { name, exact: true }) });

test("its fee rates on one scale with figures that fit a phone, and a past a tap reads", async ({
  page,
}) => {
  await serve(page, mainnet());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/regtest/lightning/node/${ACINQ}?view=fees`);
  const fees = panel(page, "Fee rates");
  // Two rows of bars on one scale: the longest is the 1 473 channels it prices at 200–499 ppm.
  await expect(fees.locator(".ln-fees__fill").first()).toBeVisible();
  const widths = await fees
    .locator(".ln-fees__fill")
    .evaluateAll((bars) => bars.map((b) => b.getBoundingClientRect().width));
  expect(Math.max(...widths)).toBeGreaterThan(10 * Math.min(...widths));
  // The figures: a finger's target, and a table that fits the narrowest phone.
  const figures = fees.locator(".chart__figures > summary");
  expect((await figures.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await figures.click();
  await page.setViewportSize({ width: 320, height: 844 });
  for (const name of ["It charges", "Its peers charge"]) {
    await expect(fees.getByRole("table", { name }).locator("thead th:visible")).toHaveText([
      "Fee rate, ppm",
      "Channels",
      /Capacity, BTC$/,
    ]);
  }
  await tablesFit(page, "a node's fee figures at 320 px");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "History", exact: true }).last().click();
  const chart = page.getByRole("slider", { name: /This node's channels and capacity/ });
  await expect(chart).toHaveAttribute("aria-valuetext", /Channels 1\s793/);
  // A tap reads a point out and never moves the plot.
  const svg = chart.locator("svg").first();
  await svg.scrollIntoViewIfNeeded();
  const before = await svg.boundingBox();
  await svg.click({ position: { x: 20, y: 60 } });
  await expect(page.locator(".chart__readout").first()).toContainText("13 Nov 2026");
  expect(await svg.boundingBox()).toStrictEqual(before);
});

/** The points of a chart's path `d`, as drawn. */
const points = (d: string) =>
  [...d.matchAll(/([MLHV])([\d.-]+)(?: ([\d.-]+))?/g)].reduce<[number, number][]>((out, m) => {
    const [x0, y0] = out.at(-1) ?? [0, 0];
    const a = Number(m[2]);
    const at: [number, number] =
      m[1] === "H" ? [a, y0] : m[1] === "V" ? [x0, a] : [a, Number(m[3])];
    out.push(at);
    return out;
  }, []);

// Two looks at a small node were once joined by a slope, as if its second channel had grown all
// day. Its record knows the open's block: the chart steps there, and draws nothing between.
test("a node's past steps at the moment a channel opened, never a slope between two looks", async ({
  page,
}) => {
  const midnight = 1_794_528_000;
  const opened = 1_794_603_213;
  const now = 1_794_607_020;
  await serve(page, {
    ...mainnet(),
    [`nodes/${ONE}/history`]: {
      from: 1_794_504_600,
      points: [
        { time: midnight, channels: 1, capacity: 80_000 },
        { time: opened, channels: 2, capacity: 2_080_000 },
        { time: now, channels: 2, capacity: 2_080_000 },
      ],
    },
  });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/regtest/lightning/node/${ONE}?view=history`);
    const past = panel(page, "Over time");
    await expect(past.getByRole("slider")).toHaveAttribute("aria-valuetext", /Channels 2\b/);
    const drawn = await past
      .locator(".chart__line, .chart__area")
      .evaluateAll((paths) => paths.map((p) => p.getAttribute("d") ?? "").filter(Boolean));
    // Channels' line and area, capacity's line.
    expect(drawn).toHaveLength(3);
    for (const d of drawn) {
      const at = points(d);
      const slopes = at.filter(([x, y], i) => {
        const [px, py] = at[i - 1] ?? [x, y];
        return Math.abs(x - px) > 0.2 && Math.abs(y - py) > 0.2;
      });
      expect(slopes, `${width} px: ${d}`).toStrictEqual([]);
    }
    // The rise is at the open, not at the later look: before the plot's right edge.
    const [line] = drawn;
    const xs = points(line ?? "").map(([x]) => x);
    const right = Math.max(...xs);
    const rise = points(line ?? "").find(
      ([x, y], i, all) => (all[i - 1]?.[0] ?? -1) === x && all[i - 1]?.[1] !== y,
    );
    expect(rise?.[0] ?? right, `${width} px: the step`).toBeLessThan(right - 2);
    // The figures name the open's minute.
    await past.getByText("Show the figures").click();
    await expect(past.getByRole("table")).toContainText("13 Nov 2026, 20:53");
  }
});

test.describe("a node's past and fees at the edges", () => {
  test.use({ consoleErrorsAllowed: [/status of 500/] });

  test("one channel, no past yet, and a refused history", async ({ page }) => {
    await serve(page, mainnet());
    await page.goto(`/regtest/lightning/node/${ONE}?view=fees`);
    // From its cheapest rate to its dearest, nothing past them.
    await expect(panel(page, "Fee rates").locator(".ln-fees__label")).toHaveText([
      "10–49",
      "50–99",
      "100–199",
      "200–499",
    ]);
    await page.goto(`/regtest/lightning/node/${ONE}?view=history`);
    await expect(
      page.getByRole("slider", { name: /This node's channels and capacity/ }),
    ).toHaveAttribute("aria-valuetext", /Channels 1\b/);

    const latest = { time: 1_794_594_636, channels: 1793, capacity: 28_498_822_087 };
    await serve(page, {
      ...mainnet(),
      [`nodes/${ACINQ}/history`]: { from: null, points: [latest] },
    });
    await page.goto(`/regtest/lightning/node/${ACINQ}?view=history`);
    const past = panel(page, "Over time");
    await expect(past.getByText("Nothing to draw yet")).toBeVisible();
    await expect(past.getByRole("slider")).toHaveCount(0);

    const answers: Record<string, unknown> = mainnet();
    delete answers[`nodes/${ACINQ}/history`];
    await serve(page, answers);
    await page.goto(`/regtest/lightning/node/${ACINQ}?view=history`);
    await expect(past.getByText("Could not load its history")).toBeVisible();
    await expect(past.getByRole("button", { name: "Try again" })).toBeVisible();
    // The node's own figures stay.
    await expect(panel(page, "At a glance")).toBeVisible();
  });
});
