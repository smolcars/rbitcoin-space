import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { indexKey, labelOf, normalRef, showLabels, shownLabel } from "./labels";

/** Characters by code point, so no invisible one is written into this file. */
const cp = (...points: number[]) => String.fromCodePoint(...points);
const R = cp(0xff_fd);

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";

describe("normalRef", () => {
  it.each([
    ["tx", TXID.toUpperCase(), TXID],
    ["tx", "f91d", null],
    ["output", `${TXID.toUpperCase()}:007`, `${TXID}:7`],
    ["input", `${TXID}:x`, null],
    ["pubkey", `02${"AB".repeat(32)}`, `02${"ab".repeat(32)}`],
    [
      "addr",
      "BC1Q34AQ5DRPUWY3WGL9LHUP9892QP6SVR8LDZYY7C",
      "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c",
    ],
    // Mixed case is no bech32: kept as written, so it never matches the real address.
    [
      "addr",
      "bc1Q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c",
      "bc1Q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c",
    ],
    ["addr", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"],
    ["addr", "bc1q/../x", null],
    ["xpub", "xpub661My", "xpub661My"],
  ])("%s %s reads as %s", (type, ref, want) => {
    expect(normalRef(type, ref)).toBe(want);
  });
});

describe("labelOf", () => {
  it("finds a label by the reference as any page writes it", () => {
    showLabels(new Map([[indexKey("tx", TXID), "rent, March"]]));
    flush();
    expect(labelOf("tx", TXID)).toBe("rent, March");
    expect(labelOf("tx", TXID.toUpperCase())).toBe("rent, March");
    expect(labelOf("addr", TXID)).toBeUndefined();
    showLabels(new Map());
    flush();
    expect(labelOf("tx", TXID)).toBeUndefined();
  });
});

describe("shownLabel", () => {
  it("makes control, line-breaking and invisible characters visible as U+FFFD", () => {
    expect(shownLabel(`a${cp(0)}b${cp(0x1b)}[31mc${cp(0x7f)}`, 100)).toBe(`a${R}b${R}[31mc${R}`);
    expect(shownLabel(`one\ntwo${cp(0x20_28)}three${cp(0x20_29)}`, 100)).toBe(
      `one${R}two${R}three${R}`,
    );
  });

  it("disarms bidi overrides, isolates and marks, and zero-width characters", () => {
    // With a right-to-left override, "invoice", the override, "fdp.exe" reads as "invoiceexe.pdf".
    expect(shownLabel(`invoice${cp(0x20_2e)}fdp.exe`, 100)).toBe(`invoice${R}fdp.exe`);
    const hidden = [
      0x20_2a, 0x20_2b, 0x20_2c, 0x20_2d, 0x20_66, 0x20_67, 0x20_68, 0x20_69, 0x20_0e, 0x20_0f,
      0x06_1c, 0x20_0b, 0xfe_ff, 0x20_60,
    ];
    for (const c of hidden) expect(shownLabel(`a${cp(c)}b`, 10)).toBe(`a${R}b`);
  });

  it("keeps an emoji's joiner, and thins stacked combining marks", () => {
    const coder = cp(0x1_f4_69, 0x20_0d, 0x1_f4_bb);
    expect(shownLabel(`${coder} work`, 100)).toBe(`${coder} work`);
    expect(shownLabel(`Z${cp(0x03_01).repeat(40)}`, 100)).toBe(`Z${cp(0x03_01, 0x03_01)}`);
  });

  it("cuts a long label at whole characters, with an ellipsis", () => {
    expect(shownLabel("x".repeat(10_000), 40)).toBe(`${"x".repeat(40)}…`);
    expect(shownLabel("👍🏽".repeat(5), 3)).toBe("👍🏽👍🏽👍🏽…");
    expect(shownLabel("short", 40)).toBe("short");
  });

  it("leaves markup as the characters it is", () => {
    expect(shownLabel("<script>alert(1)</script>", 100)).toBe("<script>alert(1)</script>");
  });
});
