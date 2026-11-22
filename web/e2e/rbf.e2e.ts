// The replacements page drawn from mainnet's answers (fixtures/api-v1/replacements.json), served in
// place of this server's own: regtest makes no stories this long or this tangled. Stories made on
// the run's own node are in rbf.mine.e2e.ts.
import { readFileSync } from "node:fs";
import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";
import { layoutFaults } from "./layout";
import { amountsIntact, rowFaults, rowsWhole, tablesFit, wideFaces } from "./rows";

const RECORDED = JSON.parse(
  readFileSync(new URL("../../fixtures/api-v1/replacements.json", import.meta.url), "utf8"),
) as { all: { tx: { txid: string } }[]; fullRbf: { tx: { txid: string } }[] };

/** Serves the recorded lists, or what `answer` says now. */
async function recorded(page: Page, answer?: () => { status?: number; json: unknown }) {
  await page.route(/\/regtest\/api\/v1\/(fullrbf\/)?replacements$/, (route) =>
    route.fulfill(
      answer?.() ?? {
        json: route.request().url().includes("fullrbf") ? RECORDED.fullRbf : RECORDED.all,
      },
    ),
  );
}

const story = (page: Page, txid: string) => page.locator(`[data-story="${txid}"]`);

test("mainnet's stories read oldest first, fold when long, and fit every width", async ({
  page,
}) => {
  await recorded(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/regtest/rbf");
  const table = page.getByRole("table", { name: "Replacements, newest first" });
  await expect(table.locator("tbody tr")).toHaveCount(RECORDED.all.length);
  await expect(page.getByText(`${RECORDED.all.length} replacements, the newest`)).toBeVisible();
  // Each story ends with its newest version, the one its row opens.
  const first = RECORDED.all[0]?.tx.txid ?? "";
  await expect(story(page, first).locator("li").last()).toContainText(first.slice(0, 8));
  await expect(table.locator(".table__rowlink").first()).toHaveAttribute(
    "href",
    `/regtest/tx/${first}`,
  );
  // A story eight versions long shows its first and last two until asked for the rest.
  const fold = page.getByRole("button", { name: "5 more versions" }).first();
  const id = await page.locator("[data-story]", { has: fold }).first().getAttribute("data-story");
  const line = story(page, id ?? "").locator(".rbf-v");
  await expect(line).toHaveCount(3);
  await fold.click();
  await expect(line).toHaveCount(8);

  // Full RBF only: what replaced a transaction that did not signal, some of it mined, some of it
  // taking dozens of transactions with it.
  await page.getByRole("link", { name: "Full RBF only" }).click();
  await expect(page).toHaveURL(/\/regtest\/rbf\?view=full-rbf$/);
  const full = page.getByRole("table", {
    name: "Replacements of a transaction that did not signal, newest first",
  });
  await expect(full.locator("tbody tr")).toHaveCount(RECORDED.fullRbf.length);
  await expect(full.getByText("Mined", { exact: true }).first()).toBeVisible();
  await expect(full.getByRole("button", { name: /^\d+ more$/ }).first()).toBeVisible();

  for (const width of [720, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await tablesFit(page, `/rbf at ${width} px`);
    await amountsIntact(page, `/rbf at ${width} px`);
  }
});

// An older version was once a 19 px link inside a row that opens the version that stands: a press
// 10 px below it opened that other transaction. Every version is now a target of its own, at least
// a thumb high (docs/DESIGN.md "Touch"), and inside a story the row's link answers nowhere.
test.describe("a version's target", () => {
  // The tap at the end opens a mainnet transaction, which regtest's node does not have.
  test.use({ consoleErrorsAllowed: [/status of 404/] });
  test("every version is a thumb's target of its own, and a near miss never opens another", async ({
    page,
  }) => {
    await recorded(page);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/regtest/rbf");
      await expect(page.locator(".rbf-list tbody tr")).toHaveCount(RECORDED.all.length);
      const faults = await page.evaluate(() => {
        const out: string[] = [];
        const name = (el: Element | null) =>
          el?.closest("a")?.getAttribute("href")?.slice(-6) ??
          (el?.classList.contains("table__rowlink") ? "the row" : "nothing");
        for (const one of document.querySelectorAll<HTMLElement>("[data-story]")) {
          const versions = [...one.querySelectorAll<HTMLAnchorElement>(".rbf-v__id a")];
          const others = [...one.querySelectorAll<HTMLAnchorElement>(".rbf-story__others a")];
          for (const a of [...versions, ...others]) {
            a.scrollIntoView({ block: "center" });
            const r = a.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            const at = (dx: number, dy: number) => document.elementFromPoint(x + dx, y + dy);
            const mine = (dx: number, dy: number) => at(dx, dy)?.closest("a") === a;
            // A near miss, above, below and at either end, is still this one.
            for (const [dx, dy] of [
              [0, -10],
              [0, 10],
              [-r.width / 2 + 2, 0],
              [r.width / 2 - 2, 0],
            ] as const) {
              if (!mine(dx, dy)) {
                out.push(`${a.href.slice(-6)} at ${dx}, ${dy}: ${name(at(dx, dy))}`);
              }
            }
            if (!versions.includes(a)) continue;
            let up = 0;
            while (up < 60 && mine(0, -(up + 1))) up++;
            let down = 0;
            while (down < 60 && mine(0, down + 1)) down++;
            if (up + down + 1 < 44) out.push(`${a.href.slice(-6)} is ${up + down + 1} px high`);
          }
          // Nowhere in the story does the row's own link answer: down the line through each version.
          const box = one.getBoundingClientRect();
          for (const a of versions) {
            a.scrollIntoView({ block: "center" });
            const r = a.getBoundingClientRect();
            const top = one.getBoundingClientRect().top;
            for (let dy = 0; dy <= box.height; dy += 2) {
              const el = document.elementFromPoint(r.left + r.width / 2, top + dy);
              if (el?.classList.contains("table__rowlink")) {
                out.push(`the row's link inside the story at ${Math.round(dy)} px`);
                break;
              }
            }
          }
        }
        return out;
      });
      expect(faults, `${width} px`).toStrictEqual([]);
    }
    // A tap 10 px below an older version opens that version, at the narrowest phone.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/regtest/rbf");
    const first = RECORDED.all[0]?.tx.txid ?? "";
    const older = story(page, first).locator(".rbf-v__id a").first();
    const href = await older.getAttribute("href");
    await older.scrollIntoViewIfNeeded();
    const box = await older.boundingBox();
    if (!box) throw new Error("no older version");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 10);
    await expect(page).toHaveURL(new URL(href ?? "", page.url()).href);
  });
});

