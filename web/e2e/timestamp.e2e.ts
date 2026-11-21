// The timestamp page (docs/FRONTEND.md "Timestamp proofs") with real proofs from fixtures/ots.
// Regtest has no mainnet, so mainnet's answers for the blocks are recorded and served in place of
// the server's, and `/app/config` is the server's own with mainnet added. Every request the page
// makes is checked: the reader's file and its digest never leave it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page, Request } from "@playwright/test";
import { axe } from "./axe";
import { expect, test } from "./fixtures";
import { smallTargets } from "./targets";

const fixture = (name: string) => new URL(`../../fixtures/ots/${name}`, import.meta.url);
const BLOCKS = JSON.parse(readFileSync(fixture("blocks.json"), "utf8")) as Record<
  string,
  { hash: string; header: string }
>;
const TWO_BLOCKS = "6fd9c1c4f096b77e6d4457bac1c7f51010d318db483f2868d3795843f098d378";
const PENDING = "a70dfe69c5a0d62816781abb6e1777854718624a0d194231adb14c32ee5438a4";
const MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
const CALENDAR = "https://alice.btc.calendar.opentimestamps.org";

/** A proof of `digest`: one append and SHA-256, then `attestation` (its tag and payload). */
function proof(digest: Buffer, attestation: Buffer): Buffer {
  return Buffer.concat([
    MAGIC,
    Buffer.from([1, 0x08]),
    digest,
    Buffer.from([0xf0, 4, 1, 2, 3, 4, 0x08, 0x00]),
    attestation,
  ]);
}
const bitcoin = (height: number) => {
  const v: number[] = [];
  for (let h = height; ; h = Math.floor(h / 128)) {
    v.push(h >= 128 ? (h % 128) | 0x80 : h);
    if (h < 128) break;
  }
  return Buffer.from([...Buffer.from("0588960d73d71901", "hex"), v.length, ...v]);
};
const pending = (uri: string) =>
  Buffer.from([
    ...Buffer.from("83dfe30d2ef90c8e", "hex"),
    uri.length + 1,
    uri.length,
    ...Buffer.from(uri),
  ]);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/** The server's config with mainnet in it, and mainnet's recorded blocks; any other height is 404. */
/**
 * An 80-byte header with `root` as its merkle root and `time` as its time, and its hash as the node
 * writes it: a made-up block, for a proof whose file the test knows.
 */
function madeBlock(root: Buffer, time: number): { hash: string; header: string } {
  const header = Buffer.alloc(80);
  header.writeUInt32LE(0x2000_0000, 0);
  root.copy(header, 36);
  header.writeUInt32LE(time, 68);
  const id = sha256(sha256(header));
  const hash = Buffer.from(id.map((_, i) => id[id.length - 1 - i] ?? 0)).toString("hex");
  return { hash, header: header.toString("hex") };
}

