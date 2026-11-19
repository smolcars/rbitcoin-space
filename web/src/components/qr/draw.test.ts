import { describe, expect, it } from "vitest";
import { damage, encodeQr } from "../../lib/qr";
import {
  codeFor,
  contrast,
  findersPath,
  inkFor,
  markFor,
  MIN_CONTRAST,
  modulesPath,
  parseHex,
  QUIET,
} from "./draw";

const PUB = `02${"4d3c".repeat(16)}`;
const ONION = `${PUB}@abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwd.onion:9735`;
const IPV4 = `${PUB}@203.0.113.7:9735`;
const TAPROOT = "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";

describe("markFor", () => {
  it.each([
    ["a legacy address", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", 4, "logo"],
    ["a taproot address", TAPROOT, 6, "logo"],
    // Version 7 by length, made 8 for the crab's room.
    ["a connect string with an IPv4 host", IPV4, 8, "crab"],
    ["a connect string with a v3 onion", ONION, 10, "crab"],
    // The longest the node page shows: an address cut at 128 characters.
    ["the longest connect string", `${PUB}@${"a".repeat(128)}`, 12, "crab"],
  ])("leaves room for the logo in %s", (_, text, version, kind) => {
    const code = codeFor(text);
    expect(code?.version).toBe(version);
    const mark = code && markFor(code);
    expect(mark?.kind).toBe(kind);
    // No block pays more than half of what it can correct for.
    expect(code && mark ? damage(code, mark.hidden) : 1).toBeLessThanOrEqual(0.5);
  });

  it("keeps the middle alignment pattern, which the crab lifts", () => {
    const code = codeFor(ONION);
    const mark = code && markFor(code);
    if (!code || !mark) throw new Error("no mark");
    const m = (code.size - 1) / 2;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) expect(mark.hidden(m + dx, m + dy)).toBe(false);
    expect(mark.hidden(m - 6, m + 9)).toBe(true);
    expect(mark.hidden(m, m + 10)).toBe(false);
  });

  it("centres the whole logo on a code with no alignment pattern in its middle", () => {
    const code = codeFor(TAPROOT);
    const mark = code && markFor(code);
    if (!code || mark?.kind !== "logo") throw new Error("no logo");
    expect(mark.x * 2 + mark.size).toBe(code.size + 2 * QUIET);
  });

  it.each([21, 27, 35, 40])("puts nothing in a version %i code, past the cutoff", (v) => {
    const code = encodeQr("x", "Q", { minVersion: v });
    expect(code?.version).toBe(v);
    expect(code && markFor(code)).toBeNull();
  });

  it("puts nothing in a code with alignment patterns round its middle", () => {
    const code = encodeQr("x".repeat(250), "Q");
    expect(code?.version).toBe(14);
    expect(code && markFor(code)).toBeNull();
  });
});

describe("the shapes decoders need", () => {
  it("keeps finder rings nearly square and lone modules soft squares, not dots", () => {
    const code = codeFor(TAPROOT);
    if (!code) throw new Error("no code");
    // Ring corners a tenth of a module, the pupil 0.75; OpenCV misread rounder rings.
    const radii = [...findersPath(code.size).matchAll(/a([\d.]+) /g)].map((m) => Number(m[1]));
    expect(new Set(radii)).toStrictEqual(new Set([0.1, 0.75]));
    // Data modules round by 0.4, so a lone one is no circle.
    const modules = [...modulesPath(code, null).matchAll(/a([\d.]+) /g)].map((m) => Number(m[1]));
    expect(new Set(modules)).toStrictEqual(new Set([0.4]));
  });

  it("draws the crab at 85% of its block's scale, for white round it", () => {
    const code = codeFor(ONION);
    const mark = code && markFor(code);
    if (mark?.kind !== "crab") throw new Error("no crab");
    expect(mark.scale).toBeCloseTo((5 / 26) * 0.85, 6);
  });
});

describe("damage", () => {
  it("is nothing when nothing is hidden, and past what can be read when everything is", () => {
    const code = encodeQr(TAPROOT, "Q");
    if (!code) throw new Error("no code");
    expect(damage(code, () => false)).toBe(0);
    expect(damage(code, () => true)).toBeGreaterThan(1);
  });
});

describe("the paths", () => {
  it("draw numbers and path commands only", () => {
    const code = encodeQr(ONION, "Q");
    if (!code) throw new Error("no code");
    const d = modulesPath(code, markFor(code)) + findersPath(code.size);
    expect(d).toMatch(/^[MHVZahv0-9 .-]+$/);
  });

  it("draw a lone module as a soft square and leave the logo's room empty", () => {
    const code = encodeQr(TAPROOT, "Q");
    if (!code) throw new Error("no code");
    const every = modulesPath(code, null);
    const cleared = modulesPath(code, markFor(code));
    expect(cleared.length).toBeLessThan(every.length);
    // A module with no dark neighbour has four rounded corners.
    expect(every).toContain("a0.4 0.4 0 0 1 0.4 0.4V");
  });
});

describe("inkFor", () => {
  const PAPER = "#ffffff";
  const INK = "#161b1e";

  it("keeps a colour that already contrasts", () => {
    expect(inkFor("#3a5fcd", PAPER, INK)).toStrictEqual({ colour: "#3a5fcd", from: "colour" });
  });

  it.each(["#ffffff", "#fefefe", "#ffff00", "#ffcc99", "#3399ff", "#ff0000", "#00ff00"])(
    "darkens %s just enough to reach 4.5:1",
    (pale) => {
      const ink = inkFor(pale, PAPER, INK);
      const c = parseHex(ink.colour) ?? [0, 0, 0];
      const p = parseHex(PAPER) ?? [0, 0, 0];
      expect(ink.from).toBe("darkened");
      expect(contrast(c, p)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(c, p)).toBeLessThan(MIN_CONTRAST + 0.35);
    },
  );

  it.each(["#ffcc99", "#3399ff", "#f5a3c7", "#b7e4c7"])("keeps the hue of %s", (pale) => {
    // The channels keep their order and their proportions in linear light.
    const order = ([r = 0, g = 0, b = 0]: readonly number[]) => [
      Math.sign(r - g),
      Math.sign(g - b),
      Math.sign(r - b),
    ];
    const c = parseHex(inkFor(pale, PAPER, INK).colour) ?? [0, 0, 0];
    expect(order(c)).toStrictEqual(order(parseHex(pale) ?? [0, 0, 0]));
  });

  it("falls back to the ink for no colour, or anything that is not #rrggbb", () => {
    for (const bad of [null, "", "red", "#fff", "#12345g", "#1234567", "url(x)", "#ffffff;x:y"])
      expect(inkFor(bad, PAPER, INK)).toStrictEqual({ colour: INK, from: "fallback" });
  });

  it("falls back when the paper is too dark to darken against", () => {
    expect(inkFor("#808080", "#606060", INK).from).toBe("fallback");
  });

  it("reads the paper however the build writes it", () => {
    expect(parseHex("#fff")).toStrictEqual([255, 255, 255]);
    expect(parseHex(" #FFFFFF ")).toStrictEqual([255, 255, 255]);
  });
});
