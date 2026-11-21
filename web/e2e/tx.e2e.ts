import type { Locator, Page } from "@playwright/test";
import { chain, expect, PROJECTION_LAG_MS, test } from "./fixtures";

test("a confirmed transaction names every output type and links where the money went", async ({
  page,
}) => {
  await page.goto(`/regtest/tx/${chain.txs.script_types}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Transaction");
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "block 106" })).toHaveAttribute(
    "href",
    `/regtest/block/${chain.blocks[106]}`,
  );

  const outputs = page.getByRole("list", { name: "Outputs" });
  // A phone's card leads with the amount and where it went; its type waits in the inspector.
  const wide = (page.viewportSize()?.width ?? 0) > 640;
  for (const type of ["P2PKH", "P2SH", "P2WPKH", "P2WSH", "P2TR", "Pay to anchor"]) {
    const named = outputs.getByText(type, { exact: true }).first();
    await (wide ? expect(named).toBeVisible() : expect(named).toBeAttached());
  }
  await expect(outputs).toContainText(
    "OP_RETURN0.00 000 000 BTC#6Unspendable“mempool.based regtest”",
  );
  // Amounts keep their unit for screen readers, though the cards show bare numbers.
  await expect(outputs.getByText("1.00 000 000 BTC", { exact: true }).first()).toBeAttached();
  // spend_p2sh_p2a spent the P2SH and P2A outputs.
  await expect(
    outputs.getByRole("link", { name: `Spent in transaction ${chain.txs.spend_p2sh_p2a}` }),
  ).toHaveCount(2);

  await page.getByRole("button", { name: "Details of output 0" }).click();
  await expect(page.getByRole("heading", { name: "Output 0" })).toBeFocused();
  await expect(
    page.getByText(/^OP_DUP OP_HASH160 [0-9a-f]{40} OP_EQUALVERIFY OP_CHECKSIG$/),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("list", { name: "Outputs" })).toContainText("Pay to anchor");
});

test("a coinbase shows as new coins and pays no fee", async ({ page, request }) => {
  const block = await request.get(`/regtest/api/block/${chain.blocks[1]}/txid/0`);
  await page.goto(`/regtest/tx/${await block.text()}`);
  await expect(page.getByRole("list", { name: "Inputs" })).toContainText("Coinbase");
  // Numbered like every other card, as its details button names it.
  await expect(page.getByRole("list", { name: "Inputs" }).locator(".tx-flow__index")).toHaveText([
    "#0",
  ]);
  await expect(page.getByRole("button", { name: "Details of input 0" })).toBeVisible();
  await expect(page.getByText("A coinbase,")).toBeVisible();
  // Long past the hundred blocks a reward waits for.
  await expect(page.getByText(/^Spendable: [\d\u202F]+ confirmations$/)).toBeVisible();
});

test("the genesis coinbase is never called spendable or unspent", async ({ page, request }) => {
  const genesis = await request.get("/regtest/api/block-height/0");
  const txid = await (
    await request.get(`/regtest/api/block/${await genesis.text()}/txid/0`)
  ).text();
  await page.goto(`/regtest/tx/${txid}`);
  await expect(page.getByText("Never spendable")).toBeVisible();
  await expect(page.getByRole("list", { name: "Outputs" })).toContainText("Unspendable");
  await expect(page.getByRole("list", { name: "Outputs" })).not.toContainText("Unspent");
});

// Two versions of one payment, built by hand like the harness's own: block 9's coinbase (the
// miner script, anyone can spend) back to the miner script at 1 and then 5 sat/vB.
const original =
  "02000000000101c3849571e9ec71a5723146c5b7162c2e915caec6e7beab3de671b2b9b78e35e40000000000fdffffff" +
  "01a0f1052a010000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260010151" +
  "00000000";
const replacement =
  "02000000000101c3849571e9ec71a5723146c5b7162c2e915caec6e7beab3de671b2b9b78e35e40000000000fdffffff" +
  "0120f0052a010000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260010151" +
  "00000000";
const originalTxid = "7a2656b2d1c4d3f88f49db20d27a2428d9171705d49691d9d413c72721e61687";

test.describe("transactions the node no longer has", () => {
  // A 404 from the API is the answer these pages expect, not an error. Four device pixels to a
  // CSS pixel, so the replaced version's steps can be measured to a quarter of one.
  test.use({ consoleErrorsAllowed: [/status of 404/], deviceScaleFactor: 4 });

  test("a transaction that was replaced is not found, with the reason it may be missing", async ({
    page,
  }) => {
    await page.goto(`/regtest/tx/${chain.txs.rbf_original}`);
    await expect(page.getByText("Transaction not found")).toBeVisible();
  });

  test("an unconfirmed transaction that is replaced names its replacement, without a reload", async ({
    page,
    request,
  }) => {
    // Only regtest allows writes (AGENTS.md); this runs against the test's own node.
    expect(await (await request.post("/regtest/api/tx", { data: original })).text()).toBe(
      originalTxid,
    );
    await page.goto(`/regtest/tx/${originalTxid}`);
    await expect(page.getByText("Unconfirmed", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Yes, until it confirms")).toBeVisible();
    // The server takes it in at its next cycle; the page then says where it waits.
    await expect(page.getByRole("link", { name: "Next block", exact: true })).toBeVisible({
      timeout: PROJECTION_LAG_MS,
    });

    const replacementTxid = await (
      await request.post("/regtest/api/tx", { data: replacement })
    ).text();
    await expect(page.getByText("Replaced", { exact: true }).first()).toBeVisible({
      timeout: PROJECTION_LAG_MS,
    });
    const notice = page.getByText("This version was replaced").locator("..");
    await expect(notice.getByRole("link", { name: /…/ }).first()).toHaveAttribute(
      "href",
      `/regtest/tx/${replacementTxid}`,
    );
    await expect(notice).toContainText("paying 5.00 sat/vB where this one paid 1.00 sat/vB");
    await expect(page.getByText("No: it was replaced")).toBeVisible();
    await expect(page.getByRole("list", { name: "Outputs" })).toBeVisible();
    // The full steps, struck through and dashed, keep their numbers in the middle too.
    expect(await stepsOffCentre(page, "a replaced version")).toEqual([]);

    // What changed: the one output paid 384 sats less, which went to the fee.
    const changed = page.getByRole("region", { name: "What changed" });
    await expect(changed.getByRole("listitem")).toHaveCount(1);
    await expect(changed.getByRole("listitem")).toContainText("Changed");
    await expect(changed).toContainText("+384 sats");

    // Opened later, the node no longer has it, and the server still says what happened.
    await page.reload();
    await expect(page.getByText("This version was replaced")).toBeVisible();
    // The outputs too: the server kept them while it waited.
    await expect(changed.getByRole("listitem")).toContainText("Changed");
  });
});

test("an unconfirmed transaction shows where it waits, and leaving lets go of it", async ({
  page,
}) => {
  // Each socket's frames sent, and whether it closed.
  const sockets: { sent: string[]; closed: boolean }[] = [];
  page.on("websocket", (ws) => {
    const s = { sent: [] as string[], closed: false };
    sockets.push(s);
    ws.on("framesent", (f) => s.sent.push(String(f.payload)));
    ws.on("close", () => {
      s.closed = true;
    });
  });
  await page.goto(`/regtest/tx/${chain.txs.payment}`);
  await expect(page.getByRole("link", { name: "Next block", exact: true })).toHaveAttribute(
    "href",
    "/regtest/block/next",
  );
  await page.getByText("How this changes").click();
  await expect(page.getByText(/^Regtest has no block schedule/)).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const topic = `tx:${chain.txs.payment}`;
  const following = sockets.find((s) => s.sent.some((f) => f.includes(topic)));
  expect(following, "a socket that follows the transaction").toBeDefined();
  await page.getByRole("link", { name: "Blocks", exact: true }).click();
  await expect(page).toHaveURL("/regtest/blocks");
  // Released: unsubscribed, or the socket closed with nothing else on it.
  await expect(() => {
    const released =
      following?.closed === true ||
      following?.sent.some((f) => f.includes('"op":"unsubscribe"') && f.includes(topic));
    expect(released, "the transaction's topic released").toBe(true);
  }).toPass();
});

test("a parent shows the rate its child lifts it to, and links the child", async ({ page }) => {
  await page.goto(`/regtest/tx/${chain.txs.cpfp_parent}`);
  await expect(page.getByText(/^Effective \d/)).toBeVisible();
  const group = page.getByRole("region", { name: "Mined with" });
  await expect(group).toContainText("but its child pays enough to lift the group to");
  await expect(group.getByRole("link")).toHaveAttribute(
    "href",
    `/regtest/tx/${chain.txs.cpfp_child}`,
  );
});

// Widening a page from a phone's width once left the flow with the tall box it was drawn at,
// a screen of empty space, until a reload; in WebKit the ribbons' own viewBox held it there. However
// the width was reached, the flow is the same: the widened page is compared with a fresh one.
test("the flow is as tall after a widening as after a reload", async ({ page, context }) => {
  const open = async (p: Page) => {
    // Whether each output is spent changes its card, so both pages wait for that answer.
    const spends = p.waitForResponse((r) => r.url().endsWith("/outspends"));
    await p.goto(`/regtest/tx/${chain.txs.script_types}`);
    await spends;
    await expect(p.getByRole("list", { name: "Outputs" })).toBeVisible();
  };
  const height = async (p: Page) => (await p.locator(".tx-flow").boundingBox())?.height ?? 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fresh = await context.newPage();
  await fresh.setViewportSize({ width: 1440, height: 900 });
  await open(fresh);
  // Each redraws on its own frames: wait until they agree, which a held box never does.
  await expect
    .poll(async () => {
      const [widened, reloaded] = [await height(page), await height(fresh)];
      return { widened, reloaded, apart: Math.abs(widened - reloaded) < 2 };
    })
    .toMatchObject({ apart: true });
});

test("a confirmed transaction opens with its status, amount, fee and block", async ({ page }) => {
  await page.goto(`/regtest/tx/${chain.txs.script_types}`);
  const summary = page.getByRole("definition").first().locator("xpath=ancestor::dl[1]");
  await expect(summary).toContainText("confirmations");
  await expect(summary).toContainText("Amount");
  await expect(summary).toContainText("sat/vB");
  await expect(summary.getByRole("link", { name: /^block / })).toHaveAttribute(
    "href",
    /\/regtest\/block\//,
  );
  // The summary says what the steps would, so a settled transaction has none.
  await expect(page.getByRole("list", { name: "Status" })).toHaveCount(0);
});

test("a card's details open beside the flow on a desktop, moving nothing on the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const spends = page.waitForResponse((r) => r.url().endsWith("/outspends"));
  await page.goto(`/regtest/tx/${chain.txs.script_types}`);
  await spends;
  const outputs = page.getByRole("list", { name: "Outputs" });
  await expect(outputs).toBeVisible();
  const footer = page.getByRole("contentinfo");
  const later = outputs.getByRole("listitem").nth(3);
  const where = async () => ({
    footer: (await footer.boundingBox())?.y,
    card: (await later.boundingBox())?.y,
    height: await page.evaluate(() => document.documentElement.scrollHeight),
  });
  const before = await where();
  await page.getByRole("button", { name: "Details of output 0" }).click();
  const inspector = page.getByRole("region", { name: "Output 0" });
  await expect(inspector).toBeVisible();
  await expect(page.getByRole("heading", { name: "Output 0" })).toBeFocused();
  // In the side panel, right of the flow, where the details were.
  const flow = await page.getByRole("region", { name: "Inputs and outputs" }).boundingBox();
  const box = await inspector.boundingBox();
  if (!flow || !box) throw new Error("missing flow or inspector");
  expect(box.x).toBeGreaterThanOrEqual(flow.x + flow.width);
  expect(box.y).toBeLessThan(flow.y + flow.height);
  await expect(page.getByRole("region", { name: "Details" })).toBeHidden();
  expect(await where()).toEqual(before);
  await inspector.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("region", { name: "Details" })).toBeVisible();
});

test("copy and expand are a thumb's target each, apart from the address they sit beside", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/regtest/tx/${chain.txs.script_types}`);
  const outputs = page.getByRole("list", { name: "Outputs" });
  await expect(outputs).toBeVisible();
  const targets = [
    page.getByRole("button", { name: "Copy transaction ID" }),
    outputs.getByRole("button").first(),
  ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(box && Math.min(box.width, box.height)).toBeGreaterThanOrEqual(43.5);
  }
  // The expand button and the address link under it never overlap.
  const expand = await outputs.getByRole("button").first().boundingBox();
  const address = await outputs
    .getByRole("listitem")
    .first()
    .getByRole("link")
    .first()
    .boundingBox();
  if (!expand || !address) throw new Error("missing expand button or address");
  const apart =
    expand.y + expand.height <= address.y + 1 ||
    address.y + address.height <= expand.y + 1 ||
    expand.x + expand.width <= address.x + 1 ||
    address.x + address.width <= expand.x + 1;
  expect(apart).toBe(true);
});

