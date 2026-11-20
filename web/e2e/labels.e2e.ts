// The reader's own labels (docs/FRONTEND.md "Your labels"): set where a thing is looked at, shown
// wherever it is listed, managed and moved as BIP329 files, kept across a reload, harmless when
// hostile, the site unchanged without storage, and never sent anywhere.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { bip329, type Line, seedLabels } from "./labels";

const TX = chain.txs.script_types;
const AXE = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

interface Tx {
  vout: { scriptpubkey_address?: string }[];
  vin: { txid: string; vout: number; prevout?: { scriptpubkey_address?: string } }[];
  status: { block_hash?: string };
}

/** The scenario's transaction, as the API serves it: what it pays and where it was mined. */
async function scriptTypes(page: Page): Promise<Tx> {
  const res = await page.request.get(`/regtest/api/tx/${TX}`);
  return (await res.json()) as Tx;
}

/** The label shown inside `within`, as the reader sees it (without the screen-reader prefix). */
const tagIn = (within: ReturnType<Page["locator"]>) => within.locator(".your-label__text");

/** Imports `text` through the manager's real file input and confirms the plan. */
async function importFile(page: Page, text: string, name = "labels.jsonl") {
  await page.goto("/regtest/labels");
  await expect(page.getByRole("button", { name: "Import a file" })).toBeEnabled();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "application/jsonl", buffer: Buffer.from(text) });
}

test.describe("on a transaction's page", () => {
  test("a label is added, edited and removed from the keyboard, and kept across a reload", async ({
    page,
  }) => {
    await page.goto(`/regtest/tx/${TX}`);
    const head = page.locator(".tx-head");
    const add = head.getByRole("button", { name: "Add a label" });
    await add.focus();
    await page.keyboard.press("Enter");
    const field = page.getByRole("textbox", { name: "Your label for this transaction" });
    await expect(field).toBeFocused();
    await page.keyboard.type("rent, March");
    await page.keyboard.press("Enter");
    await expect(tagIn(head)).toHaveText("rent, March");
    const edit = head.getByRole("button", { name: "Edit label" });
    await expect(edit).toBeFocused();
    await expect(head.getByRole("status")).toHaveText("Label saved");

    await page.reload();
    await expect(tagIn(head)).toHaveText("rent, March");

    // Escape leaves it as it was.
    await edit.click();
    await expect(field).toHaveValue("rent, March");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("rent, April");
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(tagIn(head)).toHaveText("rent, March");
    await expect(edit).toBeFocused();

    await edit.click();
    await field.fill("rent, April");
    await page.getByRole("button", { name: "Save label" }).click();
    await expect(tagIn(head)).toHaveText("rent, April");

    await edit.click();
    await page.getByRole("button", { name: "Remove label" }).click();
    await expect(head.locator(".your-label")).toHaveCount(0);
    await expect(head.getByRole("button", { name: "Add a label" })).toBeFocused();
    await page.reload();
    await expect(head.getByRole("button", { name: "Add a label" })).toBeVisible();
    await expect(head.locator(".your-label")).toHaveCount(0);
  });

  test("an output is labelled from its details, and its card shows it", async ({ page }) => {
    await page.goto(`/regtest/tx/${TX}`);
    await page.getByRole("button", { name: "Details of output 1" }).click();
    const inspector = page.locator("#tx-inspector");
    await inspector.getByRole("button", { name: "Add a label" }).click();
    await page.getByRole("textbox", { name: "Your label for output 1" }).fill("change");
    await page.keyboard.press("Enter");
    const card = page.getByRole("list", { name: "Outputs" }).getByRole("listitem").nth(1);
    await expect(tagIn(card)).toHaveText("change");
    // Another output's details have no label, and no editor carried over.
    await page.getByRole("button", { name: "Details of output 0" }).click();
    await expect(inspector.getByRole("button", { name: "Add a label" })).toBeVisible();
  });
});

