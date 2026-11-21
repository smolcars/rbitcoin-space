// The reader's own labels (docs/FRONTEND.md "Your labels"): set where a thing is looked at, shown
// wherever it is listed, managed and moved as BIP329 files, kept across a reload, harmless when
// hostile, the site unchanged without storage, and never sent anywhere.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { bip329, labelled, type Line, seedLabels } from "./labels";

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
      "Your labels, and the list of what you have labelled, stay in this browser",
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

  test("refuses a file over its size with a plain message", async ({ page }) => {
    await page.goto("/regtest/labels");
    await page.locator('input[type="file"]').setInputFiles({
      name: "huge.jsonl",
      mimeType: "application/jsonl",
      buffer: Buffer.alloc(9 * 1024 * 1024, 0x20),
    });
    await expect(page.getByRole("alert")).toContainText(
      "This file is 9.0 MB. The most this page reads is 8.0 MB",
    );
  });

  test("the worst import at the limits, 50 000 labels each replaced, never holds the page", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    /** The longest the page goes without drawing a frame, from now until asked. */
    const startWatch = () =>
      page.evaluate(() => {
        const w = window as unknown as { longest: number; watching: number };
        w.longest = 0;
        w.watching = (w.watching ?? 0) + 1;
        const run = w.watching;
        let last = performance.now();
        const tick = (t: number) => {
          if (w.watching !== run) return;
          w.longest = Math.max(w.longest, t - last);
          last = t;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    const longest = () =>
      page.evaluate(() => Math.round((window as unknown as { longest: number }).longest));
    const file = (name: string, lines: string[]) => ({
      name,
      mimeType: "application/jsonl",
      buffer: Buffer.from(`${lines.join("\n")}\n`),
    });
    const N = 50_000;
    await page.goto("/regtest/labels");
    await expect(page.getByRole("button", { name: "Import a file" })).toBeEnabled();
    // 50 000 labels kept: the most there may be.
    await page.locator('input[type="file"]').setInputFiles(
      file(
        "held.jsonl",
        Array.from({ length: N }, (_, i) =>
          JSON.stringify({ type: "output", ref: `${TX}:${i}`, label: `coin ${i}` }),
        ),
      ),
    );
    await page.getByRole("button", { name: "Import 50 000 labels" }).click({ timeout: 60_000 });
    await expect(page.getByText(/^Imported 50\s000 labels\./)).toBeVisible({ timeout: 60_000 });
    // A file as near the 8 MiB limit as 50 000 lines go, each replacing a kept record and leaving
    // its label out, so every record is merged with the one kept: the most work an import does.
    const filler = "f".repeat(42);
    const replacing = Array.from({ length: N }, (_, i) =>
      JSON.stringify({ type: "output", ref: `${TX}:${i}`, spendable: true, note: filler }),
    );
    const big = file("replacing.jsonl", replacing);
    expect(big.buffer.length).toBeGreaterThan(7.5 * 1024 * 1024);
    expect(big.buffer.length).toBeLessThan(8 * 1024 * 1024);
    // Handing Playwright's file to the input holds the page by itself before the page hears of
    // it; what is measured starts after, while the page reads, previews, and then saves.
    await page.locator('input[type="file"]').setInputFiles(big);
    await startWatch();
    const confirm = page.getByRole("button", { name: "Import 50 000 labels" });
    await expect(confirm).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/50\s000 replace labels you have/)).toBeVisible();
    const preview = await longest();
    await startWatch();
    await confirm.click();
    await expect(page.getByText(/^Imported 50\s000 labels\./)).toBeVisible({ timeout: 60_000 });
    const saving = await longest();
    test.info().annotations.push({
      type: "worst import at the limits",
      description: `longest gap between frames: ${preview} ms reading and previewing, ${saving} ms confirming`,
    });
    expect(saving).toBeLessThan(100);
    expect(preview).toBeLessThan(100);
    await page.goto(`/regtest/tx/${TX}`);
    const cards = page.getByRole("list", { name: "Outputs" }).getByRole("listitem");
    await expect(tagIn(cards.first())).toHaveText("coin 0");
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
    await expect(page.getByRole("complementary")).toContainText("stay in this browser");
  });
});