async function withMainnet(
  page: Page,
  made: Record<string, { hash: string; header: string }> = {},
) {
  const blocks = { ...BLOCKS, ...made };
  await page.route(/\/app\/config$/, async (route) => {
    const res = await route.fetch();
    const config = (await res.json()) as { networks: string[] };
    await route.fulfill({
      response: res,
      json: { ...config, networks: ["mainnet", ...config.networks] },
    });
  });
  await page.route(/^[^?]*\/\/[^/]+\/api\/block-height\/\d+$/, (route) => {
    const height = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const b = blocks[height];
    return b
      ? route.fulfill({ body: b.hash, contentType: "text/plain" })
      : route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.route(/^[^?]*\/\/[^/]+\/api\/block\/[0-9a-f]{64}\/header$/, (route) => {
    const hash = new URL(route.request().url()).pathname.split("/")[3];
    const b = Object.values(blocks).find((x) => x.hash === hash);
    return b
      ? route.fulfill({
          body: b.header,
          contentType: "text/plain",
          headers: { "cache-control": "public, max-age=31536000, immutable" },
        })
      : route.fulfill({ status: 404, json: { error: "not found" } });
  });
}

/** Every request from here on, and a check that none carried the reader's file or digest. */
function watch(page: Page) {
  const seen: Request[] = [];
  page.on("request", (r) => seen.push(r));
  return {
    api: () => seen.map((r) => new URL(r.url()).pathname).filter((p) => /\/(api|app)\//.test(p)),
    clean: (secrets: string[]) => {
      const origin = new URL(page.url()).origin;
      for (const r of seen) {
        expect(r.method(), r.url()).toBe("GET");
        expect(new URL(r.url()).origin, r.url()).toBe(origin);
        const text = `${r.url()} ${r.postData() ?? ""}`.toLowerCase();
        for (const s of secrets) expect(text, r.url()).not.toContain(s.toLowerCase());
        const path = new URL(r.url()).pathname;
        expect(
          /^\/(regtest\/)?(timestamp|assets\/.*|boot\.js|favicon.*|app\/config|app\/ws|api\/block-height\/\d+|api\/block\/[0-9a-f]{64}\/header)$/.test(
            path,
          ),
          path,
        ).toBe(true);
      }
    },
  };
}

const proofInput = (page: Page) =>
  page.getByText("The .ots file").locator("..").locator("input[type=file]");
const fileInput = (page: Page) =>
  page
    .getByText(/never uploaded/)
    .locator("..")
    .locator("input[type=file]");
const digestBox = (page: Page) => page.getByRole("textbox", { name: /Or its SHA-256/ });

test("a real proof with two Bitcoin attestations verifies by the earlier block, asking only for the blocks", async ({
  page,
}) => {
  await withMainnet(page);
  const w = watch(page);
  await page.goto("/regtest/timestamp");
  await expect(page.getByRole("heading", { level: 1, name: "Check a timestamp" })).toBeVisible();
  await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
  await digestBox(page).fill(TWO_BLOCKS.toUpperCase());
  const verdict = page.getByRole("article");
  await expect(
    verdict.getByRole("heading", { name: "This digest is committed to by block 449 397" }),
  ).toBeVisible();
  await expect(verdict.getByText("Verified", { exact: true })).toBeVisible();
  await expect(verdict.getByText(/21 Jan 2017, 23:47:07 UTC/)).toBeVisible();
  // On mainnet, whichever network the page is on.
  await expect(verdict.getByRole("link", { name: "block 449 397" })).toHaveAttribute(
    "href",
    `/block/${BLOCKS["449397"]?.hash}`,
  );
  await expect(verdict.getByText(/Bitcoin block 449\s399: also verified/)).toBeVisible();
  // The other verified block is a link to its page, by the hash checked against its header.
  await expect(verdict.getByRole("link", { name: "block 449 399" })).toHaveAttribute(
    "href",
    `/block/${BLOCKS["449399"]?.hash}`,
  );
  // The calendars it once waited on are named, as text, and not checked.
  await expect(verdict.getByText(CALENDAR)).toBeVisible();
  await expect(verdict.getByText("not checked")).toHaveCount(2);
  await expect(page.locator(`a[href*="calendar"]`)).toHaveCount(0);
  // The work: from the digest down to the root, with the transaction that carried it.
  await verdict.getByText(/Show the \d+ steps/).click();
  await expect(verdict.getByRole("link", { name: "763fbb1e…493577d9" })).toHaveAttribute(
    "href",
    "/tx/763fbb1e21c36ebc656a58dae1e04ab76b9529843aeba8642916d6ac493577d9",
  );
  await expect(verdict.getByText(/The last value is block 449\s397.s merkle root/)).toBeVisible();
  expect(await axe(page), "axe-core, verified").toStrictEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await axe(page, ["color-contrast"]), "contrast, dark").toStrictEqual([]);
  expect(w.api().filter((p) => p.includes("/api/"))).toStrictEqual([
    "/api/block-height/449397",
    `/api/block/${BLOCKS["449397"]?.hash}/header`,
    "/api/block-height/449399",
    `/api/block/${BLOCKS["449399"]?.hash}/header`,
  ]);
  w.clean([TWO_BLOCKS]);
});

test("a file is hashed in the page and never sent; a pending proof says what to do next", async ({
  page,
}) => {
  await withMainnet(page);
  const w = watch(page);
  const file = Buffer.from("A file nobody else has seen, written for this test.\n");
  const digest = sha256(file).toString("hex");
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles({
    name: "note.txt.ots",
    mimeType: "application/octet-stream",
    buffer: proof(sha256(file), pending(CALENDAR)),
  });
  await fileInput(page).setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: file });
  const verdict = page.getByRole("article");
  await expect(verdict.getByRole("heading", { name: "Not verified yet" })).toBeVisible();
  await expect(verdict.getByText("Pending", { exact: true })).toBeVisible();
  await expect(verdict.getByText(/ots upgrade/)).toBeVisible();
  await expect(verdict.getByRole("listitem").filter({ hasText: CALENDAR })).toBeVisible();
  await expect(verdict.getByRole("link")).toHaveCount(0);
  expect(await axe(page), "axe-core, pending").toStrictEqual([]);
  expect(w.api().filter((p) => p.includes("/api/"))).toStrictEqual([]);
  w.clean([digest, file.toString("hex"), "nobody else has seen"]);
});

