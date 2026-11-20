import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import type { Transaction, Utxo, Vin, Vout } from "../../lib/esplora";
import {
  arrivals,
  confirmations,
  keptAfterRefresh,
  mergePages,
  netChange,
  pageIsFull,
  readSize,
  refusal,
  sortUtxos,
  txFeeRate,
} from "./address";

const ME = "bc1qme";
const OTHER = "bc1qother";

const out = (address: string, value: number): Vout => ({
  scriptpubkey: "",
  scriptpubkey_asm: "",
  scriptpubkey_type: "v0_p2wpkh",
  scriptpubkey_address: address,
  value,
});
const spend = (address: string, value: number): Vin => ({
  txid: "a".repeat(64),
  vout: 0,
  is_coinbase: false,
  prevout: out(address, value),
});
const tx = (vin: Vin[], vout: Vout[], extra: Partial<Transaction> = {}): Transaction => ({
  txid: "b".repeat(64),
  version: 2,
  locktime: 0,
  vin,
  vout,
  status: { confirmed: true, block_height: 1 },
  fee: 1000,
  weight: 800,
  ...extra,
});

describe("netChange", () => {
  it("counts a receive", () => {
    expect(netChange(tx([spend(OTHER, 50_000)], [out(ME, 30_000), out(OTHER, 19_000)]), ME)).toBe(
      30_000,
    );
  });

  it("counts a spend", () => {
    expect(netChange(tx([spend(ME, 50_000)], [out(OTHER, 49_000)]), ME)).toBe(-50_000);
  });

  it("nets a spend with change back to the address", () => {
    const t = tx([spend(ME, 50_000)], [out(OTHER, 20_000), out(ME, 29_000)]);
    expect(netChange(t, ME)).toBe(-21_000);
  });

  it("finds a public key's outputs by their script: they name no address", () => {
    const key = `02${"ab".repeat(32)}`;
    const paid = (value: number): Vout => ({
      scriptpubkey: `21${key}ac`,
      scriptpubkey_asm: "",
      scriptpubkey_type: "p2pk",
      value,
    });
    const input: Vin = { ...spend(OTHER, 0), prevout: paid(50_000) };
    expect(netChange(tx([input], [paid(20_000), out(OTHER, 29_000)]), key)).toBe(-30_000);
    // The same key uncompressed is paid by another script.
    expect(netChange(tx([input], [paid(20_000)]), `04${"ab".repeat(64)}`)).toBe(0);
  });

  it("leaves only the fee on a self-transfer", () => {
    expect(netChange(tx([spend(ME, 50_000)], [out(ME, 49_000)]), ME)).toBe(-1000);
  });

  it("adds up many inputs from the address", () => {
    const inputs = Array.from({ length: 40 }, () => spend(ME, 2_500));
    expect(netChange(tx([...inputs, spend(OTHER, 7)], [out(OTHER, 100_000)]), ME)).toBe(-100_000);
  });

  it("counts several outputs to the address and is exact for large amounts", () => {
    const t = tx(
      [spend(OTHER, 2_100_000_000_000_000)],
      [out(ME, 2_099_999_999_999_999), out(ME, 1)],
    );
    expect(netChange(t, ME)).toBe(2_100_000_000_000_000);
  });

  it("takes coinbase and outputs without an address in its stride", () => {
    const coinbase: Vin = {
      txid: "0".repeat(64),
      vout: 0xffffffff,
      is_coinbase: true,
      prevout: null,
    };
    const opReturn: Vout = { ...out(ME, 0), scriptpubkey_type: "op_return" };
    delete opReturn.scriptpubkey_address;
    expect(netChange(tx([coinbase], [out(ME, 312_500_000), opReturn]), ME)).toBe(312_500_000);
  });

  it("is unknown when the node has pruned the inputs", () => {
    expect(netChange(tx([], [out(ME, 1)], { pruned: true }), ME)).toBeNull();
  });
});

describe("txFeeRate", () => {
  it("is fee over virtual size, and absent for a coinbase", () => {
    expect(txFeeRate(tx([spend(OTHER, 1)], [], { fee: 1000, weight: 801 }))).toBeCloseTo(
      1000 / 201,
    );
    const coinbase: Vin = { txid: "0".repeat(64), vout: 0, is_coinbase: true };
    expect(txFeeRate(tx([coinbase], []))).toBeNull();
    const noFee = tx([spend(OTHER, 1)], []);
    delete noFee.fee;
    expect(txFeeRate(noFee)).toBeNull();
  });
});

describe("refusal", () => {
  it.each([
    [
      new ApiError(503, "Address history too large for this route; use the paged /txs routes."),
      "too-large",
    ],
    [new ApiError(503, "Address index is disabled on this server."), "no-index"],
    [
      new ApiError(
        503,
        "Unspent outputs and older history are not kept for an address this large.",
      ),
      "not-kept",
    ],
    [new ApiError(404, "Not found."), "gone"],
    [new ApiError(400, "Address is for another network."), "wrong-network"],
    [new ApiError(400, "Invalid address."), "invalid"],
    [new ApiError(503, "Node unavailable."), "failed"],
    [new ApiError(502, "Upstream unavailable."), "failed"],
    [new ApiError(0, "The server cannot be reached."), "failed"],
    [new Error("boom"), "failed"],
  ])("%s is %s", (thrown, kind) => {
    expect(refusal(thrown)).toBe(kind);
  });
});

