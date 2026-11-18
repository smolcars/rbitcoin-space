// Address poisoning on the run's chain: a payment that names a lookalike of the page's own address,
// and one that names a lookalike of an address another transaction paid (docs/FRONTEND.md
// "Lookalike addresses"). It mines, so it runs after every other test (the `mines` project).
import type { Page } from "@playwright/test";
import { chain, expect, test } from "./fixtures";
import { block, coinbase, MINER_SCRIPT, type Rpc, spending } from "./regtest";

// Made-up witness programs nobody can spend: an output script is only bytes. Each lookalike keeps
// its address's leading program bytes and a ground middle whose bech32 checksum ends in the same
// four characters (about a million checksums each, done once and pinned here).
/** P2WPKH of sha256("rbitcoin.space lookalike victim")[..20]. */
const VICTIM = "bcrt1q92tjde2x93754htnwfj50zh9g2dmx39f5kmmx6";
/** Agrees with VICTIM on "92tj" after "bcrt1q" and on "mmx6". */
const VICTIM_LOOKALIKE = "bcrt1q92tjvp70h8qk3ma6v7u4cnyqkffq94gvfsmmx6";
/** P2TR of sha256("rbitcoin.space lookalike payee"). */
const PAYEE = "bcrt1pdclg9pxv7f9q8wa527cg452hsvc4mlrm5cya77ju7d3t3kh2gnrsy44uu7";
/** Agrees with PAYEE on "dcl" after "bcrt1p" and on "4uu7": exactly the threshold. */
const PAYEE_LOOKALIKE = "bcrt1pdclrxgvd3rzmust7u2klx3xq7cna7pccla77ex8zuvekangf4gdqe74uu7";
/** P2PKH of sha256("rbitcoin.space lookalike customer")[..20]: paid beside PAYEE, then beside its lookalike. */
const CUSTOMER = "mjh66T2J8h1LrrvqrVMKahUaNSABz6YTFx";

/** Pays a few hundred sats to each address from one mature coinbase, the change to the miner. */
async function payAll(rpc: Rpc, addresses: string[]): Promise<string> {
  const coin = await coinbase(rpc);
  const scripts = await Promise.all(
    addresses.map((a) =>
      rpc<{ scriptPubKey: string }>("validateaddress", [a]).then((v) => v.scriptPubKey),
    ),
  );
  const outputs: [string, bigint][] = scripts.map((s) => [s, 600n]);
  outputs.push([MINER_SCRIPT, coin.sats - 600n * BigInt(addresses.length) - 10_000n]);
  return rpc<string>("sendrawtransaction", [spending(coin.txid, outputs)]);
}

const notes = (page: Page) => page.locator(".address-txs .table__note");
const rows = (page: Page) => page.locator(".address-txs tbody tr:not(.table__note)");

test("warns under a payment naming a lookalike, and nowhere else", async ({ page, rpc, mine }) => {
  await mine(0);
  const txids = [
    await payAll(rpc, [CUSTOMER, PAYEE]),
    await payAll(rpc, [VICTIM, VICTIM_LOOKALIKE]),
    await payAll(rpc, [CUSTOMER, PAYEE_LOOKALIKE]),
  ];
  // In a block of their own: later tests count on the scenario's mempool.
  await block(rpc, chain.addresses.miner, txids);

  // A lookalike of the page's own address.
  await page.goto(`/regtest/address/${VICTIM}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(notes(page)).toHaveCount(1);
  const note = notes(page).getByRole("note");
  await expect(note).toContainText("An address here looks like this page's address");
  await expect(note).toContainText(VICTIM_LOOKALIKE);
  await expect(note).toContainText("Check every character");
  await expect(note.locator(".lookalike__agree")).toHaveText(["92tj", "mmx6", "92tj", "mmx6"]);
  // And the notice at the top of the page, whose button lands on that warning.
  const top = page.locator(".address-poison");
  await expect(top).toContainText(
    "The only transaction in the history names an address that starts and ends like this one.",
  );
  await top.getByRole("button", { name: "Go to the transaction" }).click();
  await expect(note).toBeFocused();

  // A lookalike of an address another payment named: both rows carry it.
  await page.goto(`/regtest/address/${CUSTOMER}`);
  await expect(rows(page)).toHaveCount(2);
  await expect(notes(page)).toHaveCount(2);
  await expect(notes(page).first()).toContainText(PAYEE);
  await expect(notes(page).first()).toContainText(PAYEE_LOOKALIKE);
  await expect(notes(page).first()).toContainText("looks like another in this history");
  await expect(page.locator(".address-poison h2")).toHaveText(
    "Lookalike addresses in this history",
  );

  // An ordinary history.
  await page.goto(`/regtest/address/${chain.addresses.p2wpkh}`);
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator(".lookalike, .address-poison")).toHaveCount(0);
});
