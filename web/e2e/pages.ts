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

/** The rule sweeps that walk `PAGES`. */
export type Sweep = "fonts" | "targets" | "a11y" | "largeText";

export interface SweptPage {
  /** Unique: a fragment the page never reads tells two states of one path apart. */
  path: string;
  stub?: (page: Page) => Promise<void>;
  /** What the page shows once it has its data, where its heading comes first. */
  ready?: (page: Page) => Locator;
  /** What a sweep finds here and is not fixed yet: that sweep is expected to fail on this page. */
  faults?: Partial<Record<Sweep, string>>;
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
  { path: `/regtest/address/${chain.addresses.p2tr}`, ready: balance },
  // As of a block, with its band (docs/FRONTEND.md "An address as of a block").
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
      fonts: "a code block's text runs into its Copy button, from 320 to 1100 px",
      targets:
        "the brand, Copy page and each code block's Copy are under 44 px; the table's links lie under their cell",
      a11y: 'no scrolling code block is focusable (axe: scrollable-region-focusable); the skip link reads "Skip to the page"',
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
