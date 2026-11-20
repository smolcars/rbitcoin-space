// Every page type, each with what it needs stubbed, for the rule tests that walk them all.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
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
import { chain, stubRetargets } from "./fixtures";
import { KEPT, LARGE, stubLarge } from "./large-address";
import { penalties } from "./lightning-answers";
import { serveScore } from "./score-answers";

/** The keys of BIP352's first test vector as a test network silent payments address. */
export const SILENT_PAYMENT =
  "tsp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc3wk4yh";

const ACINQ = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";
const recorded = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/lightning/app/${name}.json`, import.meta.url), "utf8"),
  );

/** The recorded feed made 22 h 15 min to 23 h old, so its rows read their longest ("22 h 44 min ago"). */
function agedFeed(): unknown {
  const feed = recorded("feed") as { events: { time: number }[] };
  const shift =
    Math.floor(Date.now() / 1000) - 80_100 - Math.max(...feed.events.map((e) => e.time));
  for (const e of feed.events) e.time += shift;
  return feed;
}

/** Lightning on regtest from mainnet's recorded answers (as in lightning.e2e.ts). */
async function lightning(page: Page) {
  const answers: Record<string, unknown> = {
    status: recorded("status"),
    overview: recorded("overview"),
    "statistics/1w": recorded("statistics-1w"),
    "movers?period=1w": recorded("movers-1w"),
    "closes?days=30": recorded("closes-30"),
    feed: agedFeed(),
    [`nodes/${ACINQ}`]: recorded("node-acinq"),
    [`nodes/${ACINQ}/history`]: recorded("node-acinq-history"),
    "channels/811984x2037x0": recorded("channel-811984x2037x0"),
    "channels/811984x2037x0/fees": recorded("channel-811984x2037x0-fees"),
    [`nodes/${ACINQ}/fees`]: recorded("node-acinq-fees"),
    "search?q=acinq": recorded("search-acinq"),
    "rankings/capacity?limit=100": recorded("rankings-capacity"),
    penalties: penalties(3),
  };
  await page.route(/\/regtest\/app\/lightning\//, async (route) => {
    const url = new URL(route.request().url());
    const key = url.pathname.replace(/^\/regtest\/app\/lightning\//, "") + url.search;
    const json = answers[key];
    await (json === undefined ? route.continue() : route.fulfill({ json }));
  });
}

/** No replacements recorded. */
async function noReplacements(page: Page) {
  await page.route(/\/regtest\/api\/v1\/(fullrbf\/)?replacements$/, (route) =>
    route.fulfill({ json: [] }),
  );
}

/** Every page type, each with what it needs stubbed. */
export const PAGES: { path: string; stub?: (page: Page) => Promise<void> }[] = [
  { path: "/regtest/" },
  { path: "/regtest/blocks" },
  { path: `/regtest/block/${chain.blocks[106]}` },
  { path: "/regtest/block/next" },
  { path: `/regtest/tx/${chain.txs.script_types}` },
  { path: `/regtest/tx/${chain.txs.cpfp_child}` },
  { path: `/regtest/address/${chain.addresses.p2tr}` },
  // As of a block, with its band (docs/FRONTEND.md "An address as of a block").
  { path: `/regtest/address/${chain.addresses.p2tr}?at=106` },
  { path: `/regtest/address/${LARGE}`, stub: (page) => stubLarge(page) },
  // Kept by the server's ledger, and being added up (docs/API.md, "Very large addresses").
  {
    path: `/regtest/address/${LARGE}?ledger=kept`,
    stub: (page) => stubLarge(page, { ledger: () => KEPT }),
  },
  {
    path: `/regtest/address/${LARGE}?ledger=adding`,
    stub: (page) => stubLarge(page, { ledger: () => ({ state: "seeding", seconds: 95 }) }),
  },
  // Read in the browser: nothing to stub.
  { path: `/regtest/address/${SILENT_PAYMENT}` },
  { path: "/regtest/mining", stub: stubRetargets },
  { path: "/regtest/mining/pool/unknown" },
  { path: "/regtest/mempool" },
  // Regtest's own answer, then mainnet's recorded week: every level with its share and meter.
  { path: "/regtest/fees/score" },
  {
    path: "/regtest/fees/score?window=1w",
    stub: serveScore,
  },
  // Empty, whichever test replaced a transaction first: its "none yet" once lay over the next part.
  { path: "/regtest/rbf", stub: noReplacements },
  { path: "/regtest/lightning", stub: lightning },
  { path: "/regtest/lightning/rankings", stub: lightning },
  { path: `/regtest/lightning/node/${ACINQ}`, stub: lightning },
  { path: "/regtest/lightning/channel/811984x2037x0", stub: lightning },
  { path: "/regtest/lightning/search?q=acinq", stub: lightning },
  { path: "/regtest/lightning/penalties", stub: lightning },
  { path: "/regtest/ark", stub: withBoth },
  // The lookup with an outpoint both implementations know (which should not happen): its one state
  // with controls of its own, and one with no 404 from a stub, which the sweeps count as an error.
  {
    path: `/regtest/ark/vtxo/${ID}`,
    stub: async (page) => {
      await withBoth(page);
      await arkadeKnowsBarks(page);
    },
  },
  { path: `/regtest/ark/bark/vtxo/${ID}`, stub: (page) => withBark(page, true) },
  { path: `/regtest/ark/bark/hex#${HEX}`, stub: withBarkHex },
  // Signet's real VTXO as it is (swept), then as if today: unspent, not settled, a 128-VTXO tree.
  // The fragment only names the second: the page never reads it.
  { path: `/regtest/ark/arkade/vtxo/${ARKADE_ID}`, stub: (page) => withArkade(page) },
  { path: `/regtest/ark/arkade/vtxo/${ARKADE_ID}#live`, stub: (page) => withArkade(page, true) },
  // Signet's address as recorded (all swept), then with three VTXOs as if today.
  {
    path: `/regtest/ark/arkade/address/${ARKADE_ADDRESS}`,
    stub: (page) => withArkadeAddress(page),
  },
  {
    path: `/regtest/ark/arkade/address/${ARKADE_ADDRESS}?page=11#live`,
    stub: (page) => withArkadeAddress(page, true),
  },
  // One page on every network: a named invoice with route hints.
  { path: "/decode#lnbc20m1example", stub: withInvoice },
  { path: "/regtest/no/such/page" },
];
