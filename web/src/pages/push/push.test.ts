import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import type { ScriptType, Transaction, Vout } from "../../lib/esplora";
import { MAX_HEX, readChecked, readPasted, refusal, warnings } from "./push";

const TXID = "fc40c92d9763e584976a4c55b50b231c214f2a5ae0514dadc8e1bf0958d68fa6";
const PARENT = "547d53d4e4290dac860915c0c88f8212b3aeb440c400a0b31bc92ccb77dfa527";

const out = (value: number, type: ScriptType = "v0_p2wsh"): Vout => ({
  scriptpubkey: "0020",
  scriptpubkey_asm: "OP_0",
  scriptpubkey_type: type,
  value,
});

/** What the server answers for regtest's coinbase-10 spend (docs/API.md "Checking a transaction"). */
function answer(): { tx: Record<string, unknown>; known: unknown } {
  return {
    tx: {
      txid: TXID,
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: PARENT,
          vout: 0,
          prevout: out(5_000_000_000),
          scriptsig: "",
          scriptsig_asm: "",
          witness: ["51"],
          is_coinbase: false,
          sequence: 4_294_967_293,
        },
      ],
      vout: [out(4_999_999_000)],
      size: 99,
      weight: 381,
      fee: 1000,
      status: { confirmed: false },
    },
    known: null,
  };
}

describe("readPasted", () => {
  it("takes hex with whitespace anywhere, in either case", () => {
    expect(readPasted(" 02AB\n cd \t")).toStrictEqual({ kind: "hex", hex: "02abcd" });
    expect(readPasted(" \n ")).toStrictEqual({ kind: "empty" });
  });

  it("says what is wrong without asking the server", () => {
    expect(readPasted("0x02")).toMatchObject({ kind: "bad" });
    expect(readPasted("abc")).toStrictEqual({ kind: "bad", why: "Odd number of hex digits" });
    expect(readPasted("<script>")).toStrictEqual({ kind: "bad", why: "Not hex" });
    expect(readPasted("00".repeat(MAX_HEX / 2))).toMatchObject({ kind: "hex" });
    expect(readPasted("00".repeat(MAX_HEX / 2 + 1))).toMatchObject({ kind: "bad" });
  });
});

describe("readChecked", () => {
  it("reads the server's answer", () => {
    const c = readChecked(answer());
    expect(c?.tx.txid).toBe(TXID);
    expect(c?.known).toBeNull();
    const confirmed = { ...answer(), known: { confirmed: true, block_height: 111 } };
    expect(readChecked(confirmed)?.known).toStrictEqual({ confirmed: true, block_height: 111 });
  });

  it("refuses anything else", () => {
    const bad: ((a: ReturnType<typeof answer>) => unknown)[] = [
      () => null,
      () => [],
      (a) => ({ ...a, tx: null }),
      (a) => ({ ...a, tx: { ...a.tx, txid: "zz" } }),
      (a) => ({ ...a, tx: { ...a.tx, fee: -1 } }),
      (a) => ({ ...a, tx: { ...a.tx, vout: [{ ...out(1), value: "1" }] } }),
      (a) => ({ ...a, tx: { ...a.tx, vin: [{ txid: PARENT }] } }),
      (a) => ({ ...a, known: { confirmed: "yes" } }),
      (a) => ({ tx: a.tx }),
    ];
    for (const f of bad) expect(readChecked(f(answer()))).toBeNull();
  });
});

function tx(change: Partial<Transaction> = {}): Transaction {
  const c = readChecked(answer());
  if (c === null) throw new Error("fixture");
  return { ...c.tx, ...change };
}

describe("warnings", () => {
  it("says nothing of an ordinary transaction", () => {
    expect(warnings(tx(), 2)).toStrictEqual({ rate: null, burn: 0, missing: 0, unchecked: 0 });
  });

  it("warns of a rate ten times the next block's, never below the floor", () => {
    // 96 vB: 100,000 sats is about 1,042 sat/vB.
    const dear = tx({ fee: 100_000 });
    expect(warnings(dear, 2).rate).toBeCloseTo(1041.67, 1);
    expect(warnings(dear, 200).rate).toBeNull();
    // Without the next block's rate, only past a thousand.
    expect(warnings(dear, undefined).rate).not.toBeNull();
    expect(warnings(tx({ fee: 9_000 }), 1).rate).toBeNull();
    expect(warnings(tx({ fee: 10_000 }), 1).rate).not.toBeNull();
  });

  it("counts burned sats, missing inputs and inputs not looked up", () => {
    const t = tx();
    const burn = tx({ vout: [...t.vout, out(546, "op_return")] });
    expect(warnings(burn, 1).burn).toBe(546);
    const vin = t.vin ?? [];
    const first = vin[0];
    if (first === undefined) throw new Error("fixture");
    const odd = tx({
      vin: [
        { ...first, prevout: null },
        { txid: PARENT, vout: 1, is_coinbase: false },
      ],
    });
    expect(warnings(odd, 1)).toMatchObject({ missing: 1, unchecked: 1 });
  });
});

describe("refusal", () => {
  it("names the node's reason and what to do", () => {
    expect(refusal(new ApiError(400, "Min relay fee."))).toBe(
      "The node refused it: min relay fee.",
    );
    expect(refusal(new ApiError(429, "Too many requests.", 10))).toBe(
      "Too many broadcasts from here. Wait 10 seconds and try again.",
    );
    expect(refusal(new ApiError(403, "Broadcast is disabled on this server."))).toBe(
      "This server does not broadcast.",
    );
    expect(refusal(new Error("x"))).toBe("It could not be sent.");
  });
});