test("the recorded pending proof is pending, from its digest", async ({ page }) => {
  await withMainnet(page);
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles(fileURLToPath(fixture("pending.ots")));
  await digestBox(page).fill(PENDING);
  await expect(page.getByRole("heading", { name: "Not verified yet" })).toBeVisible();
});

test("another file is said to be one, and nothing is asked", async ({ page }) => {
  await withMainnet(page);
  const w = watch(page);
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
  const other = Buffer.from("not the file\n");
  await fileInput(page).setInputFiles({ name: "other.txt", mimeType: "text/plain", buffer: other });
  await expect(
    page.getByRole("heading", { name: "This proof is not for this file" }),
  ).toBeVisible();
  await expect(page.getByText(sha256(other).toString("hex"))).toBeVisible();
  await expect(page.getByText(TWO_BLOCKS)).toBeVisible();
  expect(await axe(page), "axe-core, a different file").toStrictEqual([]);
  expect(w.api().filter((p) => p.includes("/api/"))).toStrictEqual([]);
  w.clean([]);
});

test("a proof that does not reach its block's root is refused for that reason", async ({
  page,
}) => {
  await withMainnet(page);
  const digest = sha256(Buffer.from("forged\n"));
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles({
    name: "forged.ots",
    mimeType: "application/octet-stream",
    buffer: proof(digest, bitcoin(449_397)),
  });
  await digestBox(page).fill(digest.toString("hex"));
  await expect(
    page.getByRole("heading", { name: "This proof does not lead to block 449 397" }),
  ).toBeVisible();
  await expect(page.getByText("Does not verify")).toBeVisible();
  expect(await axe(page), "axe-core, broken").toStrictEqual([]);
});

test.describe("a block the node does not have", () => {
  test.use({ consoleErrorsAllowed: [/status of 404/] });
  test("is said to be unknown here, not wrong", async ({ page }) => {
    await withMainnet(page);
    const digest = sha256(Buffer.from("future\n"));
    await page.goto("/regtest/timestamp");
    await proofInput(page).setInputFiles({
      name: "future.ots",
      mimeType: "application/octet-stream",
      buffer: proof(digest, bitcoin(2_000_000)),
    });
    await digestBox(page).fill(digest.toString("hex"));
    await expect(
      page.getByRole("heading", { name: "This node has no block 2 000 000" }),
    ).toBeVisible();
  });
});

test("a file that is no proof, and a cut-short proof, are named as such", async ({ page }) => {
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("<b>hello</b>"),
  });
  await expect(page.getByRole("heading", { name: "This is not a timestamp proof" })).toBeVisible();
  const cut = readFileSync(fixture("two-blocks.ots")).subarray(0, 900);
  await proofInput(page).setInputFiles({
    name: "cut.ots",
    mimeType: "application/octet-stream",
    buffer: cut,
  });
  await expect(page.getByRole("heading", { name: "This proof is cut short" })).toBeVisible();
  await expect(page.locator("b")).toHaveCount(0);
});

test("on a server without mainnet nothing is asked, and the page says why", async ({ page }) => {
  const w = watch(page);
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
  await digestBox(page).fill(TWO_BLOCKS);
  await expect(
    page.getByRole("heading", { name: "This server does not follow Bitcoin's main chain" }),
  ).toBeVisible();
  await expect(page.getByText(/blocks 449\s397, 449\s399/)).toBeVisible();
  expect(w.api().filter((p) => p.includes("/api/"))).toStrictEqual([]);
  w.clean([TWO_BLOCKS]);
});

test("a digest that is not one says what is wrong with it", async ({ page }) => {
  await page.goto("/regtest/timestamp");
  await digestBox(page).fill("abc");
  await expect(page.getByText("A SHA-256 digest is 64 hex digits; this is 3.")).toBeVisible();
  await digestBox(page).fill("xyz");
  await expect(page.getByText(/written in hex/)).toBeVisible();
  await expect(digestBox(page)).toHaveAttribute("aria-invalid", "true");
});