// Under reduced motion, as the accessibility pass runs: a theme switch otherwise leaves the
// buttons' colours mid-transition when axe measures them.
test.describe("under reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
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
        const run = (window as unknown as { axe: { run: (...a: unknown[]) => Promise<unknown> } })
          .axe.run;
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
});

// ---- Nothing about a label reaches the server ----

/** Every request a page made and every socket message, as text to compare and search. */
interface Seen {
  /** Each request: method, whole URL (origin included) and body, in the order made. */
  requests: string[];
  /** Each request with its headers, for the search. */
  raw: string[];
  /** Every socket message the page sent, whole, in order. */
  sent: string[];
  /** Every socket message the page was given, whole, in order. */
  received: string[];
  /** What happened when, for the schedule's own checks: "asked <path>", "gave <message>". */
  events: string[];
  /** Each request's headers, read as they come. */
  pending: Promise<void>[];
}

function watch(context: BrowserContext): Seen {
  const seen: Seen = { requests: [], raw: [], sent: [], received: [], events: [], pending: [] };
  context.on("request", (r) => {
    const line = `${r.method()} ${r.url()} | ${r.postData() ?? ""}`;
    seen.requests.push(line);
    seen.events.push(`asked ${new URL(r.url()).pathname}`);
    // Every header the browser sent, once it reports them; a request still in flight when the
    // walk ends is searched with the headers known when it was made.
    const known = r.headers();
    const late = new Promise<Record<string, string>>((resolve) => {
      setTimeout(() => resolve(known), 2000);
    });
    seen.pending.push(
      Promise.race([r.allHeaders().catch(() => known), late]).then((h) => {
        seen.raw.push(`${line} | ${JSON.stringify(h)}`);
      }),
    );
  });
  return seen;
}

/**
 * The page's socket, passed through to the real server under the test's own schedule. While
 * `held`, what the server says is kept back, greeting included, until `release`: a page's first
 * answers then always come before the socket's, in both runs.
 */
interface Gate {
  held: boolean;
  release: () => void;
}

async function scheduleSocket(context: BrowserContext, seen: Seen): Promise<Gate> {
  const waiting: (() => void)[] = [];
  const gate: Gate = {
    held: false,
    release: () => {
      gate.held = false;
      for (const give of waiting.splice(0)) give();
    },
  };
  await context.routeWebSocket(/\/app\/ws$/, (ws) => {
    const server = ws.connectToServer();
    seen.sent.push(`open ${ws.url()}`);
    ws.onMessage((m) => {
      seen.sent.push(typeof m === "string" ? m : m.toString("utf8"));
      server.send(m);
    });
    server.onMessage((m) => {
      const text = typeof m === "string" ? m : m.toString("utf8");
      const give = () => {
        seen.received.push(text);
        seen.events.push(`gave ${text.slice(0, 80)}`);
        ws.send(m);
      };
      if (gate.held) waiting.push(give);
      else give();
    });
  });
  return gate;
}

/** Each topic's socket operations, in the order the page sent them. */
function opsByTopic(sent: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const text of sent) {
    try {
      const m = JSON.parse(text) as { op?: unknown; topics?: unknown };
      if (typeof m.op === "string" && Array.isArray(m.topics))
        for (const t of m.topics) (out[String(t)] ??= []).push(m.op);
    } catch {
      (out["(other)"] ??= []).push(text);
    }
  }
  return out;
}

/** Waits for each response named, in any order, `times` of each when asked for more than one. */
function answers(page: Page, needs: readonly (RegExp | [RegExp, number])[]) {
  return Promise.all(
    needs.flatMap((n) => {
      const [re, times] = Array.isArray(n) ? n : [n, 1];
      let seenTimes = 0;
      return [
        page.waitForResponse(
          (r) =>
            re.test(new URL(r.url()).pathname + new URL(r.url()).search) && ++seenTimes >= times,
          { timeout: 15_000 },
        ),
      ];
    }),
  );
}