/**
 * How far a step's digit sits from the middle of its ring, in CSS pixels: the centre of the
 * digit's drawn pixels against the centre of the ring, from a screenshot of the page.
 */
async function digitOffset(page: Page, marker: Locator): Promise<{ dx: number; dy: number }> {
  await marker.scrollIntoViewIfNeeded();
  const box = await marker.boundingBox();
  if (!box) throw new Error("a step's marker is not on the page");
  // Whole CSS pixels, so the screenshot's pixels map exactly onto the page's.
  const clip = {
    x: Math.floor(box.x) - 2,
    y: Math.floor(box.y) - 2,
    width: Math.ceil(box.width) + 5,
    height: Math.ceil(box.height) + 5,
  };
  const png = await page.screenshot({ clip, animations: "disabled" });
  const style = await marker.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: Number.parseFloat(s.borderTopWidth), ink: s.color, ground: s.backgroundColor };
  });
  return page.evaluate(
    async ({ b64, ring, centre, dpr }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.codePointAt(0) ?? 0);
      // A bitmap from a blob: no image URL, so the page's CSP has nothing to refuse.
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext("2d");
      if (!g) throw new Error("no 2D canvas");
      g.drawImage(bitmap, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bitmap.width, bitmap.height);
      const rgb = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const ink = rgb(ring.ink);
      const ground = rgb(ring.ground);
      const far = (k: number, c: number[]) =>
        Math.abs((data[k] ?? 0) - (c[0] ?? 0)) +
        Math.abs((data[k + 1] ?? 0) - (c[1] ?? 0)) +
        Math.abs((data[k + 2] ?? 0) - (c[2] ?? 0));
      const [cx, cy, r] = [centre.x * dpr, centre.y * dpr, (centre.r - ring.border - 1) * dpr];
      let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          // Inside the ring only, and nearer the digit's colour than the ground's.
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
          const k = (y * width + x) * 4;
          if (far(k, ground) <= far(k, ink)) continue;
          [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
        }
      }
      return { dx: ((x0 + x1 + 1) / 2 - cx) / dpr, dy: ((y0 + y1 + 1) / 2 - cy) / dpr };
    },
    {
      b64: png.toString("base64"),
      ring: style,
      centre: {
        x: box.x + box.width / 2 - clip.x,
        y: box.y + box.height / 2 - clip.y,
        r: Math.min(box.width, box.height) / 2,
      },
      dpr: await page.evaluate(() => devicePixelRatio),
    },
  );
}

/** Each status step whose number is more than half a pixel from its ring's middle, at two widths. */
async function stepsOffCentre(page: Page, name: string): Promise<string[]> {
  const off: string[] = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const markers = page.getByRole("list", { name: "Status" }).locator(".tx-step__marker");
    await expect(markers).toHaveCount(3);
    for (const [i, marker] of (await markers.all()).entries()) {
      const box = await marker.boundingBox();
      const where = `step ${i + 1} of ${name} at ${width} px`;
      if (Math.abs((box?.width ?? 0) - (box?.height ?? 1)) > 0.1) off.push(`${where}: not round`);
      // Chromium draws text on whole pixels and the ring where layout puts it, so a step between
      // pixels can look half a pixel out whatever its CSS: the ring is set on whole pixels.
      await marker.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const style = (el as HTMLElement).style;
        style.left = `${Math.floor(r.left) - r.left}px`;
        style.top = `${Math.floor(r.top) - r.top}px`;
      });
      const { dx, dy } = await digitOffset(page, marker);
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) off.push(`${where}: off by ${dx}, ${dy}`);
    }
  }
  return off;
}
