import { describe, expect, it } from "vitest";
import {
  btcParts,
  FEE_BOUNDS,
  feeBand,
  feeColor,
  feeRate,
  formatBtc,
  formatBtcScale,
  formatFeeRate,
  formatFeeRateUp,
  formatInterval,
  formatPowerOfTen,
  formatRelative,
  formatSats,
  formatSize,
  timedBefore,
  formatUtc,
  groupDigits,
  hashGroups,
  isoTime,
  MISSING,
  NNBSP,
  plainBtc,
  truncateMiddle,
  vsizeFromWeight,
} from "./format";

// Spaces in expectations are written as "_" so the narrow no-break space is visible.
const s = (text: string) => text.replaceAll("_", NNBSP);

describe("groupDigits", () => {
  it("groups in threes with a narrow no-break space", () => {
    expect(groupDigits(0)).toBe("0");
    expect(groupDigits(999)).toBe("999");
    expect(groupDigits(1000)).toBe(s("1_000"));
    expect(groupDigits(975411)).toBe(s("975_411"));
    expect(groupDigits(2_100_000_000_000_000)).toBe(s("2_100_000_000_000_000"));
  });

  it("uses a real minus sign and rounds", () => {
    expect(groupDigits(-1234)).toBe(s("−1_234"));
    expect(groupDigits(1234.6)).toBe(s("1_235"));
  });

  it("never prints NaN or Infinity", () => {
    expect(groupDigits(Number.NaN)).toBe(MISSING);
    expect(groupDigits(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });
});

describe("formatPowerOfTen", () => {
  it("writes a number by its power of ten, joined so it never wraps", () => {
    expect(formatPowerOfTen(4.6565423739069247e-10, 5)).toBe(s("4.6565_×_10⁻¹⁰"));
    expect(formatPowerOfTen(4.6565423739069247e-10)).toBe(s("4.66_×_10⁻¹⁰"));
    expect(formatPowerOfTen(1e30)).toBe(s("1_×_10³⁰"));
    expect(formatPowerOfTen(-2.5e-7, 2)).toBe(s("−2.5_×_10⁻⁷"));
    expect(formatPowerOfTen(123_456)).toBe(s("1.23_×_10⁵"));
  });

  it("never prints NaN, Infinity or a power of zero", () => {
    expect(formatPowerOfTen(Number.NaN)).toBe(MISSING);
    expect(formatPowerOfTen(Number.NEGATIVE_INFINITY)).toBe(MISSING);
    expect(formatPowerOfTen(0)).toBe(MISSING);
  });
});

describe("BTC and sats", () => {
  it("always shows eight decimals, grouped 2 + 3 + 3", () => {
    expect(formatBtc(0)).toBe(s("0.00_000_000"));
    expect(formatBtc(1)).toBe(s("0.00_000_001"));
    expect(formatBtc(12_500)).toBe(s("0.00_012_500"));
    expect(formatBtc(3_500_000)).toBe(s("0.03_500_000"));
    expect(formatBtc(100_000_000)).toBe(s("1.00_000_000"));
    expect(formatBtc(123_456_789_012)).toBe(s("1_234.56_789_012"));
    expect(formatBtc(2_100_000_000_000_000)).toBe(s("21_000_000.00_000_000"));
  });

  it("puts the sign before the whole amount", () => {
    expect(formatBtc(-1)).toBe(s("−0.00_000_001"));
    expect(formatBtc(-2_100_000_000_000_000)).toBe(s("−21_000_000.00_000_000"));
  });

  it("has no floating-point error where floats would have one", () => {
    // 0.1 + 0.2 in BTC, and amounts whose float division is inexact.
    expect(formatBtc(10_000_000 + 20_000_000)).toBe(s("0.30_000_000"));
    expect(formatBtc(29_999_999)).toBe(s("0.29_999_999"));
    expect(formatBtc(123_456_789_012_345)).toBe(s("1_234_567.89_012_345"));
    expect(formatBtc(Number.MAX_SAFE_INTEGER)).toBe(s("90_071_992.54_740_991"));
  });

  it("splits trailing zeros off, group spaces and all, so they can be dimmed", () => {
    expect(btcParts(0)).toStrictEqual({
      sign: "",
      whole: "0",
      significant: "",
      zeros: s("00_000_000"),
    });
    expect(btcParts(1)).toStrictEqual({
      sign: "",
      whole: "0",
      significant: s("00_000_001"),
      zeros: "",
    });
    expect(btcParts(3_500_000)).toStrictEqual({
      sign: "",
      whole: "0",
      significant: s("03_5"),
      zeros: s("00_000"),
    });
    // The zeros start at a group's edge: its space goes with them.
    expect(btcParts(12_000_000)).toStrictEqual({
      sign: "",
      whole: "0",
      significant: "12",
      zeros: s("_000_000"),
    });
    expect(btcParts(100_000_000)).toStrictEqual({
      sign: "",
      whole: "1",
      significant: "",
      zeros: s("00_000_000"),
    });
    expect(btcParts(2_100_000_000_000_000)).toStrictEqual({
      sign: "",
      whole: s("21_000_000"),
      significant: "",
      zeros: s("00_000_000"),
    });
    expect(btcParts(-12_345)).toStrictEqual({
      sign: "−",
      whole: "0",
      significant: s("00_012_345"),
      zeros: "",
    });
  });

  it("writes a chart's scale with only the decimals it needs", () => {
    expect(formatBtcScale(0)).toBe("0");
    expect(formatBtcScale(2_500_000)).toBe("0.025");
    expect(formatBtcScale(-50_000_000)).toBe("−0.5");
    expect(formatBtcScale(120_000_000_000)).toBe(s("1_200"));
    expect(formatBtcScale(0.5)).toBe(MISSING);
  });

  it("refuses anything that is not a safe integer", () => {
    for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(btcParts(bad)).toBeNull();
      expect(formatBtc(bad)).toBe(MISSING);
      expect(formatSats(bad)).toBe(MISSING);
    }
  });

  it("groups sats", () => {
    expect(formatSats(167)).toBe("167");
    expect(formatSats(1_250_000)).toBe(s("1_250_000"));
  });
});

describe("formatFeeRateUp", () => {
  it("prints as a fee rate prints, rounding up, never down", () => {
    expect(formatFeeRateUp(0.1)).toBe("0.10");
    expect(formatFeeRateUp(0.101)).toBe("0.11");
    expect(formatFeeRateUp(0.133)).toBe("0.14");
    expect(formatFeeRateUp(1.001)).toBe("1.01");
    expect(formatFeeRateUp(9.991)).toBe("10.0");
    expect(formatFeeRateUp(12.501)).toBe("12.6");
    expect(formatFeeRateUp(99.95)).toBe("100");
    expect(formatFeeRateUp(150.2)).toBe("151");
    expect(formatFeeRateUp(Number.NaN)).toBe(MISSING);
  });

  it("bands a rate as it prints, when asked to", () => {
    expect(feeBand(0.199)).toBe(4);
    expect(feeBand(0.191, formatFeeRateUp)).toBe(4);
    expect(feeBand(0.181, formatFeeRateUp)).toBe(3);
    expect(feeColor(0.2, formatFeeRateUp)).toBe("var(--fee-4)");
  });
});

describe("formatFeeRate", () => {
  it("prints two decimals under 10, one under 100, none above", () => {
    expect(formatFeeRate(0)).toBe("0.00");
    expect(formatFeeRate(0.1)).toBe("0.10");
    expect(formatFeeRate(0.8)).toBe("0.80");
    expect(formatFeeRate(4)).toBe("4.00");
    expect(formatFeeRate(12.345)).toBe("12.3");
    expect(formatFeeRate(99.94)).toBe("99.9");
    expect(formatFeeRate(250.4)).toBe("250");
    expect(formatFeeRate(1234)).toBe(s("1_234"));
  });

  it("keeps sub-sat resolution", () => {
    expect(formatFeeRate(0.123)).toBe("0.12");
    expect(formatFeeRate(0.125)).toBe("0.13");
    expect(formatFeeRate(0.1996)).toBe("0.20");
    expect(formatFeeRate(141 / 1000)).toBe("0.14");
  });

  it("rounds halves up even when the float is just below the half", () => {
    // 1.005 is stored as 1.00499999999999989…
    expect(formatFeeRate(1.005)).toBe("1.01");
    expect(formatFeeRate(201 / 200)).toBe("1.01");
    expect(formatFeeRate(0.285)).toBe("0.29");
    expect(formatFeeRate(10.05)).toBe("10.1");
  });

  it("chooses the precision from the rounded value", () => {
    expect(formatFeeRate(9.994)).toBe("9.99");
    expect(formatFeeRate(9.995)).toBe("10.0");
    expect(formatFeeRate(99.95)).toBe("100");
  });

  it("never prints NaN, Infinity or a negative rate", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatFeeRate(bad)).toBe(MISSING);
    }
  });

  it("computes a rate from fee and size", () => {
    expect(feeRate(141, 141)).toBe(1);
    expect(feeRate(100, 0)).toBeNull();
    expect(feeRate(Number.NaN, 10)).toBeNull();
    expect(vsizeFromWeight(561)).toBe(141);
    expect(vsizeFromWeight(564)).toBe(141);
  });
});