/** Goes somewhere and waits for what that page is known to need. Never a wait for quiet. */
async function arrive(
  page: Page,
  seen: Seen,
  go: () => Promise<unknown>,
  needs: readonly (RegExp | [RegExp, number])[],
  socket?: RegExp,
) {
  const since = seen.received.length;
  const answered = answers(page, needs);
  await go();
  await answered;
  if (socket)
    await expect
      .poll(() => seen.received.slice(since).some((m) => socket.test(m)), { timeout: 10_000 })
      .toBe(true);
}

/** What the walk imports, in both runs: labels on things the walk shows and on things it never does. */
const UNSEEN_TX = "ab".repeat(32);
const XPUB =
  "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
const UNSEEN_ADDR = "bcrt1qq8u9ac5wpyv7q4mmtvnq7l3wnxkfsgxh4dlz6p";

/** Uses the manager: imports, finds, edits, deletes and exports, as a reader would. */
async function manage(page: Page, file: string) {
  await page.goto("/regtest/labels");
  await expect(page.getByRole("button", { name: "Import a file" })).toBeEnabled();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "w.jsonl", mimeType: "application/jsonl", buffer: Buffer.from(file) });
  await page.getByRole("button", { name: /^Import \d+ labels?$/ }).click();
  await expect(page.getByText(/^Imported /)).toBeVisible();
  await page.getByLabel("Find a label").fill("zebra-quartz-label-four");
  await page.getByRole("button", { name: /^Edit the label of transaction/ }).click();
  await page
    .getByRole("textbox", { name: /^Your label for transaction/ })
    .fill("zebra-quartz-edited");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Label saved")).toBeAttached();
  await page.getByLabel("Find a label").fill("zebra-quartz-edited");
  await expect(page.getByRole("table")).toContainText("zebra-quartz-edited");
  await page.getByLabel("Find a label").fill("zebra-quartz-label-six");
  await page.getByRole("button", { name: /^Delete the label of address/ }).click();
  await expect(page.getByText("No label matches.")).toBeVisible();
  await page.getByLabel("Find a label").fill("");
  const [file2] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export a file" }).click(),
  ]);
  expect(file2.suggestedFilename()).toMatch(/\.jsonl$/);
}

/**
 * The same walk through the site, with or without labels already kept, on one schedule:
 * - The transaction and block pages: the socket's greeting and everything after it are held until
 *   the page's first answers have come, so the page always has its answers before the socket's.
 * - The address page: its first status passes straight through, so the page asks once, on that
 *   status, never on its one-second fallback (checked below); and the address's totals are held
 *   1.2 s, so their own one-second timer always fires first and the ledger is always asked twice.
 */
async function walk(page: Page, seen: Seen, gate: Gate, block: string, paid: string, file: string) {
  gate.held = true;
  await arrive(page, seen, () => page.goto(`/regtest/tx/${TX}`), [
    new RegExp(`/api/tx/${TX}$`),
    new RegExp(`/api/tx/${TX}/outspends$`),
    /\/api\/blocks\/tip\/height$/,
    new RegExp(`/app/tx/${TX}/replacements$`),
    /\/app\/lightning\/status$/,
    /\/app\/blocks\/summary\?/,
  ]);
  gate.release();
  await expect
    .poll(() => seen.received.some((m) => m.includes(`"topic":"tx:${TX}"`)), { timeout: 10_000 })
    .toBe(true);
  await page.getByRole("button", { name: "Details of output 0" }).click();
  // A label typed and saved: added in one run, an edit in the other.
  await page.locator(".tx-head .label-control__open").click();
  await page.getByRole("textbox", { name: "Your label for this transaction" }).fill("zebra-typed");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tx-head .your-label__text")).toHaveText("zebra-typed");
  await page.route(new RegExp(`/api/address/${paid}$`), async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 1200);
    });
    await route.continue();
  });
  await arrive(
    page,
    seen,
    () => page.getByRole("list", { name: "Outputs" }).getByRole("link").first().click(),
    [
      new RegExp(`/api/address/${paid}$`),
      new RegExp(`/api/address/${paid}/txs$`),
      new RegExp(`/api/address/${paid}/txs/summary$`),
      // Asked when the totals' own timer fires, and again when they come.
      [new RegExp(`/app/address/${paid}/ledger$`), 2],
    ],
    /"state":"watching"/,
  );
  // The schedule held: the page asked for the address's totals only after its first status.
  const status = seen.events.findIndex((e) => e.startsWith("gave") && e.includes('"watching"'));
  const totals = seen.events.indexOf(`asked /regtest/api/address/${paid}`);
  expect(
    status !== -1 && status < totals,
    "the server answered the address's subscription before the page's one-second fallback",
  ).toBe(true);
  gate.held = true;
  await arrive(page, seen, () => page.goto(`/regtest/block/${block}`), [
    new RegExp(`/api/block/${block}$`),
    new RegExp(`/api/block/${block}/status$`),
    new RegExp(`/api/block/${block}/txs/0$`),
    new RegExp(`/app/block/${block}/txs\\?v=2$`),
    /\/app\/blocks\/summary\?/,
  ]);
  gate.release();
  await expect
    .poll(() => seen.received.some((m) => m.includes('"network":"regtest"')), { timeout: 10_000 })
    .toBe(true);
  await expect
    .poll(() => seen.sent.some((m) => m.includes('"blocks"')), { timeout: 10_000 })
    .toBe(true);
  await manage(page, file);
}