test("a labelled address and transaction show on the cards, the history, the coins and the block's list", async ({
  page,
}) => {
  const tx = await scriptTypes(page);
  const paid = tx.vout[0]?.scriptpubkey_address ?? "";
  const spent = tx.vin[0];
  expect(paid).not.toBe("");
  await seedLabels(page, [
    { type: "addr", ref: paid, label: "cold storage" },
    { type: "tx", ref: TX, label: "rent, March" },
    ...(spent
      ? [{ type: "output", ref: `${spent.txid}:${spent.vout}`, label: "savings coin" }]
      : []),
  ]);

  // The transaction: its own label in the head, the address's on the output's card, the spent
  // coin's on the input's card.
  await page.goto(`/regtest/tx/${TX}`);
  await expect(tagIn(page.locator(".tx-head"))).toHaveText("rent, March");
  const outputs = page.getByRole("list", { name: "Outputs" });
  await expect(tagIn(outputs.getByRole("listitem").first())).toHaveText("cold storage");
  if (spent) {
    const inputs = page.getByRole("list", { name: "Inputs" });
    await expect(tagIn(inputs.getByRole("listitem").first())).toHaveText("savings coin");
  }
  // Read aloud as the reader's own.
  await expect(page.locator(".tx-head .your-label")).toContainText("Your label: rent, March");

  // The address: its label in the head, the transaction's in its history and on its coins.
  await outputs.getByRole("listitem").first().getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/regtest/address/${paid}$`));
  await expect(tagIn(page.locator(".address-head"))).toHaveText("cold storage");
  const history = page.getByRole("table").first();
  await expect(history.getByRole("row").filter({ hasText: "rent, March" })).toHaveCount(1);

  // The block's list.
  await page.goto(`/regtest/block/${tx.status.block_hash ?? ""}`);
  const row = page.getByRole("row").filter({ has: page.locator(`a[href$="/tx/${TX}"]`) });
  await expect(tagIn(row)).toHaveText("rent, March");
});

test.describe("the manager", () => {
  test("is reachable from the footer and says where labels are kept", async ({ page }) => {
    await page.goto("/regtest/");
    await page.getByRole("contentinfo").getByRole("link", { name: "Your labels" }).click();
    await expect(page).toHaveURL(/\/regtest\/labels$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your labels");
    await expect(page.getByRole("complementary")).toContainText(
      "Your labels never leave this browser",
    );
    await expect(page.getByRole("complementary")).toContainText("lost if this site's data");
    await expect(page.getByText("No labels yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export a file" })).toBeDisabled();
  });

  test("imports a file, says what it skipped, and exports what Sparrow's format holds, untouched", async ({
    page,
  }) => {
    const good: Line[] = [
      { type: "tx", ref: TX, label: "Transaction", origin: "wpkh([d34db33f/84'/0'/0'])" },
      { type: "addr", ref: chain.addresses.p2wpkh, label: "Address" },
      {
        type: "output",
        ref: `${TX}:1`,
        label: "Output",
        spendable: false,
        value: 12345,
        fmv: { USD: 1233.45 },
      },
      {
        type: "xpub",
        ref: "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8",
        label: "Extended Public Key",
      },
    ];
    // The BIP's own spacing on one line, kept as written.
    const spaced = `{ "type": "pubkey", "ref": "0283409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f448", "label": "Public Key" }`;
    const text = `${bip329(good)}${spaced}\nnot json\n{"type":"tx","ref":"abc"}\n\n`;
    await importFile(page, text);
    const plan = page.getByRole("status").filter({ hasText: "labels.jsonl" });
    await expect(plan).toContainText("7 lines read");
    await expect(plan).toContainText("5 labels are new to this browser.");
    await expect(plan).toContainText(
      "2 lines were skipped (from line 6, 7): 1 not valid JSON; 1 no reference, or one that does not fit its type.",
    );
    await page.getByRole("button", { name: "Import 5 labels" }).click();
    await expect(page.getByText("Imported 5 labels.")).toBeVisible();
    await expect(page.getByRole("table")).toContainText("Extended public key");

    // An xpub is listed, never linked: looking it up would send it to the server.
    const xpubRow = page.getByRole("row").filter({ hasText: "Extended public key" });
    await expect(xpubRow.getByRole("link")).toHaveCount(0);

    const [file] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export a file" }).click(),
    ]);
    expect(file.suggestedFilename()).toBe(
      `rbitcoin-labels-${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    const out = await readFile(await file.path(), "utf8");
    expect(out).toBe(`${bip329(good)}${spaced}\n`);

    // Importing the export again changes nothing and loses nothing.
    await importFile(page, out, "again.jsonl");
    await expect(page.getByRole("status").filter({ hasText: "again.jsonl" })).toContainText(
      "5 replace labels you have",
    );
    await page.getByRole("button", { name: "Import 5 labels" }).click();
    const [again] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export a file" }).click(),
    ]);
    expect(await readFile(await again.path(), "utf8")).toBe(out);
  });

  test("finds, edits and deletes labels, and deletes all after asking", async ({ page }) => {
    await seedLabels(page, [
      { type: "tx", ref: TX, label: "rent, March" },
      { type: "addr", ref: chain.addresses.p2tr, label: "cold storage" },
    ]);
    await page.goto("/regtest/labels");
    await page.getByLabel("Find a label").fill("cold");
    await expect(page.getByRole("row")).toHaveCount(2);
    await page.getByRole("button", { name: /^Edit the label of address/ }).click();
    const field = page.getByRole("textbox", { name: /^Your label for address/ });
    await field.fill("cold storage, vault");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("table")).toContainText("cold storage, vault");
    await page.getByLabel("Find a label").fill("");
    await page.getByRole("button", { name: /^Delete the label of transaction/ }).click();
    await expect(page.getByRole("table")).not.toContainText("rent, March");
    await page.getByRole("button", { name: "Delete all" }).click();
    await page.getByRole("button", { name: "Delete all labels" }).click();
    await expect(page.getByText("No labels yet.")).toBeVisible();
    await page.goto(`/regtest/address/${chain.addresses.p2tr}`);
    await expect(page.locator(".your-label")).toHaveCount(0);
  });

  test("refuses a file over its size with a plain message, and reads 100 000 lines without holding the page", async ({
    page,
  }) => {
    await page.goto("/regtest/labels");
    await page.locator('input[type="file"]').setInputFiles({
      name: "huge.jsonl",
      mimeType: "application/jsonl",
      buffer: Buffer.alloc(21 * 1024 * 1024, 0x20),
    });
    await expect(page.getByRole("alert")).toContainText(
      "This file is 21.0 MB. The most this page reads is 20.0 MB",
    );
    await page.getByRole("button", { name: "Close" }).click();

    const lines = Array.from(
      { length: 100_000 },
      (_, i) => `{"type":"output","ref":"${TX}:${i}","label":"coin ${i}"}`,
    ).join("\n");
    // Handing Playwright's 6.5 MB file to the input holds the page by itself (0.8 s here) before
    // the page hears of it; what is measured starts after, while the page reads and saves.
    await page.locator('input[type="file"]').setInputFiles({
      name: "many.jsonl",
      mimeType: "application/jsonl",
      buffer: Buffer.from(lines),
    });
    // The longest the page then goes without drawing a frame, and its longest task.
    await page.evaluate(() => {
      const w = window as unknown as { longest: number; tasks: number };
      w.longest = 0;
      w.tasks = 0;
      let last = performance.now();
      const tick = (t: number) => {
        w.longest = Math.max(w.longest, t - last);
        last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.tasks = Math.max(w.tasks, e.duration);
      }).observe({ type: "longtask" });
    });
    await page.getByRole("button", { name: "Import 100 000 labels" }).click({ timeout: 30_000 });
    await expect(page.getByText("Imported 100 000 labels.")).toBeVisible({ timeout: 60_000 });
    const { longest, tasks } = await page.evaluate(() => {
      const w = window as unknown as { longest: number; tasks: number };
      return { longest: w.longest, tasks: w.tasks };
    });
    test.info().annotations.push({
      type: "100 000 lines",
      description: `longest gap between frames ${Math.round(longest)} ms, longest task ${Math.round(tasks)} ms`,
    });
    // A frozen page shows a gap of seconds. Idle, the longest is about 70 ms (the index of 100 000
    // labels built again after the save); the whole suite at once stretched it to 380 ms. That
    // the reading yields between slices is bip329.test.ts's to prove.
    expect(longest).toBeLessThan(1000);
    await page.goto(`/regtest/tx/${TX}`);
    const cards = page.getByRole("list", { name: "Outputs" }).getByRole("listitem");
    await expect(tagIn(cards.first())).toHaveText("coin 0");
    await expect(tagIn(cards.nth(1))).toHaveText("coin 1");
  });
});

