// The privacy check on shapes the scenario lacks (docs/FRONTEND.md "Privacy check"): a CoinJoin's
// and a clean one on the transaction page, and on the decoder and Broadcast a spend of 101 coins, past the check
// route's 100 lookups, so its answer itself leaves one input unknown. Nothing here is sent but the
// coins the test makes on regtest.
import { createHash, randomBytes } from "node:crypto";
import { axe } from "./axe";
import { expect, test } from "./fixtures";
import { coinbase, MINER_SCRIPT, type Rpc, spending } from "./regtest";

const sha256 = (hex: string) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
/** P2WSH of a script anyone can spend by giving the script itself: OP_1 to OP_16 leave a true value. */
const anyone = (script: string) => `0020${sha256(script)}`;
/** A P2WPKH script of a key nobody holds. */
const fresh = () => `0014${randomBytes(20).toString("hex")}`;

const le = (n: bigint, bytes: number) =>
  Array.from({ length: bytes }, (_, i) =>
    ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
const varint = (n: number) =>
  n < 0xfd ? n.toString(16).padStart(2, "0") : `fd${le(BigInt(n), 2)}`;
const push = (hex: string) => `${varint(hex.length / 2)}${hex}`;
/** A txid's bytes in the order a transaction holds them. */
const reversed = (txid: string) =>
  Array.from({ length: 32 }, (_, i) => txid.slice(62 - 2 * i, 64 - 2 * i)).join("");

/** A version 2 SegWit transaction: each input spends a P2WSH of `script` by giving `script`. */
function build(
  inputs: { txid: string; vout: number; script: string }[],
  outputs: [string, bigint][],
): string {
  const ins = inputs.map((i) => `${reversed(i.txid)}${le(BigInt(i.vout), 4)}00fdffffff`).join("");
  const outs = outputs.map(([s, sats]) => `${le(sats, 8)}${push(s)}`).join("");
  const witness = inputs.map((i) => `01${push(i.script)}`).join("");
  return `020000000001${varint(inputs.length)}${ins}${varint(outputs.length)}${outs}${witness}00000000`;
}

const send = (rpc: Rpc, hex: string) => rpc<string>("sendrawtransaction", [hex]);

test("a transaction shaped like a CoinJoin is a neutral finding, with no change read", async ({
  page,
  rpc,
  mine,
}) => {
  // Three coins at three different addresses, then those three to three equal outputs.
  const coin = await coinbase(rpc);
  const scripts = ["52", "53", "54"];
  const split = await send(
    rpc,
    spending(coin.txid, [
      ...scripts.map((s): [string, bigint] => [anyone(s), 200_000_000n]),
      [MINER_SCRIPT, coin.sats - 600_000_000n - 20_000n],
    ]),
  );
  const join = await send(
    rpc,
    build(
      scripts.map((script, vout) => ({ txid: split, vout, script })),
      scripts.map((): [string, bigint] => [fresh(), 199_990_000n]),
    ),
  );
  await mine(1);

  await page.goto(`/regtest/tx/${join}`);
  const section = page.getByRole("region", { name: "What an observer can read" });
  await expect(section.getByText("Shaped like a CoinJoin", { exact: true })).toBeVisible();
  await expect(section).toContainText(
    "Outputs 0, 1 and 2 each pay exactly 1.9999 BTC to a different address, and the inputs that fund it spend from 3 different addresses.",
  );
  await expect(section).not.toContainText("reads as change");
  // "Outputs 0, 1 and 2": each number keeps its comma on its line, right against it, and the
  // numbers' 24 px targets still do not overlap.
  const tails = await section.locator(".pv-ref-tail").evaluateAll((spans) =>
    spans.map((t) => {
      const chip = t.querySelector(".pv-ref")?.getBoundingClientRect();
      const r = document.createRange();
      const mark = [...t.childNodes].find((n) => n instanceof Text && n.data.trim() !== "");
      if (mark) r.selectNodeContents(mark);
      const box = r.getBoundingClientRect();
      return {
        text: t.textContent,
        lines: new Set([...t.getClientRects()].map((x) => Math.round(x.top))).size,
        gap: Math.round(box.left - (chip?.right ?? 0)),
      };
    }),
  );
  expect(tails).toStrictEqual([{ text: "0,", lines: 1, gap: 0 }]);
  const overlapped = await section.locator(".pv-ref").evaluateAll((as) =>
    as.flatMap((a) => {
      a.scrollIntoView({ block: "center" });
      const r = a.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return [-11, 11].flatMap((d) =>
        [document.elementFromPoint(x + d, y), document.elementFromPoint(x, y + d)]
          .map((e) => e?.closest("a"))
          .filter((e) => e !== a)
          .map(() => a.getAttribute("aria-label")),
      );
    }),
  );
  expect(overlapped).toStrictEqual([]);
  const outputs = page.getByRole("list", { name: "Outputs" });
  await expect(outputs.getByText("Equal amount")).toHaveCount(3);
  // Neutral: the open eye, in the text's colour, never the caution's.
  await expect(page.locator(".pv-item--neutral")).toHaveCount(1);
  await expect(page.locator(".pv-item--caution, .pv-tag--caution")).toHaveCount(0);
  expect(await axe(page)).toStrictEqual([]);
});

test("a clean transaction is one muted line", async ({ page, rpc, mine }) => {
  // A coin at an address of its own, spent whole to one fresh address: nothing to read.
  const coin = await coinbase(rpc);
  const split = await send(
    rpc,
    spending(coin.txid, [
      [anyone("55"), 100_000_000n],
      [MINER_SCRIPT, coin.sats - 100_000_000n - 20_000n],
    ]),
  );
  const clean = await send(
    rpc,
    build([{ txid: split, vout: 0, script: "55" }], [[fresh(), 99_990_000n]]),
  );
  await mine(1);

  await page.goto(`/regtest/tx/${clean}`);
  await expect(page.getByText("Nothing in this transaction's shape stands out.")).toBeVisible();
  // Wide, a panel of its own beside the flow, named like the others, after the details.
  await expect(page.getByRole("heading", { name: "What an observer can read" })).toHaveCount(1);
  await expect(page.locator(".tx-rail__details + #pv-list")).toBeVisible();
  await expect(page.locator(".tx-flow .pv-tag")).toHaveCount(0);
  await expect(page.getByText("What this checks")).toBeVisible();
  expect(await axe(page)).toStrictEqual([]);
  // Narrow, under the flow: one muted line, no heading, and nothing in the summary.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.locator(".tx-main__flow .pv-none")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What an observer can read" })).toHaveCount(0);
  await expect(page.locator(".tx-answer__privacy")).toHaveCount(0);
});

test.describe("past the check route's 100 lookups", () => {
  // The next block's rate may be refused while the server's fee level settles on regtest.
  test.use({ consoleErrorsAllowed: [/status of 503/] });

  test("the decoder and Broadcast say only part could be checked, from the route's own answer", async ({
    page,
    rpc,
    mine,
  }) => {
    // 101 coins at the miner's address, confirmed; then a spend of all of them, never sent.
    const coin = await coinbase(rpc);
    const each = 10_000_000n;
    const coins = await send(
      rpc,
      spending(coin.txid, [
        ...Array.from({ length: 101 }, (): [string, bigint] => [MINER_SCRIPT, each]),
        [MINER_SCRIPT, coin.sats - 101n * each - 200_000n],
      ]),
    );
    await mine(1);
    const hex = build(
      Array.from({ length: 101 }, (_, vout) => ({ txid: coins, vout, script: "51" })),
      [
        ["00147503ccb2c772094595aa0491a48c29de61c04e61", 500_000_000n],
        [MINER_SCRIPT, 101n * each - 500_000_000n - 123_457n],
      ],
    );

    const check = async () => {
      const notice = page.getByRole("region", {
        name: "Once it is sent, anyone can read this from it",
      });
      await expect(notice.locator(".pv-partial p")).toHaveText([
        "Only part of this transaction could be checked.",
        "What input 100 spends is not known here, so these were not checked: the CoinJoin shape, outputs paying back to an input's address, script types and the least spent from one funding address.",
        // Two paying outputs can be no CoinJoin, so the unknown coin cannot undo "spent together".
        "What it shows about address reuse and which output is change may be incomplete.",
      ]);
      // The hundred coins the route looked up are still read as spent together.
      await expect(notice.getByText("Coins spent together", { exact: true })).toBeVisible();
      await expect(notice).toContainText(
        "100 inputs are spent together, all from one address: an observer may read them as one owner's.",
      );
      // What the route did look up still reads: the 100 coins share one address.
      await expect(notice).toContainText("100 inputs spend from");
      await expect(notice).not.toContainText("stands out");
      expect(await axe(page)).toStrictEqual([]);
    };

    const answered = page.waitForResponse((r) => r.url().endsWith("/app/tx/check"));
    await page.goto(`/decode#${hex}`);
    const answer = (await (await answered).json()) as { tx: { vin: { prevout?: unknown }[] } };
    await check();
    // The route's answer itself: 100 inputs looked up, the 101st not.
    const { vin } = answer.tx;
    expect(vin.filter((i) => i.prevout !== undefined)).toHaveLength(100);
    expect("prevout" in (vin[100] ?? {})).toBe(false);

    await page.goto("/regtest/tx/push");
    await page.getByRole("textbox", { name: "Signed transaction in hex" }).fill(hex);
    await check();
  });
});
