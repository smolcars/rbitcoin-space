import { chain, expect, test } from "./fixtures";

test("the home page shows the scenario's blocks, live, with the mempool and fees", async ({
  page,
  request,
}) => {
  await page.goto("/regtest/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blocks");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();

  const tiles = page
    .getByRole("list", { name: "Mined blocks, newest first" })
    .getByRole("listitem");
  const newest = tiles.first().getByRole("link");
  await expect(newest).toContainText("110");
  await expect(newest).toHaveAttribute("href", `/regtest/block/${chain.tip.hash}`);
  await expect(page.getByText("Next block", { exact: true }).last()).toBeVisible();

  // The figures are the node's: another test may broadcast meanwhile, so compare with a fresh answer.
  await expect(async () => {
    const mempool = (await (await request.get("/regtest/api/mempool")).json()) as { count: number };
    await expect(page.locator(".home-stat").first()).toContainText(String(mempool.count), {
      timeout: 100,
    });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Fee to pay now" })).toBeVisible();
  await expect(
    page.getByRole("table", { name: "The newest transactions waiting in the mempool" }),
  ).toContainText(chain.txs.cpfp_child.slice(0, 8));
});

test("the home page fits a phone without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/regtest/");
  // A phone keeps only the few tiles near its narrow view in the page.
  await expect(
    page.getByRole("list", { name: "Mined blocks, newest first" }).getByRole("link").first(),
  ).toHaveAccessibleName(/^Block 110,/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("the strip scrolls right into the past, down to block 0, and back to now", async ({
  page,
}) => {
  const apiPages: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/(v1\/)?blocks\/\d+$/.test(r.url())) apiPages.push(new URL(r.url()).pathname);
  });
  await page.goto("/regtest/");
  const lane = page.getByRole("list", { name: "Mined blocks, newest first" });
  const scroller = page.locator(".home-strip__scroller");
  await expect(lane.getByRole("link").first()).toHaveAccessibleName(/^Block 110,/);
  const back = page.getByRole("button", { name: "Back to now" });
  await expect(back).toHaveCount(0);

  // A swipe or a wheel to the end of the chain: the strip ends at block 0, with nothing after it.
  await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: "instant" }));
  const genesis = lane.getByRole("link", { name: /^Block 0,/ });
  await expect(genesis).toBeInViewport();
  expect(await lane.locator(":scope > li").last().getAttribute("data-height")).toBe("0");
  // Only the tiles near the view are in the page, and the 111 blocks took a handful of pages.
  expect(await lane.locator(":scope > li").count()).toBeLessThan(40);
  expect(apiPages.length).toBeLessThanOrEqual(8);
  expect(apiPages.every((p) => p.startsWith("/regtest/api/v1/blocks/"))).toBe(true);

  // The way back is a real button, a thumb high on a touch screen, and it brings the line into view.
  await expect(back).toBeVisible();
  const box = await back.boundingBox();
  const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  expect(box?.height).toBeGreaterThanOrEqual(touch ? 44 : 32);
  await back.click();
  await expect(back).toHaveCount(0);
  await expect(page.locator(".home-strip__now")).toBeInViewport();
  await expect(lane.getByRole("link", { name: /^Block 110,/ })).toBeInViewport();
});