// A screen under 30em tall has no sticky header: the screen's top is the edge there.
for (const height of [800, 400]) {
  test(`a story that arrives above the reader leaves what they read where it was, ${height} px tall`, async ({
    page,
  }) => {
    let list = RECORDED.all;
    await recorded(page, () => ({ json: list }));
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/regtest\/app\/ws$/, (ws) => {
      ws.connectToServer();
      socket = ws;
    });
    await page.setViewportSize({ width: 390, height });
    await page.goto("/regtest/rbf");
    const rows = page.locator(".rbf-list tbody tr");
    await expect(rows).toHaveCount(RECORDED.all.length);

    // The reader is down the list, reading its seventh story.
    const reading = story(page, RECORDED.all[6]?.tx.txid ?? "");
    await reading.evaluate((el) => {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200);
    });
    const before = await reading.evaluate((el) => el.getBoundingClientRect().top);

    // A new replacement: the topic says the record changed, and the list has a new story on top.
    const fresh = "ab".repeat(32);
    const top = RECORDED.all[0] as Record<string, unknown> & { tx: Record<string, unknown> };
    list = [{ ...top, tx: { ...top.tx, txid: fresh } }, ...RECORDED.all.slice(0, -1)];
    socket?.send(JSON.stringify({ topic: "replacements", type: "replacements", version: 1e9 }));
    await expect(rows.first().locator(`[data-story="${fresh}"]`)).toBeAttached();
    const after = await reading.evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.abs(after - before), "the story being read did not move").toBeLessThan(1);
  });
}

