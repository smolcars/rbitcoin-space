import { describe, expect, it } from "vitest";
import type { Transaction } from "../../lib/esplora";
import {
  blockReward,
  coinbaseTag,
  formatDifficulty,
  fullness,
  HALVING_INTERVAL,
  hex32,
  parseBlockId,
  subsidy,
} from "./chain";

// Coinbases recorded from mainnet, each with how it reads (fixtures/coinbase).
const coinbases = Object.values(
  import.meta.glob<{ blocks: { height: number; scriptsig: string; reads: string }[] }>(
    "../../../../fixtures/coinbase/mainnet.json",
    { eager: true, import: "default" },
  ),
)[0] ?? { blocks: [] };

const MAIN = HALVING_INTERVAL.mainnet;
const tagText = (t: ReturnType<typeof coinbaseTag>) =>
  t?.parts.map((p) => ("text" in p ? p.text : "·".repeat(p.hidden))).join("");

describe("subsidy", () => {
  it("halves every interval", () => {
    expect(subsidy(0, MAIN)).toBe(5_000_000_000);
    expect(subsidy(209_999, MAIN)).toBe(5_000_000_000);
    expect(subsidy(210_000, MAIN)).toBe(2_500_000_000);
    expect(subsidy(840_000, MAIN)).toBe(312_500_000);
    expect(subsidy(975_411, MAIN)).toBe(312_500_000);
    expect(subsidy(1_050_000, MAIN)).toBe(156_250_000);
  });

  it("rounds down in the late eras and stops", () => {
    expect(subsidy(210_000 * 32, MAIN)).toBe(1); // 5e9 / 2^32 = 1.16
    expect(subsidy(210_000 * 33 - 1, MAIN)).toBe(1);
    expect(subsidy(210_000 * 33, MAIN)).toBe(0);
    expect(subsidy(210_000 * 64, MAIN)).toBe(0);
    expect(subsidy(210_000 * 100, MAIN)).toBe(0);
  });

  it("uses each network's interval", () => {
    expect(HALVING_INTERVAL.signet).toBe(210_000);
    expect(HALVING_INTERVAL.testnet4).toBe(210_000);
    expect(HALVING_INTERVAL.testnet5).toBe(210_000);
    expect(subsidy(149, HALVING_INTERVAL.regtest)).toBe(5_000_000_000);
    expect(subsidy(150, HALVING_INTERVAL.regtest)).toBe(2_500_000_000);
    expect(subsidy(301, HALVING_INTERVAL.regtest)).toBe(1_250_000_000);
    expect(subsidy(150 * 64, HALVING_INTERVAL.regtest)).toBe(0);
  });

  it("is zero for nonsense", () => {
    expect(subsidy(-1, MAIN)).toBe(0);
    expect(subsidy(1.5, MAIN)).toBe(0);
    expect(subsidy(Number.NaN, MAIN)).toBe(0);
  });
});

const coinbase = (values: number[], scriptsig = "03"): Transaction => ({
  txid: "00".repeat(32),
  version: 1,
  locktime: 0,
  vin: [{ txid: "00".repeat(32), vout: 0xffffffff, is_coinbase: true, scriptsig }],
  vout: values.map((value) => ({
    value,
    scriptpubkey: "",
    scriptpubkey_asm: "",
    scriptpubkey_type: "p2pkh",
  })),
  status: { confirmed: true },
});

describe("blockReward", () => {
  it("sums every output, beside the subsidy the block could claim", () => {
    expect(blockReward(coinbase([312_000_000, 2_059_121, 0]), 975_516, MAIN)).toStrictEqual({
      reward: 314_059_121,
      subsidy: 312_500_000,
    });
  });

  it("keeps a reward below the subsidy as claimed", () => {
    expect(blockReward(coinbase([100]), 975_516, MAIN)).toStrictEqual({
      reward: 100,
      subsidy: 312_500_000,
    });
  });

  it("refuses transactions that are not a coinbase or carry broken amounts", () => {
    const tx = coinbase([1]);
    const notCoinbase = { txid: tx.txid, vout: 0, is_coinbase: false };
    expect(blockReward({ ...tx, vin: [notCoinbase] }, 1, MAIN)).toBeNull();
    expect(blockReward(undefined, 1, MAIN)).toBeNull();
    expect(blockReward(coinbase([0.5]), 1, MAIN)).toBeNull();
  });
});