async function visitor(browser: Browser, baseURL: string, headers: Record<string, string>) {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: headers,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  return { context, page };
}

test("nothing about a label reaches the server: exactly the same requests with labels as without", async ({
  browser,
  baseURL,
  extraHTTPHeaders,
  page: helper,
}) => {
  test.setTimeout(90_000);
  const tx = await scriptTypes(helper);
  const paid = tx.vout[0]?.scriptpubkey_address ?? "";
  const block = tx.status.block_hash ?? "";
  // Every label's text is a word no page of the site holds.
  const labels: Line[] = [
    { type: "tx", ref: TX, label: "zebra-quartz-label-one" },
    { type: "addr", ref: paid, label: "zebra-quartz-label-two" },
    { type: "output", ref: `${TX}:0`, label: "zebra-quartz-label-three" },
    { type: "tx", ref: UNSEEN_TX, label: "zebra-quartz-label-four" },
    { type: "xpub", ref: XPUB, label: "zebra-quartz-label-five" },
    { type: "addr", ref: UNSEEN_ADDR, label: "zebra-quartz-label-six" },
  ];
  const needles = [
    "zebra",
    "quartz",
    UNSEEN_TX,
    XPUB,
    "xpub661MyMwAqRbc",
    UNSEEN_ADDR,
    encodeURIComponent("zebra-quartz"),
  ];

  const runs: Seen[] = [];
  for (const withLabels of [false, true]) {
    const { context, page } = await visitor(browser, baseURL ?? "", extraHTTPHeaders ?? {});
    try {
      // Watched from the first request: both runs open the same page that loads no app, and only
      // one leaves labels (and the hint) in the browser from it.
      const seen = watch(context);
      const gate = await scheduleSocket(context, seen);
      await (withLabels ? seedLabels(page, labels) : page.goto("/healthz"));
      await walk(page, seen, gate, block, paid, bip329(labels));
      await Promise.all(seen.pending);
      runs.push(seen);
    } finally {
      await context.close();
    }
  }
  const [without, withLabels] = runs as [Seen, Seen];
  // Every request, with all its headers and body, and every socket message whole, searched.
  for (const run of runs) {
    const all = [...run.raw, ...run.sent].join("\n");
    for (const n of needles) expect(all.includes(n), `"${n}" was sent`).toBe(false);
  }
  // Under one schedule there is nothing left to timing: the very same requests, each as many
  // times, and each socket topic's operations in the same order.
  const counted = (list: readonly string[]) => {
    const copy = [...list];
    copy.sort((x, y) => x.localeCompare(y));
    return copy;
  };
  expect(counted(withLabels.requests)).toEqual(counted(without.requests));
  expect(opsByTopic(withLabels.sent)).toEqual(opsByTopic(without.sent));
  test.info().annotations.push({
    type: "requests compared",
    description: `${withLabels.requests.length} requests and ${withLabels.sent.length} socket messages, all compared and searched`,
  });
});