describe("feeBand", () => {
  it("puts each lower bound in its own band", () => {
    expect(feeBand(0.1)).toBe(1);
    FEE_BOUNDS.forEach((bound, i) => {
      expect(feeBand(bound)).toBe(i + 2);
    });
    expect(feeBand(1000)).toBe(12);
  });

  it("puts values just under a bound in the band below", () => {
    expect(feeBand(0.11)).toBe(1);
    expect(feeBand(0.14)).toBe(2);
    expect(feeBand(0.19)).toBe(3);
    expect(feeBand(0.99)).toBe(6);
    expect(feeBand(9.99)).toBe(11);
  });

  it("bands the rate as printed, so the color never disagrees with the number", () => {
    // 0.1996 prints as 0.20, so it is band 4 although the raw value is below 0.2.
    expect(feeBand(0.1996)).toBe(4);
    expect(feeBand(0.1949)).toBe(3);
    // 0.1196 prints as 0.12: the 0.12 to 0.15 band, as the server bands it.
    expect(feeBand(0.1196)).toBe(2);
    expect(feeBand(0.1149)).toBe(1);
    expect(feeBand(0.995)).toBe(7);
    expect(feeBand(9.996)).toBe(12);
    expect(feeColor(0.1996)).toBe("var(--fee-4)");
  });

  it("puts nonsense in the first band instead of failing", () => {
    expect(feeBand(Number.NaN)).toBe(1);
  });
});

