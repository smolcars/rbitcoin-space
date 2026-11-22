import { describe, expect, it } from "vitest";
import { BENCH, budget } from "./budget";
import {
  census,
  formatShare,
  KINDS,
  type Kind,
  matcher,
  NO_PICK,
  pickName,
  readPick,
  resultLine,
  toggled,
} from "./goggles";
import { has, readFlags, words } from "./flags";

const bit = (b: number) => 2 ** b;
const byKey = (key: string): Kind => {
  const k = KINDS.find((x) => x.key === key);
  if (!k) throw new Error(key);
  return k;
};
const TAPROOT = byKey("taproot");
const INSCRIPTION = byKey("inscription");
const OP_RETURN = byKey("op-return");
const ACP = byKey("acp");
const at = (key: string) => KINDS.indexOf(byKey(key));

describe("bits", () => {
  it("splits a field into its 32-bit words exactly, up to 2^53", () => {
    expect(words(0)).toStrictEqual([0, 0]);
    expect(words(bit(31))).toStrictEqual([bit(31), 0]);
    expect(words(bit(32) + 5)).toStrictEqual([5, 1]);
    expect(words(Number.MAX_SAFE_INTEGER)).toStrictEqual([2 ** 32 - 1, 2 ** 21 - 1]);
  });

  it("tests every bit on either side of the split, alone and among others", () => {
    for (const b of [0, 1, 14, 30, 31, 32, 33, 40, 44, 52]) {
      expect(has(bit(b), b)).toBe(true);
      expect(has(Number.MAX_SAFE_INTEGER - bit(b), b)).toBe(false);
      expect(has(Number.MAX_SAFE_INTEGER, b)).toBe(true);
      expect(has(0, b)).toBe(false);
    }
    // A low bit is not read in the high word, nor the other way round.
    expect(has(bit(1), 33)).toBe(false);
    expect(has(bit(33), 1)).toBe(false);
  });

  it("reads a u64 field, dropping the bits a number cannot hold", () => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, 2n ** 44n + 2n ** 31n + 1n, true);
    expect(readFlags(view, 0)).toBe(bit(44) + bit(31) + 1);
    view.setBigUint64(0, 2n ** 63n + 2n ** 53n + 2n ** 52n + 2n ** 14n, true);
    expect(readFlags(view, 0)).toBe(bit(52) + bit(14));
  });

  it("names every bit the server sets once, and nothing it does not", () => {
    const bits = new Set(KINDS.map((k) => k.bit));
    expect(bits.size).toBe(KINDS.length);
    expect(bits).toStrictEqual(
      new Set([
        0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 24, 25, 26, 33, 34, 40, 41, 42, 43, 44,
      ]),
    );
    expect(new Set(KINDS.map((k) => k.key)).size).toBe(KINDS.length);
    expect(KINDS.slice(0, 5).every((k) => k.group === "Common")).toBe(true);
  });
});

describe("matcher", () => {
  it("matches nothing picked as undefined: everything stays lit", () => {
    expect(matcher(NO_PICK)).toBeUndefined();
  });

  it("matches any or all of the picked kinds, across both words", () => {
    const flags = bit(TAPROOT.bit) + bit(ACP.bit);
    const any = matcher({ kinds: [INSCRIPTION, ACP], mode: "any" });
    const all = matcher({ kinds: [INSCRIPTION, ACP], mode: "all" });
    expect(any?.(flags)).toBe(true);
    expect(all?.(flags)).toBe(false);
    expect(all?.(flags + bit(INSCRIPTION.bit))).toBe(true);
    expect(matcher({ kinds: [TAPROOT, ACP], mode: "all" })?.(flags)).toBe(true);
    expect(any?.(bit(TAPROOT.bit))).toBe(false);
    expect(any?.(0)).toBe(false);
  });

  it("agrees with the bit test for every kind", () => {
    const flags = bit(0) + bit(3) + bit(14) + bit(31) + bit(40) + bit(44);
    for (const k of KINDS) {
      expect(matcher({ kinds: [k], mode: "any" })?.(flags)).toBe(has(flags, k.bit));
      expect(matcher({ kinds: [k], mode: "all" })?.(flags)).toBe(has(flags, k.bit));
    }
  });
});