test.describe("the manager", () => {
  // The transaction a label names is not on regtest: opening it is answered "not found".
  test.use({ consoleErrorsAllowed: [/status of 404/] });
  test("the manager asks the server for nothing: loading, finding, editing, deleting, importing, exporting", async ({
    page,
    context,
  }) => {
    await seedLabels(page, labelled(TX, [chain.addresses.p2wpkh]));
    // Watched once the manager has loaded and shown its list: from then on, every action below is
    // done when its result shows, and nothing it does may have asked the server for anything.
    const config = page.waitForResponse((r) => r.url().endsWith("/app/config"));
    await page.goto("/regtest/labels");
    await config;
    await expect(page.getByRole("cell").first()).toBeVisible();
    const seen = watch(context);
    const file = bip329([
      { type: "tx", ref: UNSEEN_TX, label: "zebra-quartz-label-four" },
      { type: "addr", ref: UNSEEN_ADDR, label: "zebra-quartz-label-six" },
      { type: "xpub", ref: XPUB, label: "x" },
    ]);
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "w.jsonl", mimeType: "application/jsonl", buffer: Buffer.from(file) });
    await page.getByRole("button", { name: "Import 3 labels" }).click();
    await expect(
      page.getByText(/^Imported 3 labels\. The server learned nothing from it\.$/),
    ).toBeVisible();
    await page.getByLabel("Find a label").fill("zebra-quartz-label-four");
    await page.getByRole("button", { name: /^Edit the label of transaction/ }).click();
    await page.getByRole("textbox", { name: /^Your label for transaction/ }).fill("renamed");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Label saved")).toBeAttached();
    await page.getByLabel("Find a label").fill("zebra-quartz-label-six");
    await page.getByRole("button", { name: /^Delete the label of address/ }).click();
    await expect(page.getByText("No label matches.")).toBeVisible();
    await page.getByLabel("Find a label").fill("");
    await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export a file" }).click(),
    ]);
    await page.getByRole("button", { name: "Delete all" }).click();
    await page.getByRole("button", { name: "Keep them" }).click();
    await expect(page.getByRole("button", { name: "Delete all labels" })).toHaveCount(0);
    expect(seen.requests, "requests made by the manager's own actions").toEqual([]);
    // Following a reference's link is a lookup like any other: it asks for that transaction.
    await arrive(
      page,
      seen,
      () => page.getByRole("link", { name: new RegExp(UNSEEN_TX.slice(-8)) }).click(),
      [new RegExp(`/api/tx/${UNSEEN_TX}$`)],
    );
    expect(seen.requests.some((r) => r.includes(`/api/tx/${UNSEEN_TX}`))).toBe(true);
  });
});

// ---- A label moves nothing the page loads ----