test("hostile labels from a file are shown as inert, marked text", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  const evil = [
    `<img src=x onerror="window.pwned=1">`,
    `<script>window.pwned=2</script>`,
    `Confirmed${String.fromCodePoint(0x20_2e)}skcolb 6`,
    `a${String.fromCodePoint(0, 0x1b)}[31mred`,
    "W".repeat(5000),
  ];
  await seedLabels(page, [
    { type: "tx", ref: TX, label: evil[0] ?? "" },
    { type: "output", ref: `${TX}:0`, label: evil[1] ?? "" },
    { type: "output", ref: `${TX}:1`, label: evil[2] ?? "" },
    { type: "output", ref: `${TX}:2`, label: evil[3] ?? "" },
    { type: "output", ref: `${TX}:3`, label: evil[4] ?? "" },
  ]);
  await page.goto(`/regtest/tx/${TX}`);
  await expect(tagIn(page.locator(".tx-head"))).toHaveText(evil[0] ?? "");
  const tags = page.locator(".your-label");
  await expect(tags).toHaveCount(5);
  // Only text inside each tag: no element came from a label.
  for (const t of await tags.all()) {
    expect(await t.evaluate((el) => [...el.querySelectorAll("*")].map((n) => n.className))).toEqual(
      ["visually-hidden", "your-label__text"],
    );
  }
  const shown = await page.locator(".your-label__text").allTextContents();
  expect(shown.some((s) => /[\p{Cc}\p{Cf}]/u.test(s))).toBe(false);
  // The long one is cut, and stays inside its card.
  const long = page.locator(".your-label").filter({ hasText: "WWW" });
  expect((await long.locator(".your-label__text").textContent())?.length).toBeLessThanOrEqual(41);
  const card = page.getByRole("list", { name: "Outputs" }).getByRole("listitem").nth(3);
  const [tagBox, cardBox] = [await long.boundingBox(), await card.boundingBox()];
  expect((tagBox?.x ?? 0) + (tagBox?.width ?? 0)).toBeLessThanOrEqual(
    (cardBox?.x ?? 0) + (cardBox?.width ?? 0) + 0.5,
  );
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
  ).toBeUndefined();
  expect(dialogs).toBe(0);
});

