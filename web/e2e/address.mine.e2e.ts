// Mines on the run's node, so it runs after every other test (the `mines` project).
import { chain, expect, test } from "./fixtures";

/** P2WSH of OP_TRUE: the harness's miner script (docs/REGTEST.md), spent with the witness [OP_TRUE]. */
const MINER_SCRIPT = "00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260";
type Rpc = <T>(method: string, params?: unknown[]) => Promise<T>;
interface Stats {
  chain_stats: { tx_count: number };
}
const le = (n: bigint, bytes: number) =>
  Array.from({ length: bytes }, (_, i) =>
    ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");

/**
 * Pays `sats` to `address` from the newest mature coinbase still unspent (the miner script, which
 * anyone can spend), the change back to the miner script: built by hand, as the harness does.
 */
async function pay(rpc: Rpc, address: string, sats: bigint): Promise<string> {
  const { scriptPubKey } = await rpc<{ scriptPubKey: string }>("validateaddress", [address]);
  for (let h = (await rpc<number>("getblockcount")) - 100; h > 0; h--) {
    const id = (await rpc<{ tx: string[] }>("getblock", [await rpc("getblockhash", [h]), 1])).tx[0];
    // An unspent output's details, or null (which the helper reports as a failure) when spent.
    const out =
      id === undefined ? null : await rpc<{ value: number }>("gettxout", [id, 0]).catch(() => null);
    if (id === undefined || out === null) continue;
    const change = BigInt(Math.round(out.value * 1e8)) - sats - 10_000n;
    const prev = Array.from({ length: 32 }, (_, i) => id.slice(62 - 2 * i, 64 - 2 * i)).join("");
    const script = (hex: string) => `${(hex.length / 2).toString(16).padStart(2, "0")}${hex}`;
    const raw =
      `02000000` +
      `0001` +
      `01${prev}00000000` +
      `00fdffffff` +
      `02${le(sats, 8)}${script(scriptPubKey)}${le(change, 8)}${script(MINER_SCRIPT)}` +
      `010151` +
      `00000000`;
    return rpc<string>("sendrawtransaction", [raw]);
  }
  throw new Error("a mature coinbase is unspent");
}

test("an address page shows a new payment without a reload", async ({ page, rpc, mine }) => {
  await page.goto(`/regtest/address/${chain.addresses.p2wpkh}`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const rows = page.getByRole("table").locator("tbody tr");
  await expect(rows.first()).toContainText("Unconfirmed");
  const before = await rows.count();
  // The row a reader may be on, or a test may hold, when the history is asked again.
  const held = await rows.first().elementHandle();
  // `mine` waits for the server to catch up; the block itself is one whose coinbase pays the
  // address, holding nothing from the mempool, so the payment is the only change.
  await mine(0);
  await rpc("generateblock", [chain.addresses.p2wpkh, []]);
  await expect(rows).toHaveCount(before + 1);
  await expect(page.locator("tbody tr.address-row--new")).toHaveCount(1);
  // The rows already there are the same elements, moved down: nothing was rebuilt around them.
  expect(await held?.evaluate((tr) => tr.isConnected)).toBe(true);
});

test("the balance chart steps with each block and follows a new payment", async ({
  page,
  rpc,
  mine,
}) => {
  // The P2SH address received 0.5 BTC in block 106 and spent it in 107; now it receives again.
  // Each block holds only the test's own payment: later tests count on the scenario's mempool.
  const block = async (txid: string) => {
    await mine(0);
    await rpc("generateblock", [chain.addresses.miner, [txid]]);
  };
  await block(await pay(rpc, chain.addresses.p2sh, 30_000_000n));
  await page.goto(`/regtest/address/${chain.addresses.p2sh}`);
  const chart = page.getByRole("slider", { name: "Confirmed balance after each block" });
  await expect(chart).toHaveAttribute("aria-valuemax", "2");
  await page.getByText("Show the figures").click();
  const figures = page.getByRole("region", { name: /figures$/ }).locator("tbody tr");
  const balances = () => figures.evaluateAll((rows) => rows.map((r) => r.children[1]?.textContent));
  await expect
    .poll(balances)
    .toEqual([
      "0.30\u202F000\u202F000 BTC",
      "0.00\u202F000\u202F000 BTC",
      "0.50\u202F000\u202F000 BTC",
    ]);
  await expect(figures.nth(1)).toContainText("107");

  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  // Until the totals count the block, the chart is answered from before it, as an answer up to a
  // second old (`max-age=1`) can be while the totals' is already new. The page stops catching up
  // once the totals change, so the chart must see it is behind them and ask again by itself.
  const totals = `/regtest/api/address/${chain.addresses.p2sh}`;
  const summary = `**${totals}/txs/summary`;
  const counted = (await (await page.request.get(totals)).json()) as Stats;
  const stale = await (await page.request.get(`${totals}/txs/summary`)).text();
  await page.route(summary, (route) =>
    route.fulfill({ contentType: "application/json", body: stale }),
  );
  // A body the browser dropped (an answer a newer request replaced), a refusal or an error body
  // without totals is not the one awaited: the wait passes over it rather than throwing.
  const newTotals = page.waitForResponse(
    async (r) =>
      new URL(r.url()).pathname === totals &&
      r.ok() &&
      (await r.json().then(
        (b: Partial<Stats>) => (b.chain_stats?.tx_count ?? 0) > counted.chain_stats.tx_count,
        () => false,
      )),
  );
  await block(await pay(rpc, chain.addresses.p2sh, 20_000_000n));
  await newTotals;
  await page.unroute(summary);
  await expect(chart).toHaveAttribute("aria-valuemax", "3");
  await expect
    .poll(balances)
    .toEqual([
      "0.50\u202F000\u202F000 BTC",
      "0.30\u202F000\u202F000 BTC",
      "0.00\u202F000\u202F000 BTC",
      "0.50\u202F000\u202F000 BTC",
    ]);
  await expect(chart).toHaveAttribute(
    "aria-valuetext",
    /Balance 0\.50\s000\s000 BTC, Block \d+, Change \+0\.20\s000\s000 BTC$/,
  );
});