test("the keyboard reaches both file choosers and opens them", async ({ page }) => {
  await page.goto("/regtest/timestamp");
  const proofChooser = proofInput(page);
  await proofChooser.focus();
  await expect(proofChooser).toBeFocused();
  // The ring is drawn on the button the input sits in.
  const ring = await page
    .getByText("Choose a file")
    .first()
    .evaluate((e) => getComputedStyle(e).outlineStyle);
  expect(ring).toBe("solid");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Enter"),
  ]);
  await chooser.setFiles(fileURLToPath(fixture("pending.ots")));
  await expect(page.getByText("pending.ots")).toBeVisible();
  // Tab goes on to the next control: the button that removes it, then the file's chooser.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Remove the proof" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(fileInput(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(digestBox(page)).toBeFocused();
  await digestBox(page).fill(PENDING);
  await expect(page.getByRole("heading", { name: "Not verified yet" })).toBeVisible();
  // Removing the proof puts focus back on its chooser.
  await page.getByRole("button", { name: "Remove the proof" }).click();
  await expect(proofChooser).toBeFocused();
});

test("a file the page hashed is said to have existed; the block's time is its header time", async ({
  page,
}) => {
  const file = Buffer.from("A file this test wrote and timestamped against a made-up block.\n");
  const digest = sha256(file);
  // The proof's one step, then the block whose root that step reaches.
  const reached = sha256(Buffer.concat([digest, Buffer.from([1, 2, 3, 4])]));
  await withMainnet(page, { "100": madeBlock(reached, 1_700_000_000) });
  const w = watch(page);
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles({
    name: "made.ots",
    mimeType: "application/octet-stream",
    buffer: proof(digest, bitcoin(100)),
  });
  await fileInput(page).setInputFiles({ name: "made.txt", mimeType: "text/plain", buffer: file });
  const verdict = page.getByRole("article");
  await expect(
    verdict.getByRole("heading", { name: "This file existed before block 100" }),
  ).toBeVisible();
  // The block's header time as the one figure under the headline.
  const time = verdict.getByRole("definition").filter({ hasText: "14 Nov 2023" });
  await expect(time).toContainText("14 Nov 2023, 22:13:20 UTC");
  // The two checks a node makes of a header's time, and nothing said about when it was mined.
  await expect(
    verdict.getByText(
      /later than the median of the blocks before, up to eleven, and at most two hours ahead of its own clock\./,
    ),
  ).toBeVisible();
  await expect(verdict.getByText(/ahead of when the block was mined/)).toHaveCount(0);
  w.clean([digest.toString("hex")]);
});

test("a height's answer that is no hash is never asked about", async ({ page }) => {
  await withMainnet(page);
  await page.route(/\/api\/block-height\/449397$/, (route) =>
    route.fulfill({ body: "not-a-hash", contentType: "text/plain" }),
  );
  const w = watch(page);
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
  await digestBox(page).fill(TWO_BLOCKS);
  // The other block verifies; this one is listed as not checked, its header never asked for.
  await expect(page.getByText(/449\s397: could not be checked/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "This digest is committed to by block 449 399" }),
  ).toBeVisible();
  expect(w.api().filter((p) => p.includes("not-a-hash"))).toStrictEqual([]);
});

test("a pasted digest that is not the proof's is said to differ as a digest, not as a file", async ({
  page,
}) => {
  await withMainnet(page);
  const w = watch(page);
  const other = "ab".repeat(32);
  await page.goto("/regtest/timestamp");
  await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
  await digestBox(page).fill(other);
  const verdict = page.getByRole("article");
  await expect(
    verdict.getByRole("heading", {
      name: "The digest you gave is not the one this proof starts from",
    }),
  ).toBeVisible();
  await expect(verdict.getByText("Different digest", { exact: true })).toBeVisible();
  await expect(verdict.getByText(/file/)).toHaveText([/digest of the right file/]);
  await expect(verdict.getByText(other)).toBeVisible();
  await expect(verdict.getByText(TWO_BLOCKS)).toBeVisible();
  expect(await axe(page), "axe-core, a different digest").toStrictEqual([]);
  expect(w.api().filter((p) => p.includes("/api/"))).toStrictEqual([]);
  w.clean([other]);
});