test.describe("without storage", () => {
  test("the site works as before, and says labels cannot be kept", async ({ page, context }) => {
    await context.addInitScript(() => {
      const refuse = () => {
        throw new DOMException("blocked", "SecurityError");
      };
      Object.defineProperty(window, "indexedDB", { get: refuse });
      Object.defineProperty(window, "localStorage", { get: refuse });
    });
    await page.goto(`/regtest/tx/${TX}`);
    await expect(page.getByRole("list", { name: "Outputs" })).toBeVisible();
    await page.getByRole("button", { name: "Add a label" }).click();
    await page.getByRole("textbox", { name: "Your label for this transaction" }).fill("x");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText("labels cannot be kept here");
    await page.goto("/regtest/labels");
    await expect(page.getByRole("heading", { name: "Labels cannot be kept here" })).toBeVisible();
    await expect(page.getByRole("complementary")).toContainText("never leave this browser");
  });
});

test("axe finds nothing on a labelled page, the editor open, and the manager with an import planned", async ({
  page,
}) => {
  await seedLabels(page, [
    { type: "tx", ref: TX, label: "rent, March" },
    { type: "output", ref: `${TX}:0`, label: "change" },
  ]);
  const axe = async () => {
    await page.evaluate(AXE);
    return page.evaluate(async () => {
      const run = (window as unknown as { axe: { run: (...a: unknown[]) => Promise<unknown> } }).axe
        .run;
      const r = (await run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
        },
        rules: { "label-content-name-mismatch": { enabled: false } },
        resultTypes: ["violations"],
      })) as { violations: { id: string; nodes: { target: string[] }[] }[] };
      return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} at ${n.target.join(" ")}`));
    });
  };
  await page.goto(`/regtest/tx/${TX}`);
  await expect(tagIn(page.locator(".tx-head"))).toHaveText("rent, March");
  await page.locator(".tx-head").getByRole("button", { name: "Edit label" }).click();
  await expect(
    page.getByRole("textbox", { name: "Your label for this transaction" }),
  ).toBeFocused();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect.soft(await axe(), `transaction page, ${scheme}`).toEqual([]);
  }
  await importFile(
    page,
    `${bip329([{ type: "addr", ref: chain.addresses.p2wpkh, label: "a" }])}x\n`,
  );
  await expect(page.getByRole("button", { name: "Import 1 label" })).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect.soft(await axe(), `manager, ${scheme}`).toEqual([]);
  }
});

// ---- Nothing about a label reaches the server ----

/** Every request a page made, and every WebSocket frame it sent, as text to search. */
interface Seen {
  requests: Set<string>;
  frames: Set<string>;
  everything: string[];
  /** Each request's headers, read as they come. */
  pending: Promise<void>[];
  /** Resolves once no request has been in flight for a moment, or after a few seconds regardless. */
  quiet: () => Promise<void>;
}

function watch(context: BrowserContext): Seen {
  let flying = 0;
  let last = Date.now();
  const landed = () => {
    flying--;
    last = Date.now();
  };
  context.on("requestfinished", landed);
  context.on("requestfailed", landed);
  const quiet = () =>
    new Promise<void>((resolve) => {
      const cap = Date.now() + 5000;
      const look = () => {
        const busy = flying > 0 || Date.now() - last < 400;
        if (busy && Date.now() < cap) setTimeout(look, 50);
        else resolve();
      };
      look();
    });
  const seen: Seen = {
    requests: new Set(),
    frames: new Set(),
    everything: [],
    pending: [],
    quiet,
  };
  context.on("request", (r) => {
    flying++;
    last = Date.now();
    const url = new URL(r.url());
    seen.requests.add(`${r.method()} ${url.pathname}${url.search}`);
    seen.everything.push(r.url(), r.postData() ?? "");
    seen.pending.push(
      r.allHeaders().then(
        (h) => {
          seen.everything.push(JSON.stringify(h));
        },
        () => undefined,
      ),
    );
  });
  context.on("page", (p) => watchSockets(p, seen));
  return seen;
}

function watchSockets(page: Page, seen: Seen) {
  page.on("websocket", (ws) => {
    seen.everything.push(ws.url());
    ws.on("framesent", (f) => {
      const text = typeof f.payload === "string" ? f.payload : f.payload.toString("utf8");
      seen.everything.push(text);
      // What a frame asks, topic by topic: the client batches what it asks in one turn, so how
      // topics share frames follows timing, not labels.
      for (const each of asks(text)) seen.frames.add(each);
    });
  });
}

/** A socket message's requests, one per topic: `subscribe tx:…`; the message itself otherwise. */
function asks(text: string): string[] {
  try {
    const m = JSON.parse(text) as { op?: unknown; topics?: unknown };
    if (typeof m.op === "string" && Array.isArray(m.topics))
      return m.topics.map((t) => `${m.op as string} ${String(t)}`);
  } catch {
    // Not JSON: compared whole.
  }
  return [text];
}

/** The same walk through the site, with or without labels. */
async function walk(page: Page, seen: Seen, block: string, paid: string) {
  await page.goto(`/regtest/tx/${TX}`);
  await expect(page.getByRole("list", { name: "Outputs" })).toBeVisible();
  await page.getByRole("button", { name: "Details of output 0" }).click();
  // The editor's code is fetched on a press, whether the press adds a label or edits one.
  await page.locator(".tx-head .label-control__open").click();
  await expect(page.locator(".tx-head .label-editor")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("list", { name: "Outputs" }).getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/address/${paid}$`));
  await expect(page.locator(".address-head")).toBeVisible();
  await seen.quiet();
  await page.goto(`/regtest/block/${block}`);
  await expect(page.locator(`a[href$="/tx/${TX}"]`).first()).toBeVisible();
  await seen.quiet();
  await page.goto("/regtest/labels");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your labels");
  await seen.quiet();
}