describe("fullness", () => {
  it("is the share of the weight limit", () => {
    expect(fullness(3_994_821)).toBeCloseTo(0.9987, 4);
    expect(fullness(1140)).toBeCloseTo(0.000285, 6);
    expect(fullness(4_000_000)).toBe(1);
    expect(fullness(9_000_000)).toBe(1);
    expect(fullness(-1)).toBe(0);
    expect(fullness(Number.NaN)).toBe(0);
  });
});

describe("parseBlockId", () => {
  const hash = "000000000019D6689C085AE165831E934FF763AE46A2A6C172B3F1B60A8CE26F";
  it("reads hashes and heights", () => {
    expect(parseBlockId(hash)).toStrictEqual({ kind: "hash", hash: hash.toLowerCase() });
    expect(parseBlockId("0")).toStrictEqual({ kind: "height", height: 0 });
    expect(parseBlockId("4294967295")).toStrictEqual({ kind: "height", height: 4_294_967_295 });
  });

  it("rejects everything else", () => {
    for (const bad of [
      "",
      "4294967296",
      "-1",
      "1.5",
      "1e3",
      " 12",
      `0x${hash.slice(2)}`,
      hash.slice(1),
      "abc",
    ])
      expect(parseBlockId(bad)).toBeNull();
  });
});

