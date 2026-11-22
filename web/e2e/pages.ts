// Every page in each state worth sweeping, with what it needs stubbed: the list the rule sweeps
// (fonts, targets, a11y) walk. `src/sweeps.test.ts` holds it to the route table.
import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
  ARKADE_ADDRESS,
  ARKADE_ID,
  arkadeKnowsBarks,
  HEX,
  ID,
  withArkade,
  withArkadeAddress,
  withBark,
  withBarkHex,
  withBoth,
} from "./ark-answers";
import { withInvoice } from "./decode-answers";
import { chain, expect, stubRetargets } from "./fixtures";
import { KEPT, LARGE, stubLarge } from "./large-address";
import { ACINQ, mainnet, penalties, recorded, serve } from "./lightning-answers";
import { serveScore } from "./score-answers";

/** The keys of BIP352's first test vector as a test network silent payments address. */
export const SILENT_PAYMENT =
  "tsp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc3wk4yh";

/** The recorded feed made 22 h 15 min to 23 h old, so its rows read their longest ("22 h 44 min ago"). */
function agedFeed(): unknown {
  const feed = recorded("feed") as { events: { time: number }[] };
  const shift =
    Math.floor(Date.now() / 1000) - 80_100 - Math.max(...feed.events.map((e) => e.time));
  for (const e of feed.events) e.time += shift;
  return feed;
}

/** Lightning on regtest from mainnet's recorded answers (as in lightning.e2e.ts). */
const lightning = (page: Page) =>
  serve(page, { ...mainnet(), feed: agedFeed(), penalties: penalties(3) });

/** No replacements recorded. */
async function noReplacements(page: Page) {
  await page.route(/\/regtest\/api\/v1\/(fullrbf\/)?replacements$/, (route) =>
    route.fulfill({ json: [] }),
  );
}

/** Mainnet's replacement stories (as rbf.e2e.ts draws them): regtest has none this long. */
async function replacements(page: Page) {
  const { all } = JSON.parse(
    readFileSync(new URL("../../fixtures/api-v1/replacements.json", import.meta.url), "utf8"),
  ) as { all: unknown };
  await page.route(/\/regtest\/api\/v1\/replacements$/, (route) => route.fulfill({ json: all }));
}

const table = (page: Page) => page.getByRole("table").first();
const outputs = (page: Page) => page.getByRole("list", { name: "Outputs" });
const balance = (page: Page) => page.getByRole("button", { name: /^Copy the exact balance/ });
const playExit = (page: Page) => page.getByRole("button", { name: "Play exit" });

/** The rule sweeps that walk `PAGES`; `walk` is the keyboard walk, which a phone's run leaves out. */
export type Sweep = "fonts" | "targets" | "a11y" | "walk" | "largeText";

export interface SweptPage {
  /** Unique: a fragment the page never reads tells two states of one path apart. */
  path: string;
  stub?: (page: Page) => Promise<void>;
  /** What the page shows once it has its data, where its heading comes first. */
  ready?: (page: Page) => Locator;
  /** Faults a sweep finds here and nobody has fixed yet: each in words, as a pattern of its report. */
  faults?: Partial<Record<Sweep, Readonly<Record<string, RegExp>>>>;
}

/**
 * Holds what a sweep found on a page to the faults its entry names: each is still found, so a
 * fixed one is taken out, and nothing else is.
 */
export function expectFaults(found: readonly string[], { faults }: SweptPage, sweep: Sweep) {
  const known = Object.entries(faults?.[sweep] ?? {});
  expect
    .soft(
      found.filter((f) => !known.some(([, k]) => k.test(f))),
      `${sweep}: what it found`,
    )
    .toStrictEqual([]);
  expect
    .soft(
      known.filter(([, k]) => !found.some((f) => k.test(f))).map(([what]) => what),
      `${sweep}: faults in e2e/pages.ts it no longer finds, to take out`,
    )
    .toStrictEqual([]);
}

