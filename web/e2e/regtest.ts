// Chain changes for the tests that mine (`*.mine.e2e.ts`), made by hand like the harness's own
// (dev/regtest/regtest.py), and the tools that build an ordering of events on purpose.
import { createHash, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";

/** P2WSH of OP_TRUE: the harness's miner script (docs/REGTEST.md), spent with the witness [OP_TRUE]. */
export const MINER_SCRIPT = "00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260";
export type Rpc = <T>(method: string, params?: unknown[]) => Promise<T>;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/** A regtest P2PKH address of random bytes, which nobody has used. */
export function freshAddress(): string {
  const body = Buffer.concat([Buffer.from([0x6f]), randomBytes(20)]);
  let n = BigInt(`0x${Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]).toString("hex")}`);
  let s = "";
  for (; n > 0n; n /= 58n) s = `${B58[Number(n % 58n)]}${s}`;
  return s;
}

const le = (n: bigint, bytes: number) =>
  Array.from({ length: bytes }, (_, i) =>
    ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
const script = (hex: string) => `${(hex.length / 2).toString(16).padStart(2, "0")}${hex}`;

/** Coinbases this run has spent, so two payments in a row never take the same one. */
const spent = new Set<string>();

/** A mature coinbase of the miner script, unspent: its txid and value in sats. */
export async function coinbase(rpc: Rpc): Promise<{ txid: string; sats: bigint }> {
  for (let h = (await rpc<number>("getblockcount")) - 100; h > 0; h--) {
    const id = (await rpc<{ tx: string[] }>("getblock", [await rpc("getblockhash", [h]), 1])).tx[0];
    if (id === undefined || spent.has(id)) continue;
    // An unspent output's details, or null (which the helper reports as a failure) when spent.
    const out = await rpc<{ value: number; scriptPubKey: { hex: string } }>("gettxout", [id, 0])
      .then((o) => (o.scriptPubKey.hex === MINER_SCRIPT ? o : null))
      .catch(() => null);
    if (out === null) continue;
    spent.add(id);
    return { txid: id, sats: BigInt(Math.round(out.value * 1e8)) };
  }
  throw new Error("a mature coinbase is unspent");
}

/** A transaction spending output 0 of a miner-script coin to `outputs` (script hex, sats); it signals replaceability. */
export function spending(txid: string, outputs: [string, bigint][]): string {
  const prev = Array.from({ length: 32 }, (_, i) => txid.slice(62 - 2 * i, 64 - 2 * i)).join("");
  const outs = outputs.map(([s, sats]) => `${le(sats, 8)}${script(s)}`).join("");
  return (
    `02000000` +
    `0001` +
    `01${prev}00000000` +
    `00fdffffff` +
    `${outputs.length.toString(16).padStart(2, "0")}${outs}` +
    `010151` +
    `00000000`
  );
}

/** As `spending`, from output 0 of several miner-script coins: each input's witness is [OP_TRUE]. */
export function spendingMany(txids: string[], outputs: [string, bigint][]): string {
  const prev = (txid: string) =>
    Array.from({ length: 32 }, (_, i) => txid.slice(62 - 2 * i, 64 - 2 * i)).join("");
  const ins = txids.map((t) => `${prev(t)}0000000000fdffffff`).join("");
  const outs = outputs.map(([s, sats]) => `${le(sats, 8)}${script(s)}`).join("");
  const count = (n: number) => n.toString(16).padStart(2, "0");
  const witness = txids.map(() => "010151").join("");
  return `020000000001${count(txids.length)}${ins}${count(outputs.length)}${outs}${witness}00000000`;
}

/** Pays `sats` to `address` from a mature coinbase of the miner script; the change goes back to it. */
export async function pay(rpc: Rpc, address: string, sats: bigint): Promise<string> {
  const { scriptPubKey } = await rpc<{ scriptPubKey: string }>("validateaddress", [address]);
  const coin = await coinbase(rpc);
  // The same fee every time, on purpose: a payment just like one a block took must be seen at once.
  const change = coin.sats - sats - 10_000n;
  return rpc<string>("sendrawtransaction", [
    spending(coin.txid, [
      [scriptPubKey, sats],
      [MINER_SCRIPT, change],
    ]),
  ]);
}

/** A block whose coinbase pays `address`, holding `txids` and nothing else from the mempool. */
export const block = (rpc: Rpc, address: string, txids: string[] = []) =>
  rpc<{ hash: string }>("generateblock", [address, txids]).then((b) => b.hash);

/** A gate a socket route waits at until the test opens it. */
export function gate() {
  let open: () => void = () => undefined;
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, shut };
}

/**
 * Has the page's browser keep the answer at `url` in its HTTP cache, as the page itself asks for
 * it, at the start of a second: an answer the server marks `max-age=1` then stays fresh for most of
 * that second (its `Date` has whole seconds), long enough for the change the test makes next.
 */
export async function keep(page: Page, url: string, accept = "application/json"): Promise<void> {
  await page.waitForTimeout(1000 + 20 - (Date.now() % 1000));
  await page.evaluate(({ u, a }) => fetch(u, { headers: { accept: a } }).then((r) => r.text()), {
    u: url,
    a: accept,
  });
}
