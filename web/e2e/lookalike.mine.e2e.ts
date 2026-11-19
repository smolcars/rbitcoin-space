// Address poisoning on the run's chain: a payment that names a lookalike of the page's own address,
// and one that names a lookalike of an address another transaction paid (docs/FRONTEND.md
// "Lookalike addresses"). It mines, so it runs after every other test (the `mines` project).
import type { Locator, Page } from "@playwright/test";
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

/** A card's computed left border: its width, and whether its colour is the caution token's. */
const cautionRule = (card: Locator) =>
  card.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-caution)";
    document.body.append(probe);
    const caution = getComputedStyle(probe).color;
    probe.remove();
    const s = getComputedStyle(el);
    return { width: s.borderLeftWidth, caution: s.borderLeftColor === caution };
  });

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

  // Opened from that row, the transaction page says so and marks the lookalike where it appears.
  const flagged = `/regtest/tx/${txids[1]}`;
  await rows(page).first().locator("a.hash__text").click();
  await expect(page).toHaveURL(flagged);
  const caution = page.locator("section.tx-lookalike");
  await expect(caution.getByRole("heading")).toHaveText(
    "Someone may be imitating the address you came from",
  );
  await expect(caution.locator(".lookalike__agree")).toHaveText(["92tj", "mmx6", "92tj", "mmx6"]);
  const card = page.locator(".tx-flow__item--lookalike");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Lookalike");
  await expect(card.locator(`a[href="/regtest/address/${VICTIM_LOOKALIKE}"]`)).toHaveCount(1);
  // Its caution rule is drawn, not only its word: the computed left border, against the token.
  expect(await cautionRule(card)).toStrictEqual({ width: "3px", caution: true });
  // On a phone its inspector's address is whole, and a tap anywhere on it, its last character
  // included, opens it rather than copying it: the copy button's target stops at its edge.
  const before = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 800 });
  await card.locator(".tx-flow__open").click();
  const missed = await page.locator("#tx-inspector .tx-lookalike-addr a").evaluate((a) => {
    a.scrollIntoView({ block: "center" });
    return [...a.getClientRects()].flatMap((r) => {
      const y = r.top + r.height / 2;
      return [r.left + 1, r.right - 1].flatMap((x) =>
        document.elementFromPoint(x, y)?.closest("a, button") === a ? [] : [`${x},${y}`],
      );
    });
  });
  expect(missed).toStrictEqual([]);
  // The same again at a smaller text size, where a gap in rem would shrink under the button's
  // reach, which is in pixels.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "12px";
  });
  const missedSmall = await page.locator("#tx-inspector .tx-lookalike-addr a").evaluate((a) => {
    a.scrollIntoView({ block: "center" });
    return [...a.getClientRects()].flatMap((r) => {
      const y = r.top + r.height / 2;
      return [r.left + 1, r.right - 1].flatMap((x) =>
        document.elementFromPoint(x, y)?.closest("a, button") === a ? [] : [`${x},${y}`],
      );
    });
  });
  expect(missedSmall).toStrictEqual([]);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  // Back to the width the run was given, a phone's or a desktop's.
  await page.setViewportSize(before ?? { width: 1280, height: 720 });
  // A reload keeps it, as the browser keeps the entry's state (so does going to the same URL).
  await page.reload();
  await expect(caution).toBeVisible();
  // The same transaction reached any other way says nothing.
  await page.goto(`/regtest/address/${VICTIM}`);
  await page.goto(flagged);
  await expect(page.locator(".tx-flow__item").first()).toBeVisible();
  await expect(page.locator(".tx-lookalike, .tx-flow__item--lookalike")).toHaveCount(0);

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
  await rows(page).first().locator("a.hash__text").click();
  await expect(page.locator("section.tx-lookalike h2")).toHaveText(
    "This transaction names a lookalike address",
  );
  await expect(page.locator(".tx-flow__item--lookalike")).toHaveCount(1);

  // An ordinary history.
  await page.goto(`/regtest/address/${chain.addresses.p2wpkh}`);
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator(".lookalike, .address-poison")).toHaveCount(0);
});