describe("formatSize", () => {
  it("uses grouped vB under ten thousand", () => {
    expect(formatSize(209)).toBe("209 vB");
    expect(formatSize(9999)).toBe(s("9_999 vB"));
  });

  it("uses kvB and MvB with two decimals above", () => {
    expect(formatSize(10_000)).toBe("10.00 kvB");
    expect(formatSize(14_620_000)).toBe("14.62 MvB");
    expect(formatSize(998_765)).toBe("998.77 kvB");
  });

  it("moves up a unit when rounding reaches the next one", () => {
    expect(formatSize(9999.6)).toBe("10.00 kvB");
    expect(formatSize(999_995)).toBe("1.00 MvB");
  });

  it("takes other units", () => {
    expect(formatSize(3_993_000, "WU")).toBe("3.99 MWU");
    expect(formatSize(285, "B")).toBe("285 B");
    expect(formatSize(-1)).toBe(MISSING);
  });
});

describe("hashes", () => {
  const txid = "65428488a6202f1d681d053b3ff5d8ea9f5b0e5e1e0dcf7bf2e4c1e5a3f9c2e1";

  it("truncates in the middle", () => {
    expect(truncateMiddle(txid)).toBe("65428488…a3f9c2e1");
    expect(truncateMiddle("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", 7, 5)).toBe(
      "bc1qxy2…x0wlh",
    );
  });

  it("leaves short values whole", () => {
    expect(truncateMiddle("abcdef")).toBe("abcdef");
    expect(truncateMiddle("a".repeat(17))).toBe("a".repeat(17));
    expect(truncateMiddle("a".repeat(18))).toBe("aaaaaaaa…aaaaaaaa");
  });

  it("groups by eight", () => {
    const groups = hashGroups(txid);
    expect(groups).toHaveLength(8);
    expect(groups[0]).toBe("65428488");
    expect(groups.join("")).toBe(txid);
    expect(hashGroups("abcdefghij")).toStrictEqual(["abcdefgh", "ij"]);
    expect(hashGroups("")).toStrictEqual([]);
  });
});

