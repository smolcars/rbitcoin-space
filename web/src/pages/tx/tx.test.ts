import { describe, expect, it } from "vitest";
import type { Transaction, Vin } from "../../lib/esplora";
import { NNBSP } from "../../lib/format";
import {
  coinbaseHeight,
  confirmations,
  cssMs,
  FIRST_SHOWN,
  features,
  formatSequence,
  isTxid,
  lockTimeMeaning,
  MORE_STEP,
  sequenceMeaning,
  shownCount,
  totalIn,
  whyUnspendable,
} from "./tx";

const vin = (sequence: number, extra: Partial<Vin> = {}): Vin => ({
  txid: "00".repeat(32),
  vout: 0,
  is_coinbase: false,
  sequence,
  ...extra,
});

describe("display bound", () => {
  it("shows ten, then a hundred more per press, never past the total", () => {
    expect(FIRST_SHOWN).toBe(10);
    expect(MORE_STEP).toBe(100);
    expect(shownCount(3, 0)).toBe(3);
    expect(shownCount(1501, 0)).toBe(10);
    expect(shownCount(1501, 1)).toBe(110);
    expect(shownCount(1501, 15)).toBe(1501);
    expect(shownCount(1501, 99)).toBe(1501);
  });
});

describe("lock time", () => {
  it("reads zero, heights and times", () => {
    expect(lockTimeMeaning(0, [vin(0xfffffffd)])).toStrictEqual({
      value: "None",
      detail: "Could be mined in any block.",
    });
    expect(lockTimeMeaning(975_515, [vin(0xfffffffd)])).toStrictEqual({
      value: `Block 975${NNBSP}515`,
      detail: `Could not be mined before block 975${NNBSP}516.`,
    });
    expect(lockTimeMeaning(499_999_999, [vin(0)]).value).toBe(`Block 499${NNBSP}999${NNBSP}999`);
    expect(lockTimeMeaning(1_794_453_849, [vin(0xfffffffe)])).toStrictEqual({
      value: "12 Nov 2026, 03:24:09 UTC",
      detail: "Could not be mined before this time, by the chain's median time.",
    });
  });

  it("is not enforced when every sequence is final", () => {
    expect(lockTimeMeaning(800_000, [vin(0xffffffff), vin(0xffffffff)]).detail).toBe(
      "Not enforced: every input's sequence is final.",
    );
    expect(lockTimeMeaning(800_000, [vin(0xffffffff), vin(0xfffffffe)]).detail).toMatch(
      /^Could not/,
    );
  });
});

describe("sequence", () => {
  it("reads final, lock-time and relative-lock sequences", () => {
    expect(sequenceMeaning(0xffffffff, 2)).toBe("Final: this input does not enable the lock time.");
    expect(sequenceMeaning(0xfffffffe, 2)).toBe("Enables the lock time; no relative lock.");
    expect(sequenceMeaning(0xfffffffd, 2)).toBe("Enables the lock time; no relative lock.");
    expect(sequenceMeaning(144, 2)).toBe(
      "Relative lock: 144 blocks after the spent output confirmed.",
    );
    expect(sequenceMeaning(1, 2)).toBe("Relative lock: 1 block after the spent output confirmed.");
    expect(sequenceMeaning(0, 2)).toBe("No relative lock; enables the lock time.");
    // Type flag set: units of 512 seconds. 169 × 512 s = 1 d 0 h 2 min.
    expect(sequenceMeaning(0x400000 | 169, 2)).toBe(
      "Relative lock: 1 d 2 min after the spent output confirmed.",
    );
    expect(sequenceMeaning(0x400000 | 7, 2)).toBe(
      "Relative lock: 1 h after the spent output confirmed.",
    );
    // Version 1 has no relative locks.
    expect(sequenceMeaning(144, 1)).toBe("Enables the lock time; no relative lock.");
  });

  it("prints as eight hex digits", () => {
    expect(formatSequence(0xfffffffd)).toBe("0xfffffffd");
    expect(formatSequence(144)).toBe("0x00000090");
  });
});