test("nothing a label adds moves what loads by position: the head's height and the chart's top are constant", async ({
  page,
  browser,
  baseURL,
  extraHTTPHeaders,
}) => {
  test.setTimeout(180_000);
  const address = chain.addresses.p2tr;
  const WIDTHS = [320, 360, 1280];
  // A record so near the line cap that any longer label is refused: the save fails and says so.
  const near = (type: string, ref: string) => ({
    type,
    ref,
    label: "a",
    note: "y".repeat(64 * 1024 - 200),
  });

  type State = "none" | "short" | "long" | "editor open" | "save refused" | "no storage";
  /** The head's height and the top of what follows it, on both pages, in one state. */
  const measure = async (p: Page, width: number, state: State) => {
    await p.setViewportSize({ width, height: 900 });
    const out: number[] = [];
    for (const [path, head, below] of [
      [
        `/regtest/address/${address}`,
        ".address-head",
        p.getByRole("region", { name: "Balance over time" }),
      ],
      [`/regtest/tx/${TX}`, ".tx-head", p.getByRole("region", { name: "Inputs and outputs" })],
    ] as const) {
      await p.goto(path);
      await expect(below).toBeVisible();
      // Measured once the page has its data: a panel still loading is another height.
      await expect(p.locator('.state--loading, [aria-busy="true"]')).toHaveCount(0);
      const control = p.locator(`${head} .label-control__open`);
      const hasLabel = state === "short" || state === "long" || state === "save refused";
      await (hasLabel
        ? expect(p.locator(`${head} .your-label`)).toBeVisible()
        : expect(control).toHaveText("Add a label"));
      if (state === "editor open" || state === "save refused" || state === "no storage") {
        await control.click();
        const field = p.locator(".label-pop .label-editor__field");
        await expect(field).toBeFocused();
        if (state !== "editor open") {
          await field.fill("z".repeat(255));
          await p.keyboard.press("Enter");
          await expect(p.locator(".label-pop [role=alert]")).toBeVisible();
        }
      }
      out.push(
        (await p.locator(head).boundingBox())?.height ?? Number.NaN,
        (await below.boundingBox())?.y ?? Number.NaN,
      );
      if (state === "editor open" || state === "save refused" || state === "no storage") {
        await p.keyboard.press("Escape");
        await expect(p.locator(".label-pop")).toHaveCount(0);
      }
    }
    return out;
  };

  const results = new Map<string, number[]>();
  const run = async (state: State, p: Page) => {
    for (const w of WIDTHS) results.set(`${state} ${w}`, await measure(p, w, state));
  };
  await run("none", page);
  await run("editor open", page);
  await seedLabels(page, [
    { type: "addr", ref: address, label: "rent" },
    { type: "tx", ref: TX, label: "rent" },
  ]);
  await run("short", page);
  await seedLabels(page, [
    { type: "addr", ref: address, label: "w".repeat(255) },
    { type: "tx", ref: TX, label: "w".repeat(255) },
  ]);
  await run("long", page);
  await seedLabels(page, [near("addr", address), near("tx", TX)]);
  await run("save refused", page);
  const blocked = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(extraHTTPHeaders === undefined ? {} : { extraHTTPHeaders }),
  });
  await blocked.addInitScript(() => {
    const refuse = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    Object.defineProperty(window, "indexedDB", { get: refuse });
    Object.defineProperty(window, "localStorage", { get: refuse });
  });
  try {
    await run("no storage", await blocked.newPage());
  } finally {
    await blocked.close();
  }
  for (const w of WIDTHS)
    for (const state of ["short", "long", "editor open", "save refused", "no storage"])
      expect(results.get(`${state} ${w}`), `${state} at ${w} px`).toEqual(results.get(`none ${w}`));
});

test("in forced colours with large text the head and the chart stay put for a label too", async ({
  browser,
  baseURL,
  extraHTTPHeaders,
}) => {
  test.setTimeout(120_000);
  const address = chain.addresses.p2tr;
  // A desktop with a fine pointer, forced colours (the tag gains a border) and a 22 px root.
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(extraHTTPHeaders === undefined ? {} : { extraHTTPHeaders }),
    forcedColors: "active",
    viewport: { width: 1280, height: 900 },
  });
  const p = await context.newPage();
  // The reader's own text size, as the browser's setting gives it: a 22 px root.
  const cdp = await context.newCDPSession(p);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 22, fixed: 18 } });
  try {
    const measure = async (open: boolean, hasTag: boolean) => {
      const out: number[] = [];
      for (const [path, head, below] of [
        [
          `/regtest/address/${address}`,
          ".address-head",
          p.getByRole("region", { name: "Balance over time" }),
        ],
        [`/regtest/tx/${TX}`, ".tx-head", p.getByRole("region", { name: "Inputs and outputs" })],
      ] as const) {
        await p.goto(path);
        await expect(below).toBeVisible();
        await expect(p.locator('.state--loading, [aria-busy="true"]')).toHaveCount(0);
        await expect(p.locator(`${head} .your-label`)).toHaveCount(hasTag ? 1 : 0);
        if (open) {
          await p.locator(`${head} .label-control__open`).click();
          await expect(p.locator(".label-pop .label-editor__field")).toBeFocused();
        }
        out.push(
          (await p.locator(head).boundingBox())?.height ?? Number.NaN,
          (await below.boundingBox())?.y ?? Number.NaN,
        );
        if (open) await p.keyboard.press("Escape");
      }
      return out;
    };
    const none = await measure(false, false);
    const opened = await measure(true, false);
    await seedLabels(p, [
      { type: "addr", ref: address, label: "rent" },
      { type: "tx", ref: TX, label: "rent" },
    ]);
    const short = await measure(false, true);
    await seedLabels(p, [
      { type: "addr", ref: address, label: "w".repeat(255) },
      { type: "tx", ref: TX, label: "w".repeat(255) },
    ]);
    const long = await measure(false, true);
    expect(opened, "editor open").toEqual(none);
    expect(short, "short label").toEqual(none);
    expect(long, "255-character label").toEqual(none);
  } finally {
    await context.close();
  }
});