test("a mouse drags the strip into the past, it glides on, and a drag opens no block", async ({
  page,
}) => {
  await page.goto("/regtest/");
  const lane = page.getByRole("list", { name: "Mined blocks, newest first" });
  const scroller = page.locator(".home-strip__scroller");
  await expect(lane.getByRole("link").first()).toHaveAccessibleName(/^Block 110,/);
  const left = () => scroller.evaluate((el) => el.scrollLeft);
  // No bar to aim for: the strip is moved by hand.
  expect(
    await scroller.evaluate(
      (el) => (el instanceof HTMLElement ? el.offsetHeight : 0) - el.clientHeight,
    ),
  ).toBe(0);

  // Pressed near the right edge and pulled across, held still, let go: it moved with the hand,
  // and stays.
  const tile = await lane.getByRole("link").first().boundingBox();
  if (!tile) throw new Error("no tile");
  const y = tile.y + tile.height / 2;
  const x = (page.viewportSize()?.width ?? 0) - 10;
  const pull = x - 20;
  const start = await left();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - pull, y, { steps: 10 });
  await expect(scroller).toHaveAttribute("data-dragging", "");
  expect(await left()).toBeCloseTo(start + pull, -1);
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(scroller).not.toHaveAttribute("data-dragging");
  expect(await left()).toBeCloseTo(start + pull, -1);
  await expect(page).toHaveURL(/\/regtest\/$/);

  // A flick: it glides on past where the hand stopped, into blocks loaded from the past.
  let letGo = 0;
  const flick = async () => {
    await page.mouse.move(x, y);
    // The press stops what is left of an earlier flick's glide: the hand starts from here.
    await page.mouse.down();
    letGo = (await left()) + 200;
    await page.mouse.move(x - 200, y, { steps: 4 });
    await page.mouse.up();
    // A loaded machine can stall a flick into a stop, which does not glide: flick again.
    await expect(scroller).toHaveAttribute("data-dragging", "", { timeout: 100 });
  };
  await expect(flick).toPass();
  // Any glide from these 50 px steps starts at 50 px per 80 ms or more, which carries it about
  // 190 px; how fast the machine sends the steps only adds to that.
  await expect.poll(left).toBeGreaterThan(letGo + 100);
  await expect(page).toHaveURL(/\/regtest\/$/);
  await expect(page.getByRole("button", { name: "Back to now" })).toBeVisible();
  // Below the live list's ten, so loaded from the past as the strip went.
  const lowestInView = () =>
    scroller.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const heights = [...el.querySelectorAll<HTMLElement>("li[data-height]:has(a)")]
        .filter((li) => {
          const r = li.getBoundingClientRect();
          return r.left >= box.left && r.right <= box.right;
        })
        .map((li) => Number(li.dataset["height"]));
      return Math.min(...heights);
    });
  await expect.poll(lowestInView).toBeLessThan(101);

  // "Back to now" pressed while a flick still glides: the strip goes back, the glide does not win.
  await expect(scroller).not.toHaveAttribute("data-dragging");
  await expect(flick).toPass();
  await page.getByRole("button", { name: "Back to now" }).click();
  await expect(page.locator(".home-strip__now")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Back to now" })).toHaveCount(0);

  // A press that does not move is still a click on the block.
  await lane.getByRole("link", { name: /^Block 110,/ }).click();
  await expect(page).toHaveURL(/\/regtest\/block\//);
});

test("each tile shows its fee gauge and figures, and a coinbase-only block says so", async ({
  page,
}) => {
  await page.goto("/regtest/");
  const lane = page.getByRole("list", { name: "Mined blocks, newest first" });
  // Blocks 106 and 107 hold the scenario's transactions; the rest only a coinbase.
  const paying = lane.getByRole("link", { name: /^Block 106,/ });
  await expect(paying).toHaveAccessibleName(/median fee \d+\.\d\d sat\/vB, fee range/);
  await expect(paying.locator(".strata__layer").first()).toBeVisible();
  await expect(paying).toContainText("sat/vB");
  const one = lane.getByRole("link", { name: /^Block 107,/ });
  await expect(one.locator(".strata__layer")).toHaveCount(1);
  const empty = lane.getByRole("link", { name: /^Block 105,/ });
  await expect(empty).toContainText("No fees");
  await expect(empty).toContainText("Coinbase only");
  await expect(empty.locator(".strata__layer")).toHaveCount(0);
});

test("regtest says it never adjusts its difficulty", async ({ page }) => {
  await page.goto("/regtest/");
  await expect(
    page.getByRole("region", { name: "Difficulty adjustment" }).getByText(/never adjusts/),
  ).toBeVisible();
});

test("the unconfirmed scenario transactions wait in the projected next block", async ({ page }) => {
  await page.goto("/regtest/");
  const projected = page.getByRole("list", { name: "Projected blocks, next first" });
  const next = projected.getByRole("link").first();
  // Four from the scenario, and maybe the broadcast test's.
  await expect(next).toHaveAccessibleName(/^Next block, projected: \d+ transactions, median fee/);
  const label = (await next.getAttribute("aria-label")) ?? "";
  expect(Number(/projected: (\d+)/.exec(label)?.[1])).toBeGreaterThanOrEqual(4);
  // A phone hides the note to give the tiles room (HomePage.css).
  const note = page.getByText("Everything waiting fits in the next block.");
  await ((page.viewportSize()?.width ?? 0) > 640
    ? expect(note).toBeVisible()
    : expect(note).toBeAttached());
  // It opens that block's page.
  await next.click();
  await expect(page).toHaveURL(/\/regtest\/block\/next$/);
});