const utxo = (value: number, height?: number): Utxo => ({
  txid: "c".repeat(64),
  vout: 0,
  value,
  status: height === undefined ? { confirmed: false } : { confirmed: true, block_height: height },
});

describe("unspent outputs", () => {
  it("sort unconfirmed first, then newest, then largest", () => {
    const sorted = sortUtxos([utxo(1, 5), utxo(2, 9), utxo(3), utxo(9, 5)]);
    expect(sorted.map((u) => u.value)).toStrictEqual([3, 2, 9, 1]);
  });

  it("count confirmations from the tip", () => {
    expect(confirmations(utxo(1, 106), 110)).toBe(5);
    expect(confirmations(utxo(1, 110), 110)).toBe(1);
    expect(confirmations(utxo(1), 110)).toBe(0);
    // A tip read before the output's block counts as none rather than negative
    expect(confirmations(utxo(1, 111), 110)).toBe(0);
  });
});

describe("mergePages", () => {
  const t = (id: string) => tx([], [], { txid: id });
  it("puts the fresh first page first and drops what it repeats", () => {
    const merged = mergePages([t("new"), t("a"), t("b")], [t("b"), t("c")]);
    expect(merged.map((x) => x.txid)).toStrictEqual(["new", "a", "b", "c"]);
  });
});

describe("pageIsFull", () => {
  const t = (confirmed: boolean) => tx([], [], { status: { confirmed } });
  it("counts only confirmed transactions against the page size", () => {
    expect(pageIsFull([t(false), t(false), t(true)], 2)).toBe(false);
    expect(pageIsFull([t(false), t(true), t(true)], 2)).toBe(true);
    expect(pageIsFull([], 25)).toBe(false);
  });
});

describe("keptAfterRefresh", () => {
  // Confirmed transactions numbered newest first; "u" ones are unconfirmed.
  const c = (n: number) => tx([], [], { txid: `c${n}` });
  const u = (n: number) => tx([], [], { txid: `u${n}`, status: { confirmed: false } });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => c(from + i));
  const ids = (list: Transaction[]) => list.map((t) => t.txid);

  it("keeps what was loaded after a page that pushed one transaction down", () => {
    const kept = keptAfterRefresh(range(0, 24), range(1, 50), 25);
    expect(ids(kept)).toStrictEqual(ids(range(25, 50)));
  });

  it("starts over when more arrived than a page holds, rather than skip any", () => {
    expect(keptAfterRefresh(range(1, 25), range(31, 80), 25)).toStrictEqual([]);
  });

  it("drops everything else when the fresh page is the whole history, as after a reorg", () => {
    expect(keptAfterRefresh([], [c(1)], 25)).toStrictEqual([]);
    expect(keptAfterRefresh(range(1, 3), range(1, 30), 25)).toStrictEqual([]);
  });

  it("measures from the last confirmed transaction and drops unconfirmed leftovers", () => {
    const fresh = [u(1), ...range(0, 24)];
    const shown = [u(2), ...range(1, 25), u(3), c(26)];
    expect(ids(keptAfterRefresh(fresh, shown, 25))).toStrictEqual(["c25", "c26"]);
  });
});

describe("readSize", () => {
  it("takes two whole numbers with more creates than the cap, and nothing else", () => {
    expect(readSize({ creates: 3_665_660, cap: 10_000 })).toStrictEqual({
      creates: 3_665_660,
      cap: 10_000,
    });
    for (const bad of [
      undefined,
      null,
      "3665660",
      [3_665_660, 10_000],
      {},
      { creates: 3_665_660 },
      { creates: "3665660", cap: 10_000 },
      { creates: 1.5, cap: 1 },
      { creates: 2 ** 60, cap: 10_000 },
      { creates: Number.NaN, cap: 10_000 },
      { creates: 10_000, cap: 10_000 },
      { creates: 5, cap: -10 },
    ]) {
      expect(readSize(bad)).toBeUndefined();
    }
  });
});

describe("arrivals", () => {
  const t = (n: number) => tx([], [], { txid: n.toString(16).padStart(64, "0") });
  it("puts newcomers first, keeps the rows shown, and drops what left", () => {
    const first = arrivals(undefined, [t(1), t(2)]);
    expect(first.list.map((x) => x.txid)).toStrictEqual([t(1).txid, t(2).txid]);
    expect(first.fresh.size).toBe(0);
    // The node lists them in no fixed order; t(1) confirmed, t(3) arrived.
    const next = arrivals(first.list, [t(3), t(2)]);
    expect(next.list.map((x) => x.txid)).toStrictEqual([t(3).txid, t(2).txid]);
    expect(next.list[1]).toBe(first.list[1]);
    expect([...next.fresh]).toStrictEqual([t(3).txid]);
    expect(arrivals(next.list, []).list).toStrictEqual([]);
  });
});