// A phone, in CI's wider prose font: the verdict is brought to the reader when it comes, the filled
// slots are one row each, and a touch screen is not offered a drop (council F-D1).
test.describe("on a phone", () => {
  // Firefox has no mobile emulation, only touch: with `isMobile` its viewport never resizes.
  test.use({
    prose: "wide",
    hasTouch: true,
    ...(process.env["E2E_ENGINE"] === "firefox" ? {} : { isMobile: true }),
    viewport: { width: 360, height: 780 },
  });
  test("the verdict comes into view with focus on its heading, and the digest field shows all of it", async ({
    page,
  }) => {
    await withMainnet(page);
    const w = watch(page);
    await page.goto("/regtest/timestamp");
    await expect(page.getByText("or drop it here").first()).toBeHidden();
    await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
    // Every character of a digest in sight at once, wrapping, before and while it is typed.
    await digestBox(page).fill(TWO_BLOCKS);
    const fits = await digestBox(page).evaluate(
      (t) => t.scrollWidth <= t.clientWidth && t.scrollHeight <= t.clientHeight + 1,
    );
    expect(fits).toBe(true);
    const heading = page.getByRole("heading", {
      name: "This digest is committed to by block 449 397",
    });
    await expect(heading).toBeAttached();
    // Typing: the field keeps focus. Enter is done: the verdict is brought into view.
    await expect(digestBox(page)).toBeFocused();
    await digestBox(page).press("Enter");
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    // A slot holding a file is one row: its name, Change and remove on one line.
    // Both read in one go: the page may still be scrolling to the verdict.
    const apart = await page.locator(".ots-slot--chosen").evaluate((slot) => {
      const mid = (sel: string) => {
        const r = slot.querySelector(sel)?.getBoundingClientRect();
        return r ? (r.top + r.bottom) / 2 : Number.NaN;
      };
      return Math.abs(mid(".ots-slot__title") - mid(".ots-slot__choose"));
    });
    expect(apart).toBeLessThan(4);
    w.clean([TWO_BLOCKS]);
  });

  test("Done pressed while the block is looked up brings the verdict when it comes", async ({
    page,
  }) => {
    await withMainnet(page);
    // The block's answer is held until after Enter.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/block-height\/449397$/, async (route) => {
      await held;
      await route.fallback();
    });
    await page.setViewportSize({ width: 360, height: 560 });
    await page.goto("/regtest/timestamp");
    await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
    await digestBox(page).fill(TWO_BLOCKS);
    await expect(page.getByText("Checking the block")).toBeVisible();
    await digestBox(page).press("Enter");
    release();
    const heading = page.getByRole("heading", {
      name: "This digest is committed to by block 449 397",
    });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
  });

  test("a wrong paste of any length keeps the field, its clear and its message on screen", async ({
    page,
  }) => {
    await page.goto("/regtest/timestamp");
    await digestBox(page).fill("f".repeat(4096));
    await expect(page.getByText(/is 64 hex digits; this is 4096/)).toBeVisible();
    await digestBox(page).evaluate((t) => t.scrollIntoView({ block: "start" }));
    const box = await digestBox(page).boundingBox();
    expect(box?.height ?? 9999).toBeLessThan(780 / 2);
    await expect(page.getByRole("button", { name: "Clear the digest" })).toBeInViewport();
    await expect(page.getByText(/this is 4096/)).toBeInViewport();
    // A valid digest is shown whole, with nothing to scroll, even at 320 px with 32 px text.
    await page.setViewportSize({ width: 320, height: 780 });
    await page.evaluate(() => (document.documentElement.style.fontSize = "32px"));
    await digestBox(page).fill(TWO_BLOCKS);
    const whole = await digestBox(page).evaluate(
      (t) => t.scrollHeight <= t.clientHeight + 1 && t.scrollWidth <= t.clientWidth + 1,
    );
    expect(whole).toBe(true);
  });

  test("a verdict below the screen is scrolled to when it comes", async ({ page }) => {
    const file = Buffer.from("A file this test wrote and timestamped against a made-up block.\n");
    const digest = sha256(file);
    const reached = sha256(Buffer.concat([digest, Buffer.from([1, 2, 3, 4])]));
    await withMainnet(page, { "100": madeBlock(reached, 1_700_000_000) });
    // A short screen, so the verdict starts below it.
    await page.setViewportSize({ width: 360, height: 560 });
    await page.goto("/regtest/timestamp");
    await proofInput(page).setInputFiles({
      name: "made.ots",
      mimeType: "application/octet-stream",
      buffer: proof(digest, bitcoin(100)),
    });
    await fileInput(page).setInputFiles({ name: "made.txt", mimeType: "text/plain", buffer: file });
    const heading = page.getByRole("heading", { name: "This file existed before block 100" });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  });
});

