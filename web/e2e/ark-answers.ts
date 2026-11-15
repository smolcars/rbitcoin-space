// Answers for the Ark pages' browser tests. Regtest has no Ark server, so a configured one is
// driven from recorded answers, with `/app/config` saying regtest has it. Bark's is the answer the
// server writes for ark-lib's `arkoor3_vtxo` vector (fixtures/bark); Arkade's is the one it writes
// for signet's d922b2c3…:0 from that server's recorded replies (fixtures/arkade). Their
// transactions are on no regtest chain.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

const fixture = (path: string) =>
  readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), "utf8");

const ANSWER = JSON.parse(fixture("bark/answer-arkoor3.json")) as {
  anchor: { txid: string };
  txs: { txid: string }[];
};
export const ID = "125985e9e2bfa047fe064967bb988623098f08e1808c6e27ad82d220594b7567:0";
/** The same VTXO as its serialized bytes: ark-lib's `arkoor3_vtxo`, whose point is `ID`. */
export const HEX = (JSON.parse(fixture("bark/vectors.json")) as { v2: { arkoor3_vtxo: string } }).v2
  .arkoor3_vtxo;

/** Signet's real Arkade VTXO: a transfer out of a 128-VTXO batch, preconfirmed, and swept. */
export const ARKADE_ID = "d922b2c3811ec22ae6c7b0bea4eaef16c33250bf4e717950f1898095e79773fc:0";
const ARKADE = fixture("arkade/answer-preconfirmed.json");
/** The recorded expiry, in every place the answer carries it. */
const ARKADE_EXPIRY = "1768316222";

/**
 * The recorded Arkade answer, or with `live` the same VTXO as if it were today: unspent, not yet
 * settled, 22 days from expiry, its batch not swept.
 */
export function arkadeAnswer(live = false): unknown {
  if (!live) return JSON.parse(ARKADE);
  const expiry = String(Math.floor(Date.now() / 1000) + 22 * 86_400);
  const a = JSON.parse(ARKADE.replaceAll(ARKADE_EXPIRY, expiry)) as {
    vtxo: { swept: boolean };
    batches: { swept: boolean }[];
  };
  a.vtxo.swept = false;
  for (const b of a.batches) b.swept = false;
  return a;
}

/** `/app/config` says regtest has these implementations. */
async function arkOn(page: Page, names: string[]) {
  await page.route(/\/app\/config$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, ark: { regtest: names } } });
  });
}

async function bark(page: Page, onChain: boolean) {
  await page.route(/\/regtest\/app\/ark\/bark\/vtxo\//, (route) =>
    route.request().url().endsWith(ID)
      ? route.fulfill({ json: ANSWER })
      : route.fulfill({ status: 404, json: { error: "vtxo not found" } }),
  );
  if (onChain) await onChainStatuses(page);
}