describe("coinbaseTag", () => {
  it("reads the genesis message alone", () => {
    const t = coinbaseTag(
      "04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73",
      0,
    );
    expect(t?.readable).toBe(true);
    expect(tagText(t)).toBe(
      "The Times 03/Jan/2009 Chancellor on brink of second bailout for banks",
    );
    expect(t?.words).toBe(true);
  });

  it("drops the BIP34 height and decodes UTF-8", () => {
    const t = coinbaseTag(
      "039ce20e041331f56a7c204d415241204d61646520696e2055534120f09f87baf09f87b8207c76303513dede437a0000000000ffffffff",
      975_516,
    );
    expect(tagText(t)).toBe("| MARA Made in USA 🇺🇸 |v05");
  });

  it("reads a signet tag", () => {
    expect(tagText(coinbaseTag("03e20a050a2f7369676e65743a332f", 330_466))).toBe("/signet:3/");
  });

  it("says when there is no text and keeps the hex", () => {
    const t = coinbaseTag("03f3730200b22731", 160_755);
    expect(t?.readable).toBe(false);
    expect(t?.hex).toBe("00b22731");
    expect(tagText(t)).toBe("·1");
    expect(t?.words).toBe(false);
  });

  it("drops a small height pushed as an opcode", () => {
    expect(coinbaseTag("5500", 5)?.hex).toBe("00");
  });

  it("makes hostile characters visible and never yields markup", () => {
    // "<b>" + RLO + NUL + ZWSP + "x" + invalid byte
    const t = coinbaseTag(`0f3c623ee280ae00e2808b78ff${"41".repeat(3)}`, 999_999);
    expect(tagText(t)).toBe("<b>···x·AAA");
    const texts = (t?.parts ?? []).map((p) => ("text" in p ? p.text : ""));
    expect(texts.join("")).not.toMatch(/[‮​\0]/);
  });

  it("reads each recorded block's coinbase as its words, or as today's form when it has none", () => {
    // 84 mainnet coinbases from 2009 to 2026: many pools, Chinese and emoji tags, merged mining.
    expect(coinbases.blocks.length).toBeGreaterThanOrEqual(30);
    for (const b of coinbases.blocks) {
      const t = coinbaseTag(b.scriptsig, b.height);
      expect([b.height, tagText(t)]).toStrictEqual([b.height, b.reads]);
      // Words are always shown, never replaced by hex.
      expect([b.height, t?.words === true && !t.readable]).toStrictEqual([b.height, false]);
    }
    const reads = (h: number) => coinbases.blocks.find((b) => b.height === h)?.reads;
    expect(reads(976_294)).toBe("Mined by Luxor");
    expect(reads(350_000)).toBe("七彩神仙鱼");
    expect(reads(976_280)).toBe("Sv2/MARA🇺🇸🇺🇸//");
    // Merged mining's "mm" never starts a word, and a stray letter after a tag in slashes is dropped.
    expect(reads(976_279)).toBe("/F2Pool/");
    // Text inside what would be a merged-mining root still reads.
    expect(reads(220_000)).toBe("Hi from 50BTC.com 6");
  });

  it("shows a tag of raw bytes, not pushes, as its words", () => {
    // F2Pool's tag written straight after the height, with no push before it.
    const t = coinbaseTag("03a7e50ee4b883e5bda9e7a59ee4bb99e9b1bc", 976_295);
    expect(t).toMatchObject({ readable: true, words: true, parts: [{ text: "七彩神仙鱼" }] });
  });

  it("rarely finds words in random bytes", () => {
    // xorshift32: the same bytes on every run.
    let x = 2_463_534_242;
    const byte = () => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x & 0xff;
    };
    const runs = 5000;
    let words = 0;
    for (let i = 0; i < runs; i++) {
      const tail = Array.from({ length: 20 }, () => byte().toString(16).padStart(2, "0")).join("");
      if (coinbaseTag(`03a7e50e${tail}`, 976_295)?.words === true) words++;
    }
    // About one run of 20 random bytes in 700 (an extranonce is 4 to 16).
    expect(words / runs).toBeLessThan(0.005);
  });

  it("keeps markup whole: brackets are dropped only as a lone stray mark", () => {
    const tag = (s: string) =>
      `03a7e50e${s.length.toString(16).padStart(2, "0")}${[...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    expect(tagText(coinbaseTag(tag("<img src=x onerror=alert(1)>"), 976_295))).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(tagText(coinbaseTag(tag("Mined by AntPool965>"), 976_295))).toBe("Mined by AntPool965");
  });

  it("bounds the length and survives broken input", () => {
    const long = coinbaseTag(`4cff${"41".repeat(400)}`, 999_999);
    expect(tagText(long)?.length).toBeLessThanOrEqual(100);
    expect(coinbaseTag("zz", 1)).toBeNull();
    expect(coinbaseTag("abc", 1)).toBeNull();
    expect(coinbaseTag(undefined, 1)).toBeNull();
    expect(coinbaseTag("4effffffff41", 999_999)?.parts).toStrictEqual([{ text: "A" }]);
  });
});

describe("header fields", () => {
  it("formats difficulty and hex fields", () => {
    expect(formatDifficulty(148_364_561_003_867.4).short).toBe("148.36 T");
    expect(formatDifficulty(1).short).toBe("1");
    expect(formatDifficulty(0.00123).short).toBe("0.00123");
    // Regtest's, and the largest a 256-bit target allows: a power of ten, never a long figure.
    expect(formatDifficulty(4.6565423739069247e-10)).toStrictEqual({
      short: "4.66\u202F×\u202F10⁻¹⁰",
      full: "4.65654\u202F×\u202F10⁻¹⁰",
    });
    expect(formatDifficulty(2 ** 224).short).toBe("2.7\u202F×\u202F10⁶⁷");
    expect(formatDifficulty(1.5e18).short).toBe("1.50 E");
    expect(hex32(386_000_300)).toBe("0x1701e5ac");
    expect(hex32(-1)).toBe("0xffffffff");
  });
});