describe("time", () => {
  const t = 1_794_429_667; // 2026-11-11 20:41:07 UTC

  it("formats absolute UTC", () => {
    expect(formatUtc(t)).toBe("11 Nov 2026, 20:41:07 UTC");
    // The clipboard's BTC: no grouping space, no unit, every decimal.
    expect(plainBtc(595_438_071_385)).toBe("5954.38071385");
    expect(plainBtc(-2_099_999_997_690_000)).toBe("-20999999.97690000");
    expect(plainBtc(1)).toBe("0.00000001");
    expect(formatUtc(t, false)).toBe("11 Nov 2026, 20:41 UTC");
    expect(isoTime(t)).toBe("2026-11-11T20:41:07.000Z");
    expect(formatUtc(Number.NaN)).toBe(MISSING);
    expect(isoTime(Number.NaN)).toBeUndefined();
  });

  it("formats relative time at each step", () => {
    expect(formatRelative(t, t)).toBe("just now");
    expect(formatRelative(t, t + 9)).toBe("just now");
    expect(formatRelative(t, t + 10)).toBe("10 s ago");
    expect(formatRelative(t, t + 59)).toBe("59 s ago");
    expect(formatRelative(t, t + 60)).toBe("1 min ago");
    expect(formatRelative(t, t + 13 * 60 + 59)).toBe("13 min ago");
    expect(formatRelative(t, t + 3600)).toBe("1 h ago");
    expect(formatRelative(t, t + 2 * 3600 + 5 * 60)).toBe("2 h 5 min ago");
    expect(formatRelative(t, t + 23 * 3600 + 59 * 60)).toBe("23 h 59 min ago");
    // From a day on, days lead, never "47 h 54 min".
    expect(formatRelative(t, t + 24 * 3600 + 23 * 60)).toBe("1 day ago");
    expect(formatRelative(t, t + 47 * 3600 + 54 * 60)).toBe("1 day 23 h ago");
    expect(formatRelative(t, t + 48 * 3600)).toBe("2 days ago");
    expect(formatRelative(t, t + 9 * 86_400 + 5 * 3600)).toBe("9 days ago");
    expect(formatRelative(t, t + 1216 * 86_400)).toBe(`1${NNBSP}216 days ago`);
  });

  it("drops the suffix on request and never goes negative", () => {
    expect(formatRelative(t, t + 13 * 60, { suffix: false })).toBe("13 min");
    expect(formatRelative(t + 300, t)).toBe("just now");
    expect(formatRelative(Number.NaN, t)).toBe(MISSING);
  });
});

describe("formatInterval", () => {
  it("reads a block's time to mine to the second under an hour, then coarser", () => {
    expect(formatInterval(0)).toBe("0 s");
    expect(formatInterval(42)).toBe("42 s");
    expect(formatInterval(60)).toBe("1 min");
    expect(formatInterval(9 * 60 + 12)).toBe("9 min 12 s");
    expect(formatInterval(3600)).toBe("1 h");
    expect(formatInterval(2 * 3600 + 5 * 60 + 40)).toBe("2 h 5 min");
    expect(formatInterval(27 * 3600)).toBe("1 day 3 h");
    expect(formatInterval(2 * 86_400)).toBe("2 days");
  });

  it("keeps the sign of a block timed before its parent", () => {
    expect(formatInterval(-125)).toBe("−2 min 5 s");
    expect(formatInterval(-3)).toBe("−3 s");
  });

  it("marks what is not a number", () => {
    expect(formatInterval(Number.NaN)).toBe(MISSING);
  });
});

describe("timedBefore", () => {
  it("says how far before which block, as a positive time", () => {
    expect(timedBefore(-68, 976_214)).toBe(s("Timed 1 min 8 s before block 976_214"));
  });
});