async function visitor(browser: Browser, baseURL: string, headers: Record<string, string>) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: headers });
  const page = await context.newPage();
  return { context, page };
}

test("nothing about a label reaches the server: the same requests with labels as without, none naming one", async ({
  browser,
  baseURL,
  extraHTTPHeaders,
  page: helper,
}) => {
  const tx = await scriptTypes(helper);
  const paid = tx.vout[0]?.scriptpubkey_address ?? "";
  const block = tx.status.block_hash ?? "";
  // Labels on what the walk shows, and on things it never shows: their references must not leave
  // either. Every label's text is a word no page of the site holds.
  const unseenTx = "ab".repeat(32);
  const xpub =
    "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
  const unseenAddr = "bcrt1qq8u9ac5wpyv7q4mmtvnq7l3wnxkfsgxh4dlz6p";
  const labels: Line[] = [
    { type: "tx", ref: TX, label: "zebra-quartz-label-one" },
    { type: "addr", ref: paid, label: "zebra-quartz-label-two" },
    { type: "output", ref: `${TX}:0`, label: "zebra-quartz-label-three" },
    { type: "tx", ref: unseenTx, label: "zebra-quartz-label-four" },
    { type: "xpub", ref: xpub, label: "zebra-quartz-label-five" },
    { type: "addr", ref: unseenAddr, label: "zebra-quartz-label-six" },
  ];
  const needles = [
    "zebra",
    "quartz",
    unseenTx,
    xpub,
    "xpub661MyMwAqRbc",
    unseenAddr,
    encodeURIComponent("zebra-quartz"),
  ];

  const runs: Seen[] = [];
  for (const withLabels of [false, true]) {
    const { context, page } = await visitor(browser, baseURL ?? "", extraHTTPHeaders ?? {});
    try {
      // Both start on the same page that loads no app; only one leaves labels in the store.
      await (withLabels ? seedLabels(page, labels) : page.goto("/healthz"));
      const seen = watch(context);
      watchSockets(page, seen);
      await walk(page, seen, block, paid);
      // The labels were on screen in the one run, so the walk did meet them.
      await expect(
        page.getByText(withLabels ? "zebra-quartz-label-six" : "No labels yet."),
      ).toBeVisible();
      await page.goto(`/regtest/tx/${TX}`);
      await expect(page.locator(".tx-head .your-label")).toHaveCount(withLabels ? 1 : 0);
      await seen.quiet();
      await Promise.all(seen.pending);
      runs.push(seen);
    } finally {
      await context.close();
    }
  }
  const [without, withLabels] = runs as [Seen, Seen];
  const all = withLabels.everything.join("\n");
  for (const n of needles) expect(all.includes(n), `"${n}" was sent`).toBe(false);
  // The very same requests and socket messages, as sets: polling may repeat a request, never add one.
  const sorted = (s: Set<string>) => {
    const list = [...s];
    list.sort((a, b) => a.localeCompare(b));
    return list;
  };
  expect(sorted(withLabels.requests)).toEqual(sorted(without.requests));
  expect(sorted(withLabels.frames)).toEqual(sorted(without.frames));
  test.info().annotations.push({
    type: "requests compared",
    description: `${withLabels.requests.size} distinct requests, ${withLabels.everything.length} URLs, headers, bodies and frames searched`,
  });
});
