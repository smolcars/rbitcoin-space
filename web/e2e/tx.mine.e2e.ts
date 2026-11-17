// Mines on the run's node, so it runs after every other test (the `mines` project).
import { expect, PROJECTION_LAG_MS, test } from "./fixtures";

/** P2WSH of OP_TRUE: the harness's miner script (docs/REGTEST.md), spent with the witness [OP_TRUE]. */
const MINER_SCRIPT = "00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260";

test("a transaction confirms while its page watches", async ({ page, rpc, mine }) => {
  // A transaction of its own, since earlier mining tests confirm the scenario's: the newest
  // mature coinbase still unspent (50 BTC to the miner script, which anyone can spend) back to the
  // miner script, built by hand like the harness's own (dev/regtest/regtest.py).
  let coinbase: string | undefined;
  for (let h = (await rpc<number>("getblockcount")) - 100; h > 0 && coinbase === undefined; h--) {
    const id = (await rpc<{ tx: string[] }>("getblock", [await rpc("getblockhash", [h]), 1])).tx[0];
    // An unspent output's details, or null (which the helper reports as a failure) when spent.
    const unspent = id !== undefined && (await rpc("gettxout", [id, 0]).catch(() => null)) !== null;
    if (unspent) coinbase = id;
  }
  if (coinbase === undefined) throw new Error("a mature coinbase is unspent");
  const le = (n: bigint, bytes: number) =>
    Array.from({ length: bytes }, (_, i) =>
      ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0"),
    ).join("");
  const prev = Array.from({ length: 32 }, (_, i) => coinbase.slice(62 - 2 * i, 64 - 2 * i)).join(
    "",
  );
  const raw =
    `02000000` +
    `0001` +
    `01${prev}00000000` +
    `00fdffffff` +
    `01${le(4_999_900_000n, 8)}22${MINER_SCRIPT}` +
    `010151` +
    `00000000`;
  const txid = await rpc<string>("sendrawtransaction", [raw]);

  await page.goto(`/regtest/tx/${txid}`);
  await expect(page.getByRole("link", { name: "Next block", exact: true }).first()).toBeVisible({
    timeout: PROJECTION_LAG_MS,
  });
  const [hash] = await mine(1);
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible({
    timeout: PROJECTION_LAG_MS,
  });
  const block = page.getByRole("link", { name: /^block \d+$/ });
  await expect(block).toHaveAttribute("href", `/regtest/block/${hash}`);
  await expect(page.getByText(/^Confirmed in block \d+\.$/)).toBeAttached();
  await expect(page.getByText("No: it is confirmed")).toBeVisible();
});