/** The anchor confirmed and every exit transaction in the mempool. */
async function onChainStatuses(page: Page) {
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

async function arkade(page: Page, live: boolean) {
  const known = `/regtest/app/ark/arkade/vtxo/${ARKADE_ID.replace(":", "/")}`;
  await page.route(/\/regtest\/app\/ark\/arkade\/vtxo\//, (route) =>
    new URL(route.request().url()).pathname === known
      ? route.fulfill({ json: arkadeAnswer(live) })
      : route.fulfill({ status: 404, json: { error: "vtxo not found" } }),
  );
}

/**
 * Regtest with Bark: the config says so, and lookups answer from the fixture (any other id is
 * unknown). With `onChain`, the anchor reads as confirmed and every exit transaction as in the
 * mempool, so the page asks nothing the node answers 404.
 */
export async function withBark(page: Page, onChain = false) {
  await arkOn(page, ["bark"]);
  await bark(page, onChain);
}

/**
 * A VTXO sent as hex answered as the server answers `HEX` where the node holds its anchor
 * (regtest's does not), with the anchor confirmed and the exit in the mempool. Needs no Bark
 * server, so the config is left as it is.
 */
export async function withBarkHex(page: Page) {
  await page.route(/\/regtest\/app\/ark\/bark\/vtxo$/, (route) =>
    route.request().method() === "POST" && route.request().postData() === HEX
      ? route.fulfill({ json: ANSWER })
      : route.continue(),
  );
  await onChainStatuses(page);
}

/** Regtest with Arkade, answering the recorded VTXO (`live`: as if today) and nothing else. */
export async function withArkade(page: Page, live = false) {
  await arkOn(page, ["arkade"]);
  await arkade(page, live);
}

/** Signet's server key and the script of the VTXO above: 256 VTXOs over 11 pages, all swept. */
export const ARKADE_ADDRESS =
  "tark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqnrjdp6x";
/** arkd's own test vector: an address of another Arkade server. */
export const FOREIGN_ADDRESS =
  "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";
/** Shaped as an Arkade address; the stub lists nothing for it. */
export const EMPTY_ADDRESS = `${ARKADE_ADDRESS.slice(0, -6)}qqqqqq`;
/** Shaped as version 0, which the stub refuses as its `arkade_version` would be. */
export const UNKNOWN_VERSION_ADDRESS = `${ARKADE_ADDRESS.slice(0, -6)}pppppp`;

interface Listed {
  page: number;
  vtxos: { spent: boolean; swept: boolean; preconfirmed: boolean; expires_at: number }[];
}
const LISTED = fixture("arkade/answer-address.json");
const LISTED_LAST = fixture("arkade/answer-address-last.json");

/**
 * A page of the address's list as the server answers it: the last page for 11, else the first's
 * VTXOs under the page asked. With `live`, its first three are as if today: unspent, 22 days left.
 */
export function addressAnswer(page: number, live = false): unknown {
  const a = JSON.parse(page === 11 ? LISTED_LAST : LISTED) as Listed;
  a.page = page;
  if (live) {
    for (const v of a.vtxos.slice(0, 3)) {
      v.spent = false;
      v.swept = false;
      v.expires_at = Math.floor(Date.now() / 1000) + 22 * 86_400;
    }
  }
  return a;
}

async function arkadeAddresses(page: Page, live: boolean) {
  await page.route(/\/regtest\/app\/ark\/arkade\/address\//, (route) => {
    const url = new URL(route.request().url());
    const address = decodeURIComponent(url.pathname.split("/").pop() ?? "").toLowerCase();
    const n = Number(url.searchParams.get("page") ?? "1");
    if (address === ARKADE_ADDRESS) return route.fulfill({ json: addressAnswer(n, live) });
    if (address === FOREIGN_ADDRESS) {
      return route.fulfill({
        status: 422,
        json: { error: "address belongs to another arkade server" },
      });
    }
    if (address === EMPTY_ADDRESS) return route.fulfill({ json: { page: 1, pages: 0, vtxos: [] } });
    if (address === UNKNOWN_VERSION_ADDRESS) {
      return route.fulfill({ status: 400, json: { error: "unknown ark address version" } });
    }
    return route.fulfill({ status: 400, json: { error: "invalid address" } });
  });
}

/** Regtest with Arkade, listing the recorded address (`live`: three of it as if today). */
export async function withArkadeAddress(page: Page, live = false) {
  await arkOn(page, ["arkade"]);
  await arkadeAddresses(page, live);
}

/** Regtest with both. */
export async function withBoth(page: Page) {
  await arkOn(page, ["bark", "arkade"]);
  await bark(page, false);
  await arkade(page, false);
}

/** Valid bech32m with made-up payloads: a Bark address (`p`) on regtest and an Arkade one (`q`) on mainnet. */
export const BARK_ADDRESS =
  "tark1p8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23c82ez2";
export const MAINNET_ADDRESS =
  "ark1q8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23wz6x87";

/** Every Bark lookup fails as an unreachable Bark server does. Register after `withBoth`. */
export async function barkDown(page: Page) {
  await page.route(/\/regtest\/app\/ark\/bark\/vtxo\//, (route) =>
    route.fulfill({ status: 502, json: { error: "bark server unavailable" } }),
  );
}

/** Arkade also knows Bark's VTXO, which should never happen. Register after `withBoth`. */
export async function arkadeKnowsBarks(page: Page) {
  const also = `/regtest/app/ark/arkade/vtxo/${ID.replace(":", "/")}`;
  await page.route(/\/regtest\/app\/ark\/arkade\/vtxo\//, (route) =>
    new URL(route.request().url()).pathname === also
      ? route.fulfill({ json: arkadeAnswer() })
      : route.fallback(),
  );
}