test.describe("nothing to show, and a refusal", () => {
  test.use({ consoleErrorsAllowed: [/status of 500/] });

  test("say so, and recover with Try again", async ({ page }) => {
    let answer: { status?: number; json: unknown } = { json: [] };
    await recorded(page, () => answer);
    await page.goto("/regtest/rbf");
    await expect(page.getByText("No replacements yet")).toBeVisible();

    answer = { status: 500, json: { error: "upstream unavailable" } };
    await page.reload();
    await expect(page.getByText("Could not load the replacements")).toBeVisible();
    answer = { json: RECORDED.all };
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".rbf-list tbody tr")).toHaveCount(RECORDED.all.length);
  });
});

// The home page's preview once cut its status to "Not mi…" at 320 px, its rate change taking the
// room. Every status the record has, beside the longest rate change, stays whole in each list of
// replacements, at the narrowest phone and in faces wider than the ones the site was built with.
test("no replacement row is cut or faded, whatever its status, at 320, 390 and 720 px", async ({
  page,
}) => {
  interface Tree {
    tx: Record<string, unknown>;
    mined?: boolean | null;
    replaces: Tree[];
  }
  const slowest = (t: Tree): Tree => ({
    ...t,
    replaces: t.replaces.map((r) => ({ ...slowest(r), tx: { ...r.tx, rate: 9.99 } })),
  });
  const all = structuredClone(RECORDED.all) as unknown as Tree[];
  const [mined, unknown, longest] = all;
  if (!mined || !unknown || !longest) throw new Error("too few recorded stories");
  mined.mined = true;
  unknown.mined = null;
  all[2] = { ...slowest(longest), tx: { ...longest.tx, rate: 12_345.6 } };
  await recorded(page, () => ({ json: all }));
  for (const width of [320, 390, 720]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, scope] of [
      ["/regtest/", ".rbf-recent"],
      ["/regtest/mempool", ".rbf-recent"],
      ["/regtest/rbf", ".rbf-list"],
    ] as const) {
      await page.goto(path);
      const rows = page.locator(scope).locator("tbody tr");
      await expect(rows.first().getByText("Mined", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(rows.nth(1).getByText("Unknown", { exact: true })).toBeVisible();
      await expect(rows.nth(2)).toContainText(/12\s?346/);
      await rowsWhole(page, scope, `${path} at ${width} px`);
      await wideFaces(page);
      await rowsWhole(page, scope, `${path} at ${width} px in wide faces`);
    }
  }
  // The rule sees a status cut inside its own box, as the preview's "Not mi…" was.
  await page
    .locator(".rbf-list .rbf-status__word")
    .first()
    .evaluate((el) => {
      Object.assign(el.style, {
        display: "block",
        width: "2.5em",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
    });
  expect(await rowFaults(page, ".rbf-list")).toContainEqual(expect.stringMatching(/is cut$/));
});

// A replacement's ID was cut at its end by its own ellipsis, losing its last characters, at 320 px
// in a wide face (SB15); the font sweep sees these panels empty.
test.describe("in a wide face", () => {
  test("the newest replacements keep each ID's last eight characters at 320 px", async ({
    page,
  }) => {
    await recorded(page);
    await page.setViewportSize({ width: 320, height: 900 });
    for (const path of ["/regtest/", "/regtest/mempool"]) {
      await page.goto(path);
      await expect(page.locator(".rbf-recent tbody .hash").first()).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(async () => (await layoutFaults(page)).filter((f) => f.includes("loses its end")))
        .toStrictEqual([]);
    }
  });
});

// The panel used to show its placeholder rows on the next page for up to 10 s: it waited out the
// gap since the last ask, and for the topic's first message, which a socket already subscribed
// never sends again. It now shows the list the page already holds at once.
test("the recent replacements panel shows the list it holds at once on the next page", async ({
  page,
}) => {
  await recorded(page);
  const newest = (RECORDED.all[0]?.tx.txid ?? "").slice(0, 8);
  const top = page
    .getByRole("table", { name: "The newest replacements, newest first" })
    .locator("tbody tr")
    .first();
  await page.goto("/regtest/");
  await expect(top).toContainText(newest);
  await page.getByRole("navigation").getByRole("link", { name: "Mempool", exact: true }).click();
  await expect(page).toHaveURL(/\/regtest\/mempool$/);
  await expect(top).toContainText(newest, { timeout: 1000 });
  await page.goBack();
  await expect(page).toHaveURL(/\/regtest\/$/);
  await expect(top).toContainText(newest, { timeout: 1000 });
});