describe("census", () => {
  const txs = [
    { vsize: 100, flags: bit(TAPROOT.bit) + bit(INSCRIPTION.bit) },
    { vsize: 200, flags: bit(TAPROOT.bit) },
    { vsize: 300, flags: bit(OP_RETURN.bit) },
    { vsize: 400 }, // a record without flags carries none
  ];

  it("counts every kind and its virtual size, and lights nothing without a pick", () => {
    const c = census(txs, NO_PICK);
    expect([c.count, c.size]).toStrictEqual([4, 1000]);
    expect(c.counts[at("taproot")]).toBe(2);
    expect(c.sizes[at("taproot")]).toBe(300);
    expect(c.counts[at("inscription")]).toBe(1);
    expect(c.counts[at("consolidation")]).toBe(0);
    expect(c.lit).toBeUndefined();
    expect(c.withPick).toBeUndefined();
    expect(resultLine(c)).toBe("4 transactions");
  });

  it("lights any of the pick, with no clashes to count", () => {
    const c = census(txs, { kinds: [INSCRIPTION, OP_RETURN], mode: "any" });
    expect(c.lit).toStrictEqual({ count: 2, size: 400 });
    expect(c.withPick).toBeUndefined();
    expect(resultLine(c)).toBe("2 of 4 · 40% of the block");
  });

  it("in all mode, counts what each kind would leave lit, so a dead end shows before it is picked", () => {
    const c = census(txs, { kinds: [TAPROOT], mode: "all" });
    expect(c.lit).toStrictEqual({ count: 2, size: 300 });
    expect(c.withPick?.[at("inscription")]).toBe(1);
    expect(c.withPick?.[at("op-return")]).toBe(0);
    expect(c.withPick?.[at("taproot")]).toBe(2);
    const none = census(txs, { kinds: [TAPROOT, OP_RETURN], mode: "all" });
    expect(none.lit).toStrictEqual({ count: 0, size: 0 });
    expect(resultLine(none)).toBe("None of 4");
  });

  it("reads an empty block", () => {
    const c = census([], { kinds: [TAPROOT], mode: "any" });
    expect(resultLine(c)).toBe("None of 0");
    expect(resultLine(census([], NO_PICK))).toBe("0 transactions");
  });

  // A speed budget (lib/budget.ts), on request: `BENCH=1 bunx vitest run src/lib/goggles.test.ts`.
  it.skipIf(!BENCH)("counts a full block in a few milliseconds", () => {
    const big = Array.from({ length: 16_000 }, (_, i) => ({
      vsize: 100 + (i % 300),
      flags: (i * 2_654_435_761) % 2 ** 45,
    }));
    const pick = { kinds: [TAPROOT, ACP], mode: "all" } as const;
    const once = census(big, pick);
    // Ten counts, about 1 ms each on a laptop.
    const counts = budget(250, () => Array.from({ length: 10 }, () => census(big, pick)));
    expect(counts.every((c) => c.count === 16_000 && c.lit?.count === once.lit?.count)).toBe(true);
  });
});

describe("words", () => {
  it("prints shares as the chips do", () => {
    expect(formatShare(0)).toBe("0");
    expect(formatShare(0.0001)).toBe("<0.1%");
    expect(formatShare(0.0021)).toBe("0.2%");
    expect(formatShare(0.07)).toBe("7%");
    expect(formatShare(0.0994)).toBe("9.9%");
    expect(formatShare(0.0996)).toBe("10%");
    expect(formatShare(0.996)).toBe("99%");
    expect(formatShare(1)).toBe("100%");
  });

  it("names a pick by its kinds, a signature hash with its group", () => {
    expect(pickName({ kinds: [TAPROOT, INSCRIPTION], mode: "any" })).toBe("Taproot or Inscription");
    expect(pickName({ kinds: [TAPROOT, ACP], mode: "all" })).toBe(
      "Taproot and SIGHASH_ANYONECANPAY",
    );
  });

  it("toggles a kind in and out, in the order picked", () => {
    const one = toggled(NO_PICK, TAPROOT);
    const two = toggled(one, ACP);
    expect(two.kinds).toStrictEqual([TAPROOT, ACP]);
    expect(toggled(two, TAPROOT).kinds).toStrictEqual([ACP]);
  });
});

describe("readPick", () => {
  it("reads a stored pick, keeping only kinds it knows, once each", () => {
    expect(readPick('{"kinds":["taproot","nope","taproot","acp"],"mode":"all"}')).toStrictEqual({
      kinds: [TAPROOT, ACP],
      mode: "all",
    });
  });

  it("reads anything unexpected as nothing picked", () => {
    for (const s of [null, "", "{", "3", "[]", '{"kinds":"taproot"}', '{"mode":"some"}']) {
      const p = readPick(s);
      expect(p.kinds).toStrictEqual([]);
      expect(p.mode).toBe("any");
    }
  });
});