// The slots in every state, at every width and at larger text, in CI's wider prose font: no two
// of a slot's parts overlap (its label's words, its line's words, Change or Choose, remove), none
// sticks out of the slot, a name that fits is not cut, a label never shrinks under its own words,
// and the two slots are one height (council F-D6, N-D5, F-D7, N-D6, N-D7, A-D2).
test.describe("the slots in every state, width and text size", () => {
  test.use({ prose: "wide" });
  const LONG = `${`${"a-very-long-file-name-".repeat(5)}that-goes-on.txt`.slice(0, 116)}.ots`;
  const SIZES: [number, number][] = [
    ...[320, 360, 700, 1040, 1280].map((w): [number, number] => [w, 16]),
    [320, 24],
    [360, 24],
    [320, 32],
    [360, 32],
    [700, 24],
    [1280, 24],
    [1280, 32],
  ];
  /** Every fault in the two slots as they are drawn now. */
  const faults = (page: Page) =>
    page.evaluate(() => {
      const out: string[] = [];
      const words = (el: Element | null) => {
        if (!el || el.getClientRects().length === 0) return undefined;
        const r = document.createRange();
        r.selectNodeContents(el);
        return r.getBoundingClientRect();
      };
      const slots = [...document.querySelectorAll(".ots-slot")];
      for (const slot of slots) {
        const box = slot.getBoundingClientRect();
        const title = slot.querySelector(".ots-slot__title");
        const shown = (sel: string) => {
          const el = slot.querySelector(sel);
          return el && el.getClientRects().length > 0 ? el.getBoundingClientRect() : undefined;
        };
        // The label by its words, which overflow a squeezed box; the rest by their boxes.
        const candidates: [string, DOMRect | undefined][] = [
          ["label", words(title)],
          ["hint", shown(".ots-slot__hint")],
          ["name", shown(".ots-slot__chosen")],
          ["choose", shown(".ots-slot__choose")],
          ["remove", shown(".ots-slot__clear")],
        ];
        const parts = candidates.filter(
          (p): p is [string, DOMRect] => p[1] !== undefined && p[1].width > 0,
        );
        const name = title?.textContent ?? "";
        for (const [what, r] of parts)
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5)
            out.push(`${name}: ${what} outside its slot`);
        for (const [i, [a, ra]] of parts.entries())
          for (const [b, rb] of parts.slice(i + 1))
            if (
              ra.left < rb.right - 0.5 &&
              rb.left < ra.right - 0.5 &&
              ra.top < rb.bottom - 0.5 &&
              rb.top < ra.bottom - 0.5
            )
              out.push(`${name}: ${a} overlaps ${b}`);
        if (title && title.scrollWidth > title.clientWidth + 1) out.push(`${name}: label squeezed`);
        // A control's words stay inside it.
        for (const c of slot.querySelectorAll<HTMLElement>(".ots-slot__choose, .ots-slot__clear"))
          if (c.getClientRects().length > 0 && c.scrollWidth > c.clientWidth + 1)
            out.push(`${name}: "${c.textContent ?? ""}" spills out of its control`);
        if (title && title.getClientRects().length > 0) {
          const lh = Number.parseFloat(getComputedStyle(title).lineHeight);
          if (title.getBoundingClientRect().height > lh * 1.5) out.push(`${name}: label wraps`);
        }
        // The size stays on the name's line, and the name is cut only when the two do not fit it
        // (code review S-4).
        const n = slot.querySelector<HTMLElement>(".ots-slot__name");
        const line = slot.querySelector<HTMLElement>(".ots-slot__chosen");
        const size = line?.querySelector<HTMLElement>(".muted");
        if (n && line && size) {
          const [nr, sr] = [n.getBoundingClientRect(), size.getBoundingClientRect()];
          if (Math.abs(nr.bottom - sr.bottom) > 2) out.push(`${name}: its size is on another line`);
          const room =
            line.clientWidth -
            sr.width -
            Number.parseFloat(getComputedStyle(line).columnGap || "0");
          if (n.scrollWidth > n.clientWidth + 1 && n.scrollWidth <= room)
            out.push(`${name}: "${n.textContent ?? ""}" is cut though it fits`);
        }
      }
      // Side by side, one height; stacked, each as tall as it holds, with no blank to fill.
      const [a, b] = slots.map((x) => x.getBoundingClientRect());
      if (a && b && Math.abs(a.top - b.top) < 1 && Math.abs(a.height - b.height) > 1)
        out.push(`side by side, heights ${a.height} and ${b.height}`);
      return out;
    });
  const sweep = async (page: Page, state: string) => {
    const found: string[] = [];
    for (const [width, text] of SIZES) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((px) => (document.documentElement.style.fontSize = `${px}px`), text);
      await page.evaluate(() => document.fonts.ready);
      for (const f of await faults(page))
        found.push(`${state}, ${width} px, ${text} px text: ${f}`);
    }
    await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    return found;
  };
  for (const [label, name] of [
    ["a short name", "hello-world.txt.ots"],
    ["a 120-character name", LONG],
  ] as const) {
    test(`with ${label}`, async ({ page }) => {
      expect(name.length).toBe(label === "a short name" ? 19 : 120);
      await withMainnet(page);
      await page.goto("/regtest/timestamp");
      await expect(page.locator(".ots-slot")).toHaveCount(2);
      const found = await sweep(page, "both empty");
      await proofInput(page).setInputFiles({
        name,
        mimeType: "application/octet-stream",
        buffer: proof(sha256(Buffer.from("x")), pending(CALENDAR)),
      });
      await expect(page.locator(".ots-slot--chosen")).toHaveCount(1);
      found.push(...(await sweep(page, "proof only")));
      await digestBox(page).fill(sha256(Buffer.from("x")).toString("hex"));
      await expect(page.getByText(/stands in for it/)).toBeVisible();
      found.push(...(await sweep(page, "proof and a digest")));
      await page
        .locator("input[type=file]")
        .nth(1)
        .setInputFiles({
          name: name.replace(/\.ots$/, ""),
          mimeType: "text/plain",
          buffer: Buffer.from("x"),
        });
      await expect(page.locator(".ots-slot--chosen")).toHaveCount(2);
      found.push(...(await sweep(page, "proof and file")));
      await page.getByRole("button", { name: "Remove the proof" }).click();
      await expect(page.locator(".ots-slot--chosen")).toHaveCount(1);
      found.push(...(await sweep(page, "file only")));
      expect(found).toStrictEqual([]);
    });
  }
  // Both slots' right-hand controls end the same distance from their cards' edge (council F-D9).
  test("the empty slot's button ends where the filled slot's remove does", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/regtest/timestamp");
    await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
    await expect(page.locator(".ots-slot--chosen")).toHaveCount(1);
    const insets = await page.locator(".ots-slot").evaluateAll((slots) =>
      slots.map((s) => {
        const last = [...s.querySelectorAll(".ots-slot__choose, .ots-slot__clear")].map(
          (e) => e.getBoundingClientRect().right,
        );
        return Math.round(s.getBoundingClientRect().right - Math.max(...last));
      }),
    );
    expect(insets[0]).toBe(insets[1]);
  });
});

// On a touch screen every control of a filled slot and the digest's clear is a thumb's target
// (council F-D8): the empty page in targets.e2e.ts has none of them.
test.describe("the slots' controls on a touch screen", () => {
  test.use({
    hasTouch: true,
    ...(process.env["E2E_ENGINE"] === "firefox" ? {} : { isMobile: true }),
    viewport: { width: 360, height: 780 },
  });
  test("are each a thumb's target", async ({ page }) => {
    await page.goto("/regtest/timestamp");
    await proofInput(page).setInputFiles(fileURLToPath(fixture("two-blocks.ots")));
    await digestBox(page).fill("ab");
    await expect(page.getByRole("button", { name: "Clear the digest" })).toBeVisible();
    const faults = await smallTargets(page, "main");
    await fileInput(page).setInputFiles({
      name: "f.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("f"),
    });
    await expect(page.getByRole("button", { name: "Remove the file" })).toBeVisible();
    faults.push(...(await smallTargets(page, "main")));
    expect(faults).toStrictEqual([]);
  });
});