test("a cold load asks for each thing once, and nothing the mempool topics send", async ({
  page,
}) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    // With the query: the older tiles' facts are a batch of their own, after the newest ten's.
    const url = new URL(r.url());
    const path = url.pathname + url.search;
    if (path.includes("/api/") || path.includes("/app/")) asked.push(path.replace("/regtest", ""));
  });
  await page.goto("/regtest/");
  await expect(page.getByRole("list", { name: "Projected blocks, next first" })).toBeVisible();
  await expect(page.locator(".home-stats")).not.toHaveAttribute("aria-busy", "true");
  // Long enough for a second round of requests, as a new tip would cause. (The panels' fallback
  // polling, after the topics stay silent for 5 s, is covered by the unit tests.)
  await page.waitForTimeout(1_500);
  const counts = new Map<string, number>();
  for (const p of asked) counts.set(p, (counts.get(p) ?? 0) + 1);
  expect(
    [...counts.values()].every((n) => n === 1),
    JSON.stringify([...counts]),
  ).toBe(true);
  expect(counts.get("/api/blocks")).toBe(1);
  expect(counts.has("/api/mempool")).toBe(false);
  expect(counts.has("/api/mempool/recent")).toBe(false);
  expect(counts.has("/api/v1/fees/precise")).toBe(false);
});

test("the fee panel shows what the server says now, and no number when it has none", async ({
  page,
  request,
}) => {
  await page.goto("/regtest/");
  const panel = page.getByRole("region", { name: "Fee to pay now" });
  // Regtest's node makes no estimates, and the server's own wait five minutes after it starts, so
  // this is usually no answer; compare with the route at the same moment either way.
  await expect(async () => {
    const res = await request.get("/regtest/api/v1/fees/precise");
    if (res.status() === 503) {
      await expect(panel).toContainText("No recommendation right now", { timeout: 100 });
    } else {
      const fees = (await res.json()) as { fastestFee: number };
      // Rounded up to two decimals, as the panel prints a recommendation.
      const shown = (Math.ceil(Math.round(fees.fastestFee * 1e6) / 1e4) / 100).toFixed(2);
      await expect(panel).toContainText(shown, { timeout: 100 });
    }
  }).toPass({ timeout: 15_000 });
});

test("the fee panel follows the fees topic: an update, the node's fallback, then none", async ({
  page,
}) => {
  // The server's own answer needs five minutes of the mempool, longer than this suite: the topic's
  // messages are played into the real socket, which carries everything else as it is.
  let send: ((m: object) => void) | undefined;
  await page.routeWebSocket(/\/app\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      // The server's own `fees` messages are held back, so only the played ones are seen.
      if (typeof m === "string" && m.includes('"topic":"fees"')) return;
      ws.send(m);
    });
    send = (m) => ws.send(JSON.stringify(m));
  });
  await page.goto("/regtest/");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Fee to pay now" });
  const levels = (rates: number[], source: string) => ({
    topic: "fees",
    type: "fees",
    source,
    tip: null,
    levels: ["high", "medium", "low", "no_rush"].map((name, i) => ({
      name,
      blocks: [1, 3, 6, 144][i],
      minutes: [10, 30, 60, 1440][i],
      rate: rates[i],
    })),
    min_fee_rate: 100,
  });
  const high = panel.getByRole("definition").last();
  const list = panel.getByRole("list").or(panel.locator("dl"));
  const height = async () => (await list.first().boundingBox())?.height ?? 0;

  send?.(levels([1031, 500, 200, 100], "projected"));
  await expect(high).toHaveText("1.04 sat/vB");
  // Separate answers of the server's own need no line under them.
  await expect(panel.locator(".home-fees__note")).toHaveCount(0);
  // The mempool filled up: the next message is the new answer.
  send?.(levels([2501, 1031, 200, 100], "projected"));
  await expect(high).toHaveText("2.51 sat/vB");
  send?.(levels([3000, 1000, 500, 120], "node"));
  await expect(high).toHaveText("3.00 sat/vB");
  await expect(panel).toContainText("The node's own estimates");
  // Merging equal answers, or splitting them again, never changes the panel's height; one answer
  // for every wait is one row, so a phone's two rows become one (wider, they are one row already).
  const four = await height();
  for (const rates of [
    [3000, 100, 100, 100],
    [3000, 1000, 1000, 100],
    [3000, 3000, 100, 100],
  ]) {
    send?.(levels(rates, "projected"));
    await expect(panel.locator(".home-fees__item").first()).toBeVisible();
    await expect.poll(height).toBeCloseTo(four, 0);
  }
  send?.(levels([100, 100, 100, 100], "projected"));
  await expect(panel.locator(".home-fees__item")).toHaveCount(1);
  await ((page.viewportSize()?.width ?? 0) > 640
    ? expect.poll(height).toBeCloseTo(four, 0)
    : expect.poll(height).toBeLessThan(four * 0.6));
  send?.({ topic: "fees", type: "unavailable" });
  await expect(panel).toContainText("No recommendation right now");
  await expect(panel).not.toContainText("3.00");
});