test("a mainnet address's label is not shown above another network's answer", async ({ page }) => {
  const mainnet = "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c";
  await seedLabels(page, [{ type: "addr", ref: mainnet, label: "not here" }]);
  await page.goto(`/regtest/address/${mainnet}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/Mainnet/).first()).toBeVisible();
  await expect(page.locator(".your-label")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /label/ })).toHaveCount(0);
});

test("the flow's ribbons follow the cards when a label is added", async ({ page }) => {
  // A transaction whose input column is shorter than its output column: a card that grows there
  // changes no size but its own.
  const candidates = Object.values(chain.txs);
  let txid: string = TX;
  for (const id of candidates) {
    const res = await page.request.get(`/regtest/api/tx/${id}`);
    // A replaced transaction is not on the node.
    if (!res.ok()) continue;
    const t = (await res.json()) as Tx;
    if (t.vin.length >= 2 && t.vout.length > t.vin.length + 1) {
      txid = id;
      break;
    }
  }
  await page.goto(`/regtest/tx/${txid}`);
  await expect(page.locator(".tx-ribbon").first()).toBeAttached();
  await page.getByRole("button", { name: "Details of input 0" }).click();
  await page.locator("#tx-inspector").getByRole("button", { name: "Add a label" }).click();
  await page
    .getByRole("textbox", { name: "Your label for input 0" })
    .fill("a label that makes the card taller");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list", { name: "Inputs" }).locator(".your-label")).toBeVisible();
  // Each ribbon's end is centred on its card, once the flow has drawn again.
  const off = () =>
    page.evaluate(() => {
      const box = document.querySelector(".tx-flow__ribbons")?.getBoundingClientRect();
      const cards = [
        ...document.querySelectorAll(".tx-flow__col--in > li, .tx-flow__col--out > li"),
      ];
      const paths = [...document.querySelectorAll<SVGPathElement>(".tx-ribbon")];
      return Math.max(
        ...paths.map((p, i) => {
          const n = (p.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
          const mid = ((n[1] ?? 0) + (n.at(-1) ?? 0)) / 2;
          const r = cards[i]?.getBoundingClientRect();
          return Math.abs(mid - ((r?.top ?? 0) + (r?.height ?? 0) / 2 - (box?.top ?? 0)));
        }),
      );
    });
  await expect.poll(off, { timeout: 3000 }).toBeLessThan(2);
});

test("a browser out of room says so, and keeps nothing of the import", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the quota is set through Chromium's own protocol");
  // The quota is set before the page opens the store; labels of random text, which no storage
  // engine can squeeze below it.
  await page.goto("/healthz");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Storage.overrideQuotaForOrigin", {
    origin: new URL(page.url()).origin,
    // Room for the store itself, not for 5 000 labels of 128 random characters each.
    quotaSize: 256 * 1024,
  });
  await page.goto("/regtest/labels");
  await expect(page.getByRole("button", { name: "Import a file" })).toBeEnabled();
  const noise = () => randomBytes(64).toString("hex");
  const lines = Array.from(
    { length: 5000 },
    (_, i) => `{"type":"output","ref":"${TX}:${i}","label":"${noise()}"}`,
  ).join("\n");
  await page.locator('input[type="file"]').setInputFiles({
    name: "big.jsonl",
    mimeType: "application/jsonl",
    buffer: Buffer.from(lines),
  });
  await page.getByRole("button", { name: "Import 5 000 labels" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This browser has no room left for the site's data, so the labels were not saved.",
  );
  await expect(page.getByText("No labels yet.")).toBeVisible();
});
