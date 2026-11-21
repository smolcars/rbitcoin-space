// Chain data is attacker-controlled text (docs/SECURITY.md rule 14). This puts markup, a
// `javascript:` URL, bidi overrides, ANSI escapes and NUL on the run's chain, in OP_RETURN outputs,
// inscriptions (HTML, JSON and an SVG with a script) and a hand-built coinbase tag, and checks every
// page shows them as inert, visible text, and never draws the SVG. It mines, so it runs after every
// other test (the `mines` project).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";

const REGTEST = fileURLToPath(new URL("../../dev/regtest/regtest.py", import.meta.url));

interface Hostile {
  tx: string;
  reveal: string;
  block: string;
  coinbase: string;
}

/** What the page did with the text: anything that would mean it was read as markup or a link. */
async function inert(page: Page, dialogs: string[]) {
  const found = await page.evaluate(() => ({
    elements: document.body.querySelectorAll(
      "script, img, iframe, object, embed, b, [onload], [onerror]",
    ).length,
    hrefs: [...document.querySelectorAll("a[href]")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => !/^(\/|#|https:\/\/github\.com\/)/.test(h)),
    // Characters that would hide or reorder text must reach the screen only as visible marks.
    // (Escapes in \u{} form: oxfmt unescapes \uXXXX.)
    // oxlint-disable-next-line no-control-regex -- NUL and ESC are exactly what this looks for
    raw: /[\u{0}\u{1B}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(document.body.textContent),
    title: document.title,
  }));
  expect(found.elements, "elements injected").toBe(0);
  expect(found.hrefs, "links with an unexpected scheme").toEqual([]);
  expect(found.raw, "hidden characters shown raw").toBe(false);
  expect(found.title).not.toMatch(/[<>]/);
  expect(dialogs, "dialogs opened").toEqual([]);
}

test("hostile chain data is shown as text on every page that shows it", async ({ page, mine }) => {
  // Mines first through the fixture, so this fails clearly anywhere but the `mines` project.
  await mine(1);
  const made = JSON.parse(
    execFileSync("python3", [REGTEST, "hostile"], { encoding: "utf8" }),
  ) as Hostile;
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  await page.goto(`/regtest/tx/${made.tx}`);
  const outputs = page.getByRole("list", { name: "Outputs" });
  // The text has a line of its own under the card, in quotes.
  await expect(outputs).toContainText("Unspendable“<img src=x onerror=alert(1)>”");
  await expect(outputs).toContainText("Unspendable“javascript:alert(document.domain)”");
  await expect(outputs).toContainText("Unspendable“</title><script>alert(1)</script>”");
  await expect(outputs).toContainText(
    String.raw`Unspendable“line1\u{a}line2\u{d}\u{a}\u{1b}[31mANSI\u{1b}[0m\u{0}NUL”`,
  );
  // Mostly bidi and zero-width characters: not text, so it is shown as its bytes.
  await expect(outputs).toContainText("OP_RETURN, 34 bytes");
  await page.getByRole("button", { name: "Details of output 2" }).click();
  await expect(page.getByRole("heading", { name: "Output 2" })).toBeFocused();
  await expect(page.getByText(/^e280ae6576696ce280ac/).first()).toBeVisible();
  await inert(page, dialogs);

  // One input per inscription: text as text, the SVG named by its type and size only.
  await page.goto(`/regtest/tx/${made.reveal}`);
  const inputs = page.getByRole("list", { name: "Inputs" });
  await expect(inputs).toContainText(
    String.raw`Inscription “<script>alert('ins')</script>\u{202e}<img src=x onerror=alert(2)>”`,
  );
  await expect(inputs).toContainText(
    String.raw`Inscription “{"p":"brc-20","op":"<b>mint</b>","tick":"\u202e"}”`,
  );
  await expect(inputs).toContainText("Inscription, image/svg+xml, 59 B");
  await page.getByRole("button", { name: "Details of input 2" }).click();
  await expect(page.getByRole("heading", { name: "Input 2" })).toBeFocused();
  await expect(page.locator("#tx-inspector")).toContainText("image/svg+xml59 B, not shown");
  await page.getByRole("button", { name: "Details of input 0" }).click();
  await expect(page.locator("#tx-inspector")).toContainText("text/html;charset=utf-8");
  await expect(page.locator("#tx-inspector .tx-text")).toHaveText(
    String.raw`<script>alert('ins')</script>\u{202e}<img src=x onerror=alert(2)>`,
  );
  await inert(page, dialogs);

  await page.goto(`/regtest/block/${made.block}`);
  const tag = page.getByRole("definition").filter({ hasText: "Written by the miner" });
  await expect(tag).toContainText("<script>alert('cb')</script>· <b>pool</b>");
  // The tag names no listed pool, so the miner is Unknown: the tag's text is never a name.
  const miner = page.getByRole("definition").filter({ hasText: "No listed address or tag" });
  await expect(miner.getByRole("link")).toHaveText("Unknown");
  // The miner claimed 1 000 sats less than the subsidy of an empty block.
  await expect(
    page.getByText("0.00 001 000 BTC less than the subsidy and fees allowed"),
  ).toBeVisible();
  await inert(page, dialogs);

  await page.goto(`/regtest/tx/${made.coinbase}`);
  // The same reading as the block page's tag, under the coinbase card.
  await expect(page.getByRole("list", { name: "Inputs" })).toContainText(
    "New coins and fees“<script>alert('cb')</script>· <b>pool</b>”",
  );
  await page.getByRole("button", { name: "Details of input 0" }).click();
  await expect(page.getByRole("heading", { name: "Input 0" })).toBeFocused();
  await inert(page, dialogs);

  await page.goto(`/regtest/address/${chain.addresses.p2wpkh}`);
  await expect(
    page
      .getByRole("table", { name: "Transactions of this address, newest first" })
      .getByRole("link", {
        name: made.tx.slice(0, 8),
      }),
  ).toBeVisible();
  await inert(page, dialogs);
});