const tx = (vins: Vin[]): Transaction => ({
  txid: "ab".repeat(32),
  version: 2,
  locktime: 0,
  vin: vins,
  vout: [{ scriptpubkey: "", scriptpubkey_asm: "", scriptpubkey_type: "unknown", value: 500 }],
  status: { confirmed: false },
});
const prevout = (type: "v1_p2tr" | "v0_p2wpkh", value: number) => ({
  scriptpubkey: "",
  scriptpubkey_asm: "",
  scriptpubkey_type: type,
  value,
});

describe("transaction facts", () => {
  it("names the witness kinds", () => {
    expect(features(tx([vin(0)]))).toBe("Legacy, no witness");
    expect(features(tx([vin(0, { witness: ["aa"], prevout: prevout("v0_p2wpkh", 1) })]))).toBe(
      "SegWit",
    );
    expect(features(tx([vin(0, { witness: ["aa"], prevout: prevout("v1_p2tr", 1) })]))).toBe(
      "SegWit, Taproot",
    );
  });

  it("sums inputs, and a coinbase creates what it pays", () => {
    expect(totalIn(tx([vin(0, { prevout: prevout("v0_p2wpkh", 700) }), vin(0)]))).toBe(700);
    expect(totalIn(tx([vin(0, { is_coinbase: true })]))).toBe(500);
  });

  it("counts confirmations", () => {
    expect(confirmations(100, 100)).toBe(1);
    expect(confirmations(100, 105)).toBe(6);
    expect(confirmations(100, 99)).toBe(1); // tip read before the block arrived
    expect(confirmations(undefined, 100)).toBeUndefined();
  });

  it("reads the height a coinbase commits to", () => {
    expect(coinbaseHeight("039ce20e041331f56a", 975_516)).toBe(975_516);
    expect(coinbaseHeight("016e", 110)).toBe(110);
    expect(coinbaseHeight("039ce20e041331f56a", 975_517)).toBeUndefined();
    expect(coinbaseHeight("039ce20e041331f56a", undefined)).toBeUndefined();
    expect(coinbaseHeight("", 0)).toBeUndefined();
    expect(coinbaseHeight("09ffffffffffffffffff", 0)).toBeUndefined();
    expect(coinbaseHeight("03ab", 0)).toBeUndefined();
    // The genesis coinbase starts with its difficulty bits, 486 604 799 read as a number.
    expect(coinbaseHeight("04ffff001d0104", 0)).toBeUndefined();
  });

  it("accepts only 64 hex characters as a txid", () => {
    expect(isTxid("AB".repeat(32))).toBe(true);
    expect(isTxid("ab".repeat(31))).toBe(false);
    expect(isTxid(`0x${"ab".repeat(31)}`)).toBe(false);
    expect(isTxid(`${"ab".repeat(31)}zz`)).toBe(false);
  });
});

describe("cssMs", () => {
  it("reads duration tokens in seconds or milliseconds", () => {
    expect(cssMs("0.52s")).toBe(520);
    expect(cssMs(" 45ms")).toBe(45);
    expect(cssMs("0s")).toBe(0);
    expect(cssMs("")).toBe(0);
  });
});

describe("whyUnspendable", () => {
  const output = (scriptpubkey: string) => ({
    scriptpubkey,
    scriptpubkey_asm: "",
    scriptpubkey_type: "unknown" as const,
    value: 0,
  });
  const mined = (height: number, coinbase: boolean): Transaction => ({
    txid: "00".repeat(32),
    version: 1,
    locktime: 0,
    vin: [vin(0, { is_coinbase: coinbase })],
    vout: [],
    status: { confirmed: true, block_height: height },
  });

  it("names outputs no one can ever spend, and only those", () => {
    const p2pk = output(`41${"04".repeat(65)}ac`);
    expect(whyUnspendable(mined(0, true), p2pk)).toContain("genesis");
    expect(whyUnspendable(mined(1, true), p2pk)).toBeNull();
    expect(whyUnspendable(mined(0, false), p2pk)).toBeNull();
    expect(whyUnspendable(mined(5, false), output("6a"))).toContain("OP_RETURN");
    expect(whyUnspendable(mined(5, false), output("51".repeat(10_001)))).toContain("longer");
    expect(whyUnspendable(mined(5, false), output("51".repeat(10_000)))).toBeNull();
  });
});
