// Answers for the Ark pages' browser tests. Regtest has no Bark server, so a configured one is
// driven from the answer the server writes for ark-lib's `arkoor3_vtxo` vector (fixtures/bark),
// with `/app/config` saying regtest has Bark. Its transactions are on no chain.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

const ANSWER = JSON.parse(
  readFileSync(new URL("../../fixtures/bark/answer-arkoor3.json", import.meta.url), "utf8"),
) as { anchor: { txid: string }; txs: { txid: string }[] };
export const ID = "125985e9e2bfa047fe064967bb988623098f08e1808c6e27ad82d220594b7567:0";

/**
 * Regtest with Bark: the config says so, and lookups answer from the fixture (any other id is
 * unknown). With `onChain`, the anchor reads as confirmed and every exit transaction as in the
 * mempool, so the page asks nothing the node answers 404.
 */
export async function withBark(page: Page, onChain = false) {
  await page.route(/\/app\/config$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, ark: { regtest: ["bark"] } } });
  });
  await page.route(/\/regtest\/app\/ark\/bark\/vtxo\//, (route) =>
    route.request().url().endsWith(ID)
      ? route.fulfill({ json: ANSWER })
      : route.fulfill({ status: 404, json: { error: "vtxo not found" } }),
  );
  if (!onChain) return;
  await page.route(/\/regtest\/api\/tx\/[0-9a-f]{64}\/status$/, (route) => {
    const txid = /tx\/([0-9a-f]{64})\//.exec(route.request().url())?.[1];
    if (txid === ANSWER.anchor.txid) {
      return route.fulfill({ json: { confirmed: true, block_height: 100 } });
    }
    if (ANSWER.txs.some((t) => t.txid === txid))
      return route.fulfill({ json: { confirmed: false } });
    return route.continue();
  });
}