/** Every page, each with what it needs stubbed. */
export const PAGES: SweptPage[] = [
  {
    path: "/regtest/",
    ready: (p) => p.getByRole("list", { name: "Mined blocks, newest first" }).getByRole("link"),
  },
  { path: "/regtest/blocks", ready: (p) => p.getByRole("cell") },
  {
    path: `/regtest/block/${chain.blocks[106]}`,
    ready: (p) => p.getByRole("img", { name: /Map of the block/ }),
  },
  {
    path: "/regtest/block/next",
    ready: (p) => p.getByRole("heading", { level: 1, name: "Next block" }),
  },
  { path: `/regtest/tx/${chain.txs.script_types}`, ready: outputs },
  { path: `/regtest/tx/${chain.txs.cpfp_child}`, ready: outputs },
  // Waiting for a transaction: the decoder hands one over in the history entry, never the URL.
  { path: "/regtest/tx/push" },
  // Two payments pending, one of them a CPFP child.
  { path: `/regtest/address/${chain.addresses.p2wpkh}`, ready: balance },
  // As of a block, with its band (docs/FRONTEND.md "An address as of a block"), in the longest form.
  { path: `/regtest/address/${chain.addresses.p2tr}?at=106`, ready: balance },
  // Above the node's cap, refused its totals (a stand-in 503), as the node does.
  {
    path: `/regtest/address/${LARGE}`,
    stub: (page) => stubLarge(page),
    ready: (p) => p.getByRole("table", { name: /^Unconfirmed transactions/ }).getByRole("link"),
  },
  // Kept by the server's ledger, and being added up (docs/API.md, "Very large addresses").
  {
    path: `/regtest/address/${LARGE}?ledger=kept`,
    stub: (page) => stubLarge(page, { ledger: () => KEPT }),
    ready: (p) =>
      p.getByRole("table", { name: /^Newest confirmed transactions/ }).getByRole("link"),
  },
  {
    path: `/regtest/address/${LARGE}?ledger=adding`,
    stub: (page) => stubLarge(page, { ledger: () => ({ state: "seeding", seconds: 95 }) }),
    ready: (p) => p.getByRole("region", { name: "Adding up this address for the first time" }),
  },
  // Read in the browser: nothing to stub.
  { path: `/regtest/address/${SILENT_PAYMENT}` },
  // Regtest never retargets, so its past adjustments are mainnet's.
  { path: "/regtest/mining", stub: stubRetargets, ready: table },
  { path: "/regtest/mining/pool/unknown", ready: table },
  { path: "/regtest/mempool", ready: (p) => p.getByRole("slider") },
  // Regtest's own answer, then mainnet's recorded week: every level with its share and meter.
  { path: "/regtest/fees/score" },
  {
    path: "/regtest/fees/score?window=1w",
    stub: serveScore,
    ready: (p) => p.getByRole("heading", { level: 3, name: "No rush" }),
  },
  // Empty, whichever test replaced a transaction first: its "none yet" once lay over the next part.
  { path: "/regtest/rbf", stub: noReplacements },
  { path: "/regtest/rbf#mainnet", stub: replacements, ready: table },
  { path: "/regtest/lightning", stub: lightning, ready: (p) => p.getByRole("slider") },
  { path: "/regtest/lightning/rankings", stub: lightning, ready: table },
  {
    path: `/regtest/lightning/node/${ACINQ}`,
    stub: lightning,
    ready: (p) => p.getByRole("heading", { name: "At a glance" }),
  },
  {
    path: `/regtest/lightning/node/${ACINQ}?view=closed`,
    stub: lightning,
    ready: (p) => p.getByRole("heading", { name: "With whom" }),
  },
  { path: "/regtest/lightning/channel/811984x2037x0", stub: lightning, ready: table },
  {
    path: "/regtest/lightning/search?q=acinq",
    stub: lightning,
    ready: (p) => p.getByRole("link", { name: "ACINQ" }),
  },
  {
    path: "/regtest/lightning/penalties",
    stub: lightning,
    ready: (p) => p.getByRole("region", { name: "Revoked states swept" }).getByRole("link"),
  },
  {
    path: "/regtest/ark",
    stub: withBoth,
    ready: (p) => p.getByRole("textbox", { name: "VTXO or Ark address" }),
  },
  // The lookup with an outpoint both implementations know (which should not happen): its one state
  // with controls of its own, and one with no 404 from a stub, which the sweeps count as an error.
  {
    path: `/regtest/ark/vtxo/${ID}`,
    stub: async (page) => {
      await withBoth(page);
      await arkadeKnowsBarks(page);
    },
    ready: (p) => p.getByRole("link", { name: "Arkade", exact: true }),
  },
  { path: `/regtest/ark/bark/vtxo/${ID}`, stub: (page) => withBark(page, true), ready: playExit },
  { path: `/regtest/ark/bark/hex#${HEX}`, stub: withBarkHex, ready: playExit },
  // Signet's real VTXO as it is (swept), then as if today: unspent, not settled, a 128-VTXO tree.
  {
    path: `/regtest/ark/arkade/vtxo/${ARKADE_ID}`,
    stub: (page) => withArkade(page),
    ready: playExit,
  },
  {
    path: `/regtest/ark/arkade/vtxo/${ARKADE_ID}#live`,
    stub: (page) => withArkade(page, true),
    ready: playExit,
  },
  // Signet's address as recorded (all swept), then with three VTXOs as if today.
  {
    path: `/regtest/ark/arkade/address/${ARKADE_ADDRESS}`,
    stub: (page) => withArkadeAddress(page),
  },
  {
    path: `/regtest/ark/arkade/address/${ARKADE_ADDRESS}?page=11#live`,
    stub: (page) => withArkadeAddress(page, true),
    ready: (p) => p.getByRole("table", { name: /VTXOs, newest first/ }),
  },
  // Waiting for its files: a proof's verdicts are drawn in timestamp.e2e.ts.
  {
    path: "/regtest/timestamp",
    ready: (p) => p.getByRole("heading", { level: 2, name: "Proof" }),
  },
  // One page on every network: a named invoice with route hints.
  { path: "/decode#lnbc20m1example", stub: withInvoice },
  // The public docs: one template for every page of them, outside the app.
  {
    path: "/docs",
    faults: {
      fonts: {
        "a code block's text runs into its Copy button, from 320 to 1100 px":
          /^\d+ px, \w+: "[^"]*" \(code\) runs into "Copy" \(button\.code__copy\)$/,
      },
      targets: {
        "the brand is under 44 px wide": /^\d+ px: a\.brand "rbitcoin\.space" is \d+ × \d+ px/,
        "Copy page and its menu are under 44 px tall":
          /^\d+ px: button\.split__\w+ "[^"]*" is \d+ × \d+ px/,
        "each code block's Copy is under 44 px tall":
          /^\d+ px: button\.code__copy "Copy" is \d+ × \d+ px/,
        "the table's links lie under their cell": /^\d+ px: a "[^"]*" is (under td |.* by td )/,
      },
      a11y: {
        "a code block that scrolls cannot take focus":
          /^axe-core, light: scrollable-region-focusable at \.code-block/,
      },
      walk: {
        'the skip link reads "Skip to the page"': /^the first stop is a "Skip to the page"/,
      },
    },
  },
  {
    path: "/regtest/no/such/page",
    ready: (p) => p.getByRole("heading", { level: 1, name: "Page not found" }),
  },
];

/** Opens a page of `PAGES` and waits until its data is drawn and nothing is still loading. */
export async function open(page: Page, { path, stub, ready }: SweptPage) {
  await stub?.(page);
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if (ready) await expect(ready(page).first()).toBeVisible({ timeout: 15_000 });
  const loading = page.locator("[aria-busy='true'], .state--loading, main .skel");
  // A part that loads once it is near the screen (an address's balance chart) is shown it.
  await expect(async () => {
    await loading.evaluateAll((all) => all[0]?.scrollIntoView({ block: "center" }));
    await expect(loading).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
}
